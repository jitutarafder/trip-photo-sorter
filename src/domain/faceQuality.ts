// Pure TypeScript Face Quality Filter (TRD §4, Plan Task 2.4)
// No imports from React, React Native, or Expo

import { CONFIG } from './config';

export type FaceQualityFailureReason =
  | 'too_small'
  | 'low_confidence'
  | 'blurry'
  | 'extreme_pose';

export interface FaceLandmarksInput {
  rightEye?: { x: number; y: number };
  leftEye?: { x: number; y: number };
  noseTip?: { x: number; y: number };
  rightEar?: { x: number; y: number };
  leftEar?: { x: number; y: number };
}

export interface PixelBufferInput {
  data: Uint8Array | Float32Array | number[];
  width: number;
  height: number;
  format?: 'grayscale' | 'rgb' | 'rgba';
}

export interface FaceQualityInput {
  /** Width of the face bounding box in pixels on original photo */
  pixelWidth: number;
  /** Height of the face bounding box in pixels on original photo */
  pixelHeight: number;
  /** Detector confidence score (0 to 1) */
  confidence: number;
  /** Pre-calculated blur score (Laplacian variance), if available */
  blurScore?: number | null;
  /** Raw crop pixels to compute blur dynamically, if blurScore is omitted */
  cropPixels?: PixelBufferInput;
  /** Yaw angle in radians from detector (e.g. Apple Vision), where 0 is frontal */
  yawRadians?: number | null;
  /** 2D facial landmarks (e.g. from BlazeFace), used for pose analysis if yawRadians is absent */
  landmarks?: FaceLandmarksInput | null;
}

export interface FaceQualityOptions {
  minFaceSize?: number;
  minConfidence?: number;
  minBlur?: number;
  maxYawRad?: number;
  maxLandmarkYawRatio?: number;
}

export interface FaceQualityResult {
  /** 1 if face passes all quality thresholds, 0 if rejected */
  quality_ok: number;
  /** Laplacian variance of grey crop (higher = sharper, lower = blurrier) */
  blur: number | null;
  /** Short edge of face bounding box in pixels */
  shortEdge: number;
  /** Detector confidence */
  confidence: number;
  /** List of reasons why the face failed quality check (empty if quality_ok === 1) */
  reasons: FaceQualityFailureReason[];
}

/**
 * Converts RGB pixel values (interleaved [R, G, B, R, G, B...]) to grayscale
 * using ITU-R BT.601 luma weights (0.299 R + 0.587 G + 0.114 B).
 */
export function rgbToGrayscale(
  rgb: Uint8Array | Float32Array | number[],
  width: number,
  height: number
): Float32Array {
  const pixelCount = width * height;
  const gray = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const srcIdx = i * 3;
    gray[i] =
      0.299 * rgb[srcIdx + 0] +
      0.587 * rgb[srcIdx + 1] +
      0.114 * rgb[srcIdx + 2];
  }
  return gray;
}

/**
 * Converts RGBA pixel values (interleaved [R, G, B, A, R, G, B, A...]) to grayscale.
 */
export function rgbaToGrayscale(
  rgba: Uint8Array | Float32Array | number[],
  width: number,
  height: number
): Float32Array {
  const pixelCount = width * height;
  const gray = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const srcIdx = i * 4;
    gray[i] =
      0.299 * rgba[srcIdx + 0] +
      0.587 * rgba[srcIdx + 1] +
      0.114 * rgba[srcIdx + 2];
  }
  return gray;
}

/**
 * Computes the variance of the discrete Laplacian of a 2D grayscale image.
 *
 * Standard measure of image focus/sharpness (Bansal / Pech-Pacheco).
 * High variance (> 35–50) indicates sharp edges and texture.
 * Low variance (< 35) indicates smooth, out-of-focus, or motion-blurred imagery.
 *
 * Uses the standard 4-neighbor Laplacian discrete kernel:
 * [  0  1  0 ]
 * [  1 -4  1 ]
 * [  0  1  0 ]
 */
