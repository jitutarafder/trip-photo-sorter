import { useState, useCallback, useRef, useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as MediaLibrary from 'expo-media-library';
import * as ImageManipulator from 'expo-image-manipulator';
import { detectFacesWithAppleVision, isAppleVisionAvailable } from 'apple-vision';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../db/client';
import type { FaceRow, PhotoRow } from '../db/types';
import { getTripById, updateTrip, reconcileInterruptedTripScans } from '../db/repositories/trips';
import { getPendingPhotosByTripId, updatePhoto, markPhotoScanFailedAtomic } from '../db/repositories/photos';
import {
  deleteOrphanFacesForPendingTripPhotos,
  savePhotoFacesAtomic,
} from '../db/repositories/faces';
import { calculateCropRect } from '../domain/faceCrop';
import { l2Normalize } from '../domain/clustering';
import { CONFIG } from '../domain/config';
import { base64ToRgbTensor } from '../utils/imagePixels';
import { generateUUID } from '../utils/uuid';
import {
  decodeDetections,
  nonMaxSuppression,
  calculateLetterbox,
  unletterboxDetection,
  filterMinFaceSize,
} from '../domain/blazeface';
import {
  evaluateFaceQuality,
  type FaceLandmarksInput,
  type FaceQualityOptions,
} from '../domain/faceQuality';
import { clusterAndPersistTripFaces } from './clustering';
import { getTripFreeTierStatus } from './purchases';
import { getLibraryPermissionStatus } from './library';

export interface FaceDetectionBox {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  yaw?: number;
  roll?: number;
  landmarks?: FaceLandmarksInput;
  blurScore?: number;
}

export interface ModelRunner {
  run: (buffers: ArrayBuffer[]) => Promise<ArrayBuffer[]>;
}

export interface FaceDetectorBackend {
  detectFaces: (photoUri: string, width: number, height: number) => Promise<FaceDetectionBox[]>;
}

export interface FaceEmbedderBackend {
  computeEmbedding: (cropUri: string, base64Crop?: string) => Promise<Float32Array>;
}

export interface ScanTripProgress {
  current: number;
  total: number;
  facesFound: number;
  skippedCount?: number;
  currentPhotoId?: string;
}

export interface ScanTripFacesOptions {
  db?: SQLiteDatabase;
  concurrency?: number;
  pauseOnBackground?: boolean;
  keepAwake?: boolean;
  detector?: FaceDetectorBackend;
  embedder?: FaceEmbedderBackend;
  blazefaceModel?: ModelRunner;
  mobilefacenetModel?: ModelRunner;
  photoUriResolver?: (photoId: string) => Promise<string | null>;
  controller?: ScanController;
  qualityOptions?: FaceQualityOptions;
  autoCluster?: boolean;
  enableProGate?: boolean;
  onProgress?: (progress: ScanTripProgress) => void;
}

export interface ScanTripFacesResult {
  status: 'completed' | 'paused' | 'cancelled' | 'failed';
  scannedCount: number;
  facesFound: number;
  skippedCount: number;
  failedCount: number;
  totalPhotos: number;
  paywallRequired?: boolean;
  error?: Error;
}

/**
 * Checks if an error thrown during scanning is caused by photo library permission revocation.
 */
export function isPermissionRevokedError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('permission') ||
    msg.includes('access denied') ||
    msg.includes('unauthorized') ||
    msg.includes('not granted') ||
    msg.includes('restricted') ||
    msg.includes('denied')
  );
}

/**
 * Controller to signal cancellation or pausing during a face scan.
 */
export class ScanController {
  private _isCancelled = false;
  private _isPaused = false;
  private _listeners: (() => void)[] = [];

  cancel(): void {
    this._isCancelled = true;
    this._notify();
  }

  pause(): void {
    this._isPaused = true;
    this._notify();
  }

  get isCancelled(): boolean {
    return this._isCancelled;
  }

  get isPaused(): boolean {
    return this._isPaused;
  }

