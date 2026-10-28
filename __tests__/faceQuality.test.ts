import { openDbSync } from '../src/db/client';
import { runMigrationsSync } from '../src/db/migrations';
import { createTrip } from '../src/db/repositories/trips';
import { upsertPhotos } from '../src/db/repositories/photos';
import { getFacesByTripId } from '../src/db/repositories/faces';
import type { PhotoRow } from '../src/db/types';
import { CONFIG } from '../src/domain/config';
import {
  computeLaplacianVariance,
  rgbToGrayscale,
  rgbaToGrayscale,
  isExtremePoseFromYaw,
  isExtremePoseFromLandmarks,
  evaluateFaceQuality,
} from '../src/domain/faceQuality';
import {
  scanTripFaces,
  type FaceDetectorBackend,
  type FaceEmbedderBackend,
  type FaceDetectionBox,
} from '../src/services/faceScan';

// Mock native modules for scanTripFaces integration test
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn().mockResolvedValue(undefined),
  deactivateKeepAwake: jest.fn(),
}));

jest.mock('apple-vision', () => ({
  isAppleVisionAvailable: jest.fn().mockReturnValue(false),
  detectFacesWithAppleVision: jest.fn().mockResolvedValue([]),
}));

jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn().mockResolvedValue({
    uri: 'file:///mock/crop.jpg',
    base64: 'mockBase64String',
  }),
  SaveFormat: {
    JPEG: 'jpeg',
    PNG: 'png',
  },
}));