export function computeLaplacianVariance(
  pixels: Uint8Array | Float32Array | number[],
  width: number,
  height: number
): number {
  if (width < 3 || height < 3 || pixels.length < width * height) {
    return 0;
  }

  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    const rowOffset = y * width;
    const prevRowOffset = (y - 1) * width;
    const nextRowOffset = (y + 1) * width;

    for (let x = 1; x < width - 1; x++) {
      const center = pixels[rowOffset + x];
      const left = pixels[rowOffset + x - 1];
      const right = pixels[rowOffset + x + 1];
      const top = pixels[prevRowOffset + x];
      const bottom = pixels[nextRowOffset + x];

      const lap = left + right + top + bottom - 4 * center;
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  return Math.max(0, variance);
}

/**
 * Determines whether a face is in an extreme yaw pose from yaw angle (in radians).
 */
export function isExtremePoseFromYaw(
  yawRadians: number,
  maxYawRad: number = CONFIG.YAW_MAX_RAD
): boolean {
  return Math.abs(yawRadians) > maxYawRad;
}

/**
 * Estimates whether a face has an extreme yaw/profile pose using 2D landmarks.
 * Analyzes the horizontal position of the nose relative to the eyes and ears.
 */
export function isExtremePoseFromLandmarks(
  landmarks: FaceLandmarksInput,
  maxRatio: number = CONFIG.LANDMARK_YAW_MAX_RATIO
): boolean {
  const { rightEye, leftEye, noseTip, rightEar, leftEar } = landmarks;

  // 1. Nose position relative to eye midpoint
  if (rightEye && leftEye && noseTip) {
    const eyeDist = Math.abs(leftEye.x - rightEye.x);
    if (eyeDist > 1e-4) {
      const midEyeX = (rightEye.x + leftEye.x) / 2;
      const noseOffset = Math.abs(noseTip.x - midEyeX);
      const ratio = noseOffset / (eyeDist / 2);
      if (ratio > maxRatio) {
        return true;
      }
    }
  }

  // 2. Ear-to-eye asymmetry (profile view check)
  if (rightEye && leftEye && rightEar && leftEar) {
    const rightSpan = Math.abs(rightEye.x - rightEar.x);
    const leftSpan = Math.abs(leftEar.x - leftEye.x);
    const maxSpan = Math.max(rightSpan, leftSpan);
    if (maxSpan > 1e-4) {
      const asymmetry = Math.abs(rightSpan - leftSpan) / maxSpan;
      // High asymmetry (> 0.7) means one side of the face is turned away
      if (asymmetry > 0.7) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Evaluates whether a detected face passes quality criteria for centroid calculation
 * and initial clustering (TRD §4).
 *
 * Rules:
 * 1. Short edge >= MIN_FACE_SIZE (28 px).
 * 2. Detector confidence >= MIN_FACE_CONFIDENCE (0.5).
 * 3. Blur score (Laplacian variance) >= BLUR_MIN (35.0).
 * 4. Yaw pose is not extreme (<= YAW_MAX_RAD or landmark ratio <= LANDMARK_YAW_MAX_RATIO).
 *
 * Low-quality faces receive `quality_ok = 0`. They remain in the database and can still
 * be assigned to a person by nearest centroid, but are excluded from creating or moving centroids.
 */
export function evaluateFaceQuality(
  input: FaceQualityInput,
  options: FaceQualityOptions = {}
): FaceQualityResult {
  const minFaceSize = options.minFaceSize ?? CONFIG.MIN_FACE_SIZE;
  const minConfidence = options.minConfidence ?? CONFIG.MIN_FACE_CONFIDENCE;
  const minBlur = options.minBlur ?? CONFIG.BLUR_MIN;
  const maxYawRad = options.maxYawRad ?? CONFIG.YAW_MAX_RAD;
  const maxLandmarkRatio = options.maxLandmarkYawRatio ?? CONFIG.LANDMARK_YAW_MAX_RATIO;

  const reasons: FaceQualityFailureReason[] = [];
  const shortEdge = Math.min(input.pixelWidth, input.pixelHeight);

  // 1. Min Face Size check
  if (shortEdge < minFaceSize) {
    reasons.push('too_small');
  }

  // 2. Detector confidence check
  if (input.confidence < minConfidence) {
    reasons.push('low_confidence');
  }

  // 3. Blur evaluation (Laplacian variance)
  let blur: number | null = null;
  if (input.blurScore !== undefined && input.blurScore !== null) {
    blur = input.blurScore;
  } else if (input.cropPixels) {
    const { data, width, height, format = 'grayscale' } = input.cropPixels;
    let grayData: Uint8Array | Float32Array | number[];

    if (format === 'rgb') {
      grayData = rgbToGrayscale(data, width, height);
    } else if (format === 'rgba') {
      grayData = rgbaToGrayscale(data, width, height);
    } else {
      grayData = data;
    }

    blur = computeLaplacianVariance(grayData, width, height);
  }

  if (blur !== null && blur < minBlur) {
    reasons.push('blurry');
  }

  // 4. Extreme pose check (yaw angle or landmarks)
  if (input.yawRadians !== undefined && input.yawRadians !== null) {
    if (isExtremePoseFromYaw(input.yawRadians, maxYawRad)) {
      reasons.push('extreme_pose');
    }
  } else if (input.landmarks) {
    if (isExtremePoseFromLandmarks(input.landmarks, maxLandmarkRatio)) {
      reasons.push('extreme_pose');
    }
  }

  return {
    quality_ok: reasons.length === 0 ? 1 : 0,
    blur,
    shortEdge,
    confidence: input.confidence,
    reasons,
  };
}