  get shouldStop(): boolean {
    return this._isCancelled || this._isPaused;
  }

  onStop(listener: () => void): () => void {
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== listener);
    };
  }

  private _notify(): void {
    this._listeners.forEach((l) => {
      try {
        l();
      } catch {
        // Ignore listener error
      }
    });
  }
}

/**
 * Default photo URI resolver using Expo MediaLibrary.
 */
export async function defaultPhotoUriResolver(photoId: string): Promise<string | null> {
  try {
    const asset = await MediaLibrary.getAssetInfoAsync(photoId);
    return asset?.localUri || asset?.uri || null;
  } catch (err) {
    if (isPermissionRevokedError(err)) {
      throw err;
    }
    return null;
  }
}

/**
 * Default face detection logic:
 * Uses Apple Vision (VNDetectFaceRectanglesRequest) on iOS, or BlazeFace TFLite fallback.
 */
export async function defaultDetectFaces(
  photoUri: string,
  width: number,
  height: number,
  blazefaceModel?: ModelRunner
): Promise<FaceDetectionBox[]> {
  // 1. Primary on iOS: Apple Vision (hardware-accelerated on Apple Neural Engine)
  if (isAppleVisionAvailable()) {
    try {
      const visionFaces = await detectFacesWithAppleVision(photoUri);
      if (visionFaces && visionFaces.length > 0) {
        // Filter false positives (pixel width >= 30, confidence >= 0.55 per TRD §4 / spike)
        const validVisionFaces = visionFaces.filter(
          (vf) =>
            vf.confidence >= 0.55 &&
            vf.pixelWidth >= 30 &&
            (vf.captureQuality === undefined || vf.captureQuality >= 0.15)
        );

        return validVisionFaces.map((vf) => ({
          x: vf.x,
          y: vf.y,
          width: vf.width,
          height: vf.height,
          score: vf.confidence,
          yaw: vf.yaw,
          roll: vf.roll,
        }));
      }
      return [];
    } catch (e) {
      console.warn('[AppleVision] Error detecting faces:', e);
    }
  }

  // 2. Fallback: BlazeFace short-range TFLite
  if (!blazefaceModel) {
    return [];
  }

  const letterbox = calculateLetterbox(width, height, CONFIG.BLAZEFACE_INPUT_SIZE);
  const manipulated = await ImageManipulator.manipulateAsync(
    photoUri,
    [
      {
        resize: {
          width: Math.round(letterbox.scaledWidth),
          height: Math.round(letterbox.scaledHeight),
        },
      },
    ],
    { format: ImageManipulator.SaveFormat.JPEG, base64: true }
  );

  if (!manipulated.base64) {
    return [];
  }

  const sW = Math.round(letterbox.scaledWidth);
  const sH = Math.round(letterbox.scaledHeight);
  const rawPixels = base64ToRgbTensor(manipulated.base64, sW, sH, 127.5, 127.5);
  if (!rawPixels) {
    return [];
  }

  const bfInput = new Float32Array(1 * 128 * 128 * 3);
  const padX = Math.round(letterbox.padX);
  const padY = Math.round(letterbox.padY);
  for (let y = 0; y < sH; y++) {
    for (let x = 0; x < sW; x++) {
      const dstY = y + padY;
      const dstX = x + padX;
      if (dstY >= 0 && dstY < 128 && dstX >= 0 && dstX < 128) {
        const srcIdx = (y * sW + x) * 3;
        const dstIdx = (dstY * 128 + dstX) * 3;
        bfInput[dstIdx + 0] = rawPixels[srcIdx + 0];
        bfInput[dstIdx + 1] = rawPixels[srcIdx + 1];
        bfInput[dstIdx + 2] = rawPixels[srcIdx + 2];
      }
    }
  }

  const bfOutput = await blazefaceModel.run([bfInput.buffer as ArrayBuffer]);
  const out0 = new Float32Array(bfOutput[0]);
  const out1 = new Float32Array(bfOutput[1]);
  const rawBoxes = out0.length > out1.length ? out0 : out1;
  const rawScores = out0.length > out1.length ? out1 : out0;

  const rawDetections = decodeDetections(
    rawBoxes,
    rawScores,
    undefined,
    CONFIG.BLAZEFACE_SCORE_THRESHOLD
  );
  const nmsDetections = nonMaxSuppression(rawDetections, CONFIG.BLAZEFACE_IOU_THRESHOLD);
  const mappedDetections = nmsDetections.map((d) =>
    unletterboxDetection(d, letterbox, width, height)
  );
  const validDetections = filterMinFaceSize(
    mappedDetections,
    width,
    height,
    CONFIG.MIN_FACE_SIZE
  );

  return validDetections.map((d) => ({
    x: d.x,
    y: d.y,
    width: d.width,
    height: d.height,
    score: d.score,
    landmarks: {
      rightEye: d.keypoints[0],
      leftEye: d.keypoints[1],
      noseTip: d.keypoints[2],
      rightEar: d.keypoints[4],
      leftEar: d.keypoints[5],
    },
  }));
}