describe('Face Quality Filter Domain Module (Task 2.4)', () => {
  describe('computeLaplacianVariance', () => {
    it('returns 0 for images smaller than 3x3 or insufficient data', () => {
      expect(computeLaplacianVariance(new Uint8Array([1, 2, 3, 4]), 2, 2)).toBe(0);
      expect(computeLaplacianVariance(new Uint8Array([]), 0, 0)).toBe(0);
      expect(computeLaplacianVariance(new Uint8Array([10]), 1, 1)).toBe(0);
    });

    it('returns 0 for completely uniform / flat image (zero texture = blurry)', () => {
      const width = 10;
      const height = 10;
      const flat = new Uint8Array(width * height).fill(128);
      const variance = computeLaplacianVariance(flat, width, height);
      expect(variance).toBe(0);
    });

    it('returns 0 for a flat ramp / linear gradient (second derivative is zero)', () => {
      const width = 10;
      const height = 10;
      const ramp = new Float32Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          ramp[y * width + x] = 2 * x + 3 * y;
        }
      }
      const variance = computeLaplacianVariance(ramp, width, height);
      expect(variance).toBeCloseTo(0, 5);
    });

    it('computes high variance for sharp high-contrast checkerboard image', () => {
      const width = 20;
      const height = 20;
      const checkerboard = new Float32Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          checkerboard[y * width + x] = (x + y) % 2 === 0 ? 0 : 255;
        }
      }
      const variance = computeLaplacianVariance(checkerboard, width, height);
      // High contrast edges should give a very high Laplacian variance (> 1000)
      expect(variance).toBeGreaterThan(1000);
      expect(variance).toBeGreaterThan(CONFIG.BLUR_MIN);
    });
  });

  describe('rgbToGrayscale & rgbaToGrayscale', () => {
    it('converts RGB channels to grayscale using ITU-R BT.601 weights', () => {
      // 1 pixel RGB: Red (255, 0, 0)
      const red = new Uint8Array([255, 0, 0]);
      const grayRed = rgbToGrayscale(red, 1, 1);
      expect(grayRed[0]).toBeCloseTo(0.299 * 255, 2);

      // Green (0, 255, 0)
      const green = new Uint8Array([0, 255, 0]);
      const grayGreen = rgbToGrayscale(green, 1, 1);
      expect(grayGreen[0]).toBeCloseTo(0.587 * 255, 2);

      // Blue (0, 0, 255)
      const blue = new Uint8Array([0, 0, 255]);
      const grayBlue = rgbToGrayscale(blue, 1, 1);
      expect(grayBlue[0]).toBeCloseTo(0.114 * 255, 2);
    });

    it('converts RGBA channels to grayscale ignoring alpha channel', () => {
      // 1 pixel RGBA: White with alpha (255, 255, 255, 128)
      const white = new Uint8Array([255, 255, 255, 128]);
      const grayWhite = rgbaToGrayscale(white, 1, 1);
      expect(grayWhite[0]).toBeCloseTo(255, 1);
    });
  });

  describe('Extreme Pose Detection', () => {
    it('detects extreme pose via yaw angle in radians', () => {
      // Frontal faces (yaw <= 0.8 rad / ~45.8 degrees)
      expect(isExtremePoseFromYaw(0)).toBe(false);
      expect(isExtremePoseFromYaw(0.4)).toBe(false);
      expect(isExtremePoseFromYaw(-0.4)).toBe(false);
      expect(isExtremePoseFromYaw(0.8)).toBe(false);
      expect(isExtremePoseFromYaw(-0.8)).toBe(false);

      // Extreme yaw poses (> 0.8 rad)
      expect(isExtremePoseFromYaw(0.81)).toBe(true);
      expect(isExtremePoseFromYaw(-0.85)).toBe(true);
      expect(isExtremePoseFromYaw(1.2)).toBe(true);
      expect(isExtremePoseFromYaw(-1.5)).toBe(true);
    });

    it('detects extreme pose via 2D landmarks (nose-to-eye asymmetry)', () => {
      // Frontal face: eyes at x=30 and x=70, nose centered at x=50
      const frontal = {
        rightEye: { x: 30, y: 50 },
        leftEye: { x: 70, y: 50 },
        noseTip: { x: 50, y: 65 },
      };
      expect(isExtremePoseFromLandmarks(frontal)).toBe(false);

      // Mild turn: nose shifted slightly (x=55, offset = 5, eyeSpan/2 = 20, ratio = 5/20 = 0.25 <= 0.65)
      const mildTurn = {
        rightEye: { x: 30, y: 50 },
        leftEye: { x: 70, y: 50 },
        noseTip: { x: 55, y: 65 },
      };
      expect(isExtremePoseFromLandmarks(mildTurn)).toBe(false);

      // Extreme profile turn: nose shifted far to the left (x=68, offset = 18, eyeSpan/2 = 20, ratio = 0.90 > 0.65)
      const profileTurn = {
        rightEye: { x: 30, y: 50 },
        leftEye: { x: 70, y: 50 },
        noseTip: { x: 68, y: 65 },
      };
      expect(isExtremePoseFromLandmarks(profileTurn)).toBe(true);
    });

    it('detects extreme pose via ear-to-eye span asymmetry (profile view)', () => {
      // Symmetrical frontal face with ears
      const symmetricFace = {
        rightEar: { x: 10, y: 50 },
        rightEye: { x: 30, y: 50 },
        noseTip: { x: 50, y: 65 },
        leftEye: { x: 70, y: 50 },
        leftEar: { x: 90, y: 50 },
      };
      expect(isExtremePoseFromLandmarks(symmetricFace)).toBe(false);

      // Strong profile view: one ear is visible/far from eye, other is compressed near eye
      // rightSpan: 30 - 10 = 20; leftSpan: 72 - 70 = 2; asymmetry = (20 - 2) / 20 = 0.90 (> 0.7)
      const profileFace = {
        rightEar: { x: 10, y: 50 },
        rightEye: { x: 30, y: 50 },
        noseTip: { x: 50, y: 65 },
        leftEye: { x: 70, y: 50 },
        leftEar: { x: 72, y: 50 },
      };
      expect(isExtremePoseFromLandmarks(profileFace)).toBe(true);
    });
  });

  describe('evaluateFaceQuality', () => {
    it('passes high-quality, sharp, frontal face', () => {
      const result = evaluateFaceQuality({
        pixelWidth: 80,
        pixelHeight: 90,
        confidence: 0.92,
        blurScore: 75.0,
        yawRadians: 0.2,
      });

      expect(result.quality_ok).toBe(1);
      expect(result.reasons).toEqual([]);
      expect(result.shortEdge).toBe(80);
      expect(result.confidence).toBe(0.92);
      expect(result.blur).toBe(75.0);
    });

    it('rejects faces smaller than MIN_FACE_SIZE (28px)', () => {
      const result = evaluateFaceQuality({
        pixelWidth: 26,
        pixelHeight: 30,
        confidence: 0.9,
        blurScore: 80,
        yawRadians: 0.0,
      });

      expect(result.quality_ok).toBe(0);
      expect(result.shortEdge).toBe(26);
      expect(result.reasons).toContain('too_small');
    });

    it('rejects faces with confidence below MIN_FACE_CONFIDENCE (0.5)', () => {
      const result = evaluateFaceQuality({
        pixelWidth: 60,
        pixelHeight: 60,
        confidence: 0.45,
        blurScore: 80,
        yawRadians: 0.0,
      });

      expect(result.quality_ok).toBe(0);
      expect(result.reasons).toContain('low_confidence');
    });

    it('rejects faces with blur below BLUR_MIN (35.0) via blurScore', () => {
      const result = evaluateFaceQuality({
        pixelWidth: 60,
        pixelHeight: 60,
        confidence: 0.85,
        blurScore: 22.5,
        yawRadians: 0.0,
      });

      expect(result.quality_ok).toBe(0);
      expect(result.blur).toBe(22.5);
      expect(result.reasons).toContain('blurry');
    });

    it('rejects faces with blur below BLUR_MIN via cropPixels dynamically', () => {
      // 10x10 uniform gray pixels -> Laplacian variance is 0 < 35.0
      const flatCrop = new Uint8Array(10 * 10).fill(120);
      const result = evaluateFaceQuality({
        pixelWidth: 50,
        pixelHeight: 50,
        confidence: 0.9,
        cropPixels: {
          data: flatCrop,
          width: 10,
          height: 10,
          format: 'grayscale',
        },
      });

      expect(result.quality_ok).toBe(0);
      expect(result.blur).toBe(0);
      expect(result.reasons).toContain('blurry');
    });

    it('accepts faces with sharp cropPixels dynamically', () => {
      const width = 16;
      const height = 16;
      const checker = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          checker[y * width + x] = (x + y) % 2 === 0 ? 0 : 255;
        }
      }

      const result = evaluateFaceQuality({
        pixelWidth: 50,
        pixelHeight: 50,
        confidence: 0.9,
        cropPixels: {
          data: checker,
          width,
          height,
          format: 'grayscale',
        },
      });

      expect(result.quality_ok).toBe(1);
      expect(result.blur).toBeGreaterThan(CONFIG.BLUR_MIN);
      expect(result.reasons).toEqual([]);
    });

    it('rejects faces with extreme yaw from yawRadians', () => {
      const result = evaluateFaceQuality({
        pixelWidth: 60,
        pixelHeight: 60,
        confidence: 0.9,
        blurScore: 50,
        yawRadians: 0.95, // > 0.8 rad
      });

      expect(result.quality_ok).toBe(0);
      expect(result.reasons).toContain('extreme_pose');
    });

    it('rejects faces with extreme pose from landmarks', () => {
      const result = evaluateFaceQuality({
        pixelWidth: 60,
        pixelHeight: 60,
        confidence: 0.9,
        blurScore: 50,
        landmarks: {
          rightEye: { x: 20, y: 50 },
          leftEye: { x: 60, y: 50 },
          noseTip: { x: 58, y: 65 }, // Asymmetry ratio = 18 / 20 = 0.90 > 0.65
        },
      });

      expect(result.quality_ok).toBe(0);
      expect(result.reasons).toContain('extreme_pose');
    });

    it('accumulates all failure reasons when multiple thresholds are violated', () => {
      const result = evaluateFaceQuality({
        pixelWidth: 20, // too_small (< 28)
        pixelHeight: 20,
        confidence: 0.35, // low_confidence (< 0.5)
        blurScore: 12.0, // blurry (< 35)
        yawRadians: 1.1, // extreme_pose (> 0.8)
      });

      expect(result.quality_ok).toBe(0);
      expect(result.reasons).toHaveLength(4);
      expect(result.reasons).toEqual(
        expect.arrayContaining(['too_small', 'low_confidence', 'blurry', 'extreme_pose'])
      );
    });

    it('respects custom threshold options', () => {
      // Standard face (width=35, conf=0.6, blur=40) would pass defaults
      // But fails with strict custom options
      const result = evaluateFaceQuality(
        {
          pixelWidth: 35,
          pixelHeight: 35,
          confidence: 0.6,
          blurScore: 40,
        },
        {
          minFaceSize: 50,
          minConfidence: 0.8,
          minBlur: 50,
        }
      );

      expect(result.quality_ok).toBe(0);
      expect(result.reasons).toEqual(
        expect.arrayContaining(['too_small', 'low_confidence', 'blurry'])
      );
    });
  });

  describe('Integration with scanTripFaces and SQLite database', () => {
    const db = openDbSync(':memory:');
    const TRIP_ID = 'trip-quality-test-1';

    beforeEach(() => {
      (db as unknown as { _clear: () => void })._clear();
      runMigrationsSync(db);
      jest.clearAllMocks();
    });

    function createMockPhoto(): PhotoRow {
      return {
        id: 'quality_photo_1',
        trip_id: TRIP_ID,
        taken_at: 1700000000000,
        modified_at: 1700000000000,
        width: 1000,
        height: 1000,
        lat: null,
        lng: null,
        is_local: 1,
        scan_status: 'pending',
        face_count: 0,
        excluded: 0,
      };
    }

    const mockEmbedder: FaceEmbedderBackend = {
      computeEmbedding: jest.fn(async (): Promise<Float32Array> => {
        const emb = new Float32Array(128);
        for (let i = 0; i < 128; i++) emb[i] = 1.0 / Math.sqrt(128);
        return emb;
      }),
    };

    it('stores low-quality faces with quality_ok = 0 and high-quality faces with quality_ok = 1', async () => {
      await createTrip({ id: TRIP_ID, name: 'Quality Test Trip', start_at: 1000, end_at: 2000 }, db);
      await upsertPhotos([createMockPhoto()], db);

      // Detector returning 3 faces:
      // 1. High quality face (80px, conf 0.95, blur 50, frontal) -> quality_ok = 1
      // 2. Blurry face (80px, conf 0.90, blur 15, frontal) -> quality_ok = 0
      // 3. Tiny face (20px, conf 0.90, blur 60, frontal) -> quality_ok = 0
      const mockDetector: FaceDetectorBackend = {
        detectFaces: jest.fn(async (): Promise<FaceDetectionBox[]> => [
          {
            x: 0.1,
            y: 0.1,
            width: 0.08, // 0.08 * 1000 = 80px
            height: 0.08,
            score: 0.95,
            blurScore: 50.0,
            yaw: 0.1,
          },
          {
            x: 0.3,
            y: 0.1,
            width: 0.08, // 80px
            height: 0.08,
            score: 0.90,
            blurScore: 15.0, // Blurry!
            yaw: 0.1,
          },
          {
            x: 0.5,
            y: 0.1,
            width: 0.02, // 0.02 * 1000 = 20px (< 28px!)
            height: 0.02,
            score: 0.90,
            blurScore: 60.0,
            yaw: 0.0,
          },
        ]),
      };

      const result = await scanTripFaces(TRIP_ID, {
        db,
        detector: mockDetector,
        embedder: mockEmbedder,
        photoUriResolver: async (id) => `file:///mock/${id}.jpg`,
      });

      expect(result.status).toBe('completed');
      expect(result.facesFound).toBe(3);

      // Verify all 3 faces are saved in database
      const allFaces = await getFacesByTripId(TRIP_ID, { qualityOnly: false }, db);
      expect(allFaces).toHaveLength(3);

      // Verify quality_ok flags in database
      const highQualityFaces = allFaces.filter((f) => f.quality_ok === 1);
      const lowQualityFaces = allFaces.filter((f) => f.quality_ok === 0);

      expect(highQualityFaces).toHaveLength(1);
      expect(highQualityFaces[0].blur).toBe(50.0);

      expect(lowQualityFaces).toHaveLength(2);
      expect(lowQualityFaces.find((f) => f.blur === 15.0)).toBeDefined();

      // Verify qualityOnly filter in repository only returns quality_ok = 1
      const qualityOnlyQuery = await getFacesByTripId(TRIP_ID, { qualityOnly: true }, db);
      expect(qualityOnlyQuery).toHaveLength(1);
      expect(qualityOnlyQuery[0].id).toBe(highQualityFaces[0].id);
    });
  });
});