/**
 * Default face embedding logic:
 * Runs MobileFaceNet 112x112 model and returns 128-d L2-normalized vector.
 */
export async function defaultComputeEmbedding(
  cropUri: string,
  base64Crop: string | undefined,
  mobilefacenetModel?: ModelRunner
): Promise<Float32Array> {
  if (!mobilefacenetModel) {
    throw new Error('MobileFaceNet model is required to compute face embeddings');
  }

  let base64 = base64Crop;
  if (!base64) {
    const manip = await ImageManipulator.manipulateAsync(
      cropUri,
      [
        {
          resize: {
            width: CONFIG.MOBILEFACENET_INPUT_SIZE,
            height: CONFIG.MOBILEFACENET_INPUT_SIZE,
          },
        },
      ],
      { format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );
    base64 = manip.base64;
  }

  if (!base64) {
    throw new Error('Failed to obtain base64 pixel data for face crop');
  }

  const mfnInput = base64ToRgbTensor(
    base64,
    CONFIG.MOBILEFACENET_INPUT_SIZE,
    CONFIG.MOBILEFACENET_INPUT_SIZE,
    127.5,
    128.0
  );

  if (!mfnInput) {
    throw new Error('Failed to construct RGB tensor from face crop');
  }

  const mfnOutput = await mobilefacenetModel.run([mfnInput.buffer as ArrayBuffer]);
  const rawEmbedding = new Float32Array(mfnOutput[0]);
  return l2Normalize(rawEmbedding);
}

/**
 * Scans photos belonging to a trip for faces.
 *
 * Requirements (TRD §4, AppFlow §2, Plan 2.3):
 * - Sequential scan with concurrency 2.
 * - Resumes on re-entry by querying photos where `photos.scan_status != 'done'`.
 * - Graceful cancellation and pause on background with `trips.scan_status = 'paused'`.
 * - Memory-safe: releases buffers and does not hold full-res images in memory.
 * - Inserts detected faces into `faces` table and updates `photos` & `trips`.
 */
export async function scanTripFaces(
  tripId: string,
  options: ScanTripFacesOptions = {}
): Promise<ScanTripFacesResult> {
  const database = options.db ?? (await getDatabase());
  const concurrency = options.concurrency ?? 2;
  const pauseOnBackground = options.pauseOnBackground ?? true;
  const keepAwake = options.keepAwake ?? true;
  const controller = options.controller ?? new ScanController();
  const uriResolver = options.photoUriResolver ?? defaultPhotoUriResolver;

  // 1. Verify trip exists
  const trip = await getTripById(tripId, database);
  if (!trip) {
    throw new Error(`Trip with ID "${tripId}" not found`);
  }

  // 2. Clean up any dangling faces from pending photos (leftover from an interrupted/killed scan)
  await deleteOrphanFacesForPendingTripPhotos(tripId, database);

  // Fetch pending photos for this trip (resume rule: scan only scan_status != 'done')
  const pendingPhotos: PhotoRow[] = await getPendingPhotosByTripId(tripId, undefined, database);
  const totalPhotos = pendingPhotos.length;

  if (totalPhotos === 0) {
    // If all photos were already done, cluster if autoCluster is enabled, or mark trip as scanned
    if (options.autoCluster) {
      await clusterAndPersistTripFaces(tripId, undefined, database);
    } else {
      await updateTrip(tripId, { scan_status: 'scanned' }, database);
    }
    return {
      status: 'completed',
      scannedCount: 0,
      facesFound: 0,
      skippedCount: 0,
      failedCount: 0,
      totalPhotos: 0,
      paywallRequired: false,
    };
  }

  // Verify photo library permission before processing if using default resolver
  if (!options.photoUriResolver) {
    try {
      const perm = await getLibraryPermissionStatus();
      if (!perm.granted) {
        await updateTrip(tripId, { scan_status: 'paused' }, database);
        return {
          status: 'paused',
          scannedCount: 0,
          facesFound: 0,
          skippedCount: 0,
          failedCount: 0,
          totalPhotos,
          error: new Error('Photo library permission not granted'),
        };
      }
    } catch {
      // If permission query throws or is unmocked in tests, proceed
    }
  }

  // Check free-tier gate before scanning (PRD US-11, Plan 2.9)
  const freeTierStatus = await getTripFreeTierStatus(tripId, database, options.enableProGate);
  if (freeTierStatus.requiresPaywall) {
    await updateTrip(tripId, { scan_status: 'paused' }, database);
    return {
      status: 'paused',
      scannedCount: 0,
      facesFound: 0,
      skippedCount: 0,
      failedCount: 0,
      totalPhotos,
      paywallRequired: true,
    };
  }

  // 3. Update trip scan_status to 'scanning'
  await updateTrip(tripId, { scan_status: 'scanning' }, database);

  // 4. Activate keep-awake while scanning is active
  if (keepAwake) {
    try {
      await activateKeepAwakeAsync();
    } catch {
      // Ignore if unsupported in environment
    }
  }

  // 5. Subscribe to AppState background events to auto-pause
  let appStateSubscription: { remove: () => void } | null = null;
  if (pauseOnBackground) {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        controller.pause();
      }
    };
    appStateSubscription = AppState.addEventListener('change', handleAppStateChange);
  }

  let scannedCount = 0;
  let facesFound = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let paywallHit = false;
  let permissionRevoked = false;
  let permissionRevokedError: Error | undefined = undefined;

  try {
    let nextIndex = 0;

    // Worker function: continuously consumes next available pending photo
    const worker = async () => {
      while (nextIndex < pendingPhotos.length && !controller.shouldStop) {
        if (!freeTierStatus.isPro) {
          const currentTrip = await getTripById(tripId, database);
          if ((currentTrip?.scanned_count ?? 0) >= CONFIG.FREE_SCAN_LIMIT_PER_TRIP) {
            paywallHit = true;
            controller.pause();
            break;
          }
        }

        const currentIndex = nextIndex++;
        if (currentIndex >= pendingPhotos.length) {
          break;
        }
        const photo = pendingPhotos[currentIndex];

        options.onProgress?.({
          current: scannedCount,
          total: totalPhotos,
          facesFound,
          skippedCount,
          currentPhotoId: photo.id,
        });

        try {
          // Resolve local photo URI
          const photoUri = await uriResolver(photo.id);

          // Handle iCloud-only asset (not local on device)
          if (!photoUri) {
            await updatePhoto(
              photo.id,
              { is_local: 0, scan_status: 'skipped' },
              database
            );
            skippedCount++;
            options.onProgress?.({
              current: scannedCount,
              total: totalPhotos,
              facesFound,
              skippedCount,
              currentPhotoId: photo.id,
            });
            continue;
          }

          // Step 1: Detect faces on photo
          let detections: FaceDetectionBox[] = [];
          if (options.detector) {
            detections = await options.detector.detectFaces(photoUri, photo.width, photo.height);
          } else {
            detections = await defaultDetectFaces(
              photoUri,
              photo.width,
              photo.height,
              options.blazefaceModel
            );
          }

          const photoFaces: FaceRow[] = [];

          // Step 2: Extract face crops and MobileFaceNet embeddings
          for (let f = 0; f < detections.length; f++) {
            if (controller.shouldStop) break;

            const det = detections[f];
            const cropRect = calculateCropRect(
              { x: det.x, y: det.y, width: det.width, height: det.height },
              photo.width,
              photo.height,
              CONFIG.CROP_MARGIN
            );

            // Crop face with margin and resize to 112x112
            const cropResult = await ImageManipulator.manipulateAsync(
              photoUri,
              [
                { crop: cropRect },
                {
                  resize: {
                    width: CONFIG.MOBILEFACENET_INPUT_SIZE,
                    height: CONFIG.MOBILEFACENET_INPUT_SIZE,
                  },
                },
              ],
              { format: ImageManipulator.SaveFormat.JPEG, base64: true }
            );

            let floatEmbedding: Float32Array;
            if (options.embedder) {
              floatEmbedding = await options.embedder.computeEmbedding(
                cropResult.uri,
                cropResult.base64
              );
            } else {
              floatEmbedding = await defaultComputeEmbedding(
                cropResult.uri,
                cropResult.base64,
                options.mobilefacenetModel
              );
            }

            // Convert Float32Array (128 elements = 512 bytes) to Uint8Array for SQLite BLOB
            const uint8Embedding = new Uint8Array(
              floatEmbedding.buffer,
              floatEmbedding.byteOffset,
              floatEmbedding.byteLength
            );

            // Evaluate quality filter (min size, confidence, blur, extreme pose)
            const pixelWidth = det.width * photo.width;
            const pixelHeight = det.height * photo.height;
            const qualityRes = evaluateFaceQuality(
              {
                pixelWidth,
                pixelHeight,
                confidence: det.score,
                blurScore: det.blurScore,
                yawRadians: det.yaw,
                landmarks: det.landmarks,
              },
              options.qualityOptions
            );

            const faceRow: FaceRow = {
              id: generateUUID(),
              photo_id: photo.id,
              person_id: null,
              assignment: 'auto',
              bbox_x: det.x,
              bbox_y: det.y,
              bbox_w: det.width,
              bbox_h: det.height,
              quality: det.score,
              quality_ok: qualityRes.quality_ok,
              blur: qualityRes.blur,
              embedding: uint8Embedding,
            };

            photoFaces.push(faceRow);
          }

          if (controller.shouldStop) {
            break;
          }

          // Step 3: Atomic commit of faces and photo status (prevents duplicate faces on kill/resume)
          await savePhotoFacesAtomic(photo.id, tripId, photoFaces, database);

          scannedCount++;
          facesFound += photoFaces.length;
        } catch (photoErr) {
          if (isPermissionRevokedError(photoErr)) {
            console.warn(`[faceScan] Photo library permission revoked while processing photo ${photo.id}:`, photoErr);
            permissionRevoked = true;
            permissionRevokedError = photoErr instanceof Error ? photoErr : new Error(String(photoErr));
            controller.pause();
            break;
          }
          // Error on single photo: mark scan_status='failed', continue next photo
          console.warn(`[faceScan] Error processing photo ${photo.id}:`, photoErr);
          await markPhotoScanFailedAtomic(photo.id, database);
          failedCount++;
        }
      }
    };

    // Run with requested concurrency (default 2)
    const workerPromises = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workerPromises);

    // Determine final status
    let finalStatus: ScanTripFacesResult['status'] = 'completed';
    if (permissionRevoked) {
      finalStatus = 'paused';
      await updateTrip(tripId, { scan_status: 'paused' }, database);
    } else if (paywallHit) {
      finalStatus = 'paused';
      await updateTrip(tripId, { scan_status: 'paused' }, database);
    } else if (controller.isCancelled) {
      finalStatus = 'cancelled';
      await updateTrip(tripId, { scan_status: 'paused' }, database);
    } else if (controller.isPaused) {
      finalStatus = 'paused';
      await updateTrip(tripId, { scan_status: 'paused' }, database);
    } else {
      // Completed all pending photos
      if (options.autoCluster) {
        await clusterAndPersistTripFaces(tripId, undefined, database);
      } else {
        await updateTrip(tripId, { scan_status: 'scanned' }, database);
      }
    }

    options.onProgress?.({
      current: scannedCount,
      total: totalPhotos,
      facesFound,
      skippedCount,
    });

    return {
      status: finalStatus,
      scannedCount,
      facesFound,
      skippedCount,
      failedCount,
      totalPhotos,
      paywallRequired: paywallHit,
      error: permissionRevokedError,
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await updateTrip(tripId, { scan_status: 'failed' }, database);
    return {
      status: 'failed',
      scannedCount,
      facesFound,
      skippedCount,
      failedCount,
      totalPhotos,
      error,
    };
  } finally {
    // Cleanup AppState listener and keep-awake
    appStateSubscription?.remove();
    if (keepAwake) {
      try {
        deactivateKeepAwake();
      } catch {
        // Ignore
      }
    }
  }
}

export interface UseFaceScanResult {
  isScanning: boolean;
  isPaused: boolean;
  progress: ScanTripProgress;
  lastResult: ScanTripFacesResult | null;
  error: Error | null;
  startScan: (opts?: Partial<ScanTripFacesOptions>) => Promise<ScanTripFacesResult>;
  pauseScan: () => void;
  resumeScan: (opts?: Partial<ScanTripFacesOptions>) => Promise<ScanTripFacesResult>;
  cancelScan: () => void;
}

/**
 * Hook to manage face scanning for a trip with progress, pause, resume, and cancel.
 */
export function useFaceScan(
  tripId: string,
  baseOptions: ScanTripFacesOptions = {}
): UseFaceScanResult {
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [progress, setProgress] = useState<ScanTripProgress>({
    current: 0,
    total: 0,
    facesFound: 0,
    skippedCount: 0,
  });
  const [lastResult, setLastResult] = useState<ScanTripFacesResult | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const controllerRef = useRef<ScanController | null>(null);

  const startScan = useCallback(
    async (overrideOpts?: Partial<ScanTripFacesOptions>) => {
      setIsScanning(true);
      setIsPaused(false);
      setError(null);

      const controller = new ScanController();
      controllerRef.current = controller;

      try {
        const mergedOpts: ScanTripFacesOptions = {
          ...baseOptions,
          ...overrideOpts,
          controller,
          onProgress: (p) => {
            setProgress(p);
            baseOptions.onProgress?.(p);
            overrideOpts?.onProgress?.(p);
          },
        };

        const result = await scanTripFaces(tripId, mergedOpts);
        setLastResult(result);
        if (result.status === 'paused') {
          setIsPaused(true);
        }
        if (result.error) {
          setError(result.error);
        }
        return result;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      } finally {
        setIsScanning(false);
      }
    },
    [tripId, baseOptions]
  );

  const pauseScan = useCallback(() => {
    controllerRef.current?.pause();
    setIsPaused(true);
  }, []);

  const cancelScan = useCallback(() => {
    controllerRef.current?.cancel();
    setIsScanning(false);
    setIsPaused(false);
  }, []);

  const resumeScan = useCallback(
    async (overrideOpts?: Partial<ScanTripFacesOptions>) => {
      return startScan(overrideOpts);
    },
    [startScan]
  );

  useEffect(() => {
    return () => {
      controllerRef.current?.cancel();
    };
  }, []);

  return {
    isScanning,
    isPaused,
    progress,
    lastResult,
    error,
    startScan,
    pauseScan,
    resumeScan,
    cancelScan,
  };
}

export { reconcileInterruptedTripScans };
