import {
  generateAnchors,
  decodeDetections,
  computeIoU,
  nonMaxSuppression,
  calculateLetterbox,
  unletterboxDetection,
  filterMinFaceSize,
  sigmoid,
  FaceDetection,
} from '../src/domain/blazeface';

describe('BlazeFace Anchor Generation (MediaPipe specification)', () => {
  it('generates exactly 896 anchors', () => {
    const anchors = generateAnchors();
    expect(anchors).toHaveLength(896);
  });

  it('keeps all anchor centers and dimensions within [0, 1]', () => {
    const anchors = generateAnchors();
    for (const anchor of anchors) {
      expect(anchor.xCenter).toBeGreaterThan(0);
      expect(anchor.xCenter).toBeLessThan(1);
      expect(anchor.yCenter).toBeGreaterThan(0);
      expect(anchor.yCenter).toBeLessThan(1);
      expect(anchor.width).toBeGreaterThan(0);
      expect(anchor.width).toBeLessThanOrEqual(1);
      expect(anchor.height).toBeGreaterThan(0);
      expect(anchor.height).toBeLessThanOrEqual(1);
    }
  });

  it('generates 512 anchors for 16x16 feature map and 384 anchors for 8x8 feature maps', () => {
    const anchors = generateAnchors();
    // Layer 0 is 16x16 with 2 anchors per cell = 512
    // Layers 1, 2, 3 are 8x8 with 2 anchors per cell = 128 each * 3 = 384
    expect(anchors.length).toBe(512 + 384);
  });
});

describe('Sigmoid Function', () => {
  it('computes standard sigmoid values', () => {
    expect(sigmoid(0)).toBeCloseTo(0.5, 5);
    expect(sigmoid(10)).toBeCloseTo(1, 4);
    expect(sigmoid(-10)).toBeCloseTo(0, 4);
  });
});

describe('Decode Detections', () => {
  it('filters out anchors with scores below scoreThreshold', () => {
    const rawScores = new Float32Array(896).fill(-10); // sigmoid(-10) ~ 0
    const rawBoxes = new Float32Array(896 * 16).fill(0);

    const detections = decodeDetections(rawBoxes, rawScores, undefined, 0.6);
    expect(detections).toHaveLength(0);
  });

  it('decodes detection box and keypoints for confident detection', () => {
    const rawScores = new Float32Array(896).fill(-10);
    const rawBoxes = new Float32Array(896 * 16).fill(0);

    // Anchor 0 with high confidence logit 5 (~0.993 score)
    rawScores[0] = 5.0;
    // Box regression offsets
    rawBoxes[0] = 0; // dx
    rawBoxes[1] = 0; // dy
    rawBoxes[2] = 128; // dw (matches anchor width)
    rawBoxes[3] = 128; // dh (matches anchor height)

    const detections = decodeDetections(rawBoxes, rawScores, undefined, 0.6);
    expect(detections).toHaveLength(1);

    const det = detections[0];
    expect(det.score).toBeGreaterThan(0.99);
    expect(det.width).toBeGreaterThan(0);
    expect(det.height).toBeGreaterThan(0);
    expect(det.keypoints).toHaveLength(6);
  });
});

describe('IoU and Non-Maximum Suppression', () => {
  it('calculates IoU correctly for identical, overlapping, and disjoint boxes', () => {
    const boxA = { x: 0, y: 0, width: 10, height: 10 };
    const boxB = { x: 0, y: 0, width: 10, height: 10 };
    expect(computeIoU(boxA, boxB)).toBeCloseTo(1.0, 5);

    const boxC = { x: 5, y: 0, width: 10, height: 10 };
    // Intersection: 5 x 10 = 50. Union: 100 + 100 - 50 = 150. IoU = 50/150 = 1/3
    expect(computeIoU(boxA, boxC)).toBeCloseTo(1 / 3, 5);

    const boxD = { x: 20, y: 20, width: 10, height: 10 };
    expect(computeIoU(boxA, boxD)).toBe(0);
  });

  it('suppresses redundant overlapping boxes with lower scores', () => {
    const detections: FaceDetection[] = [
      {
        x: 0.1,
        y: 0.1,
        width: 0.2,
        height: 0.2,
        score: 0.95,
        keypoints: [],
      },
      {
        x: 0.11,
        y: 0.11,
        width: 0.2,
        height: 0.2,
        score: 0.85, // heavily overlaps first box
        keypoints: [],
      },
      {
        x: 0.6,
        y: 0.6,
        width: 0.2,
        height: 0.2,
        score: 0.9, // disjoint second face
        keypoints: [],
      },
    ];

    const result = nonMaxSuppression(detections, 0.3);
    expect(result).toHaveLength(2);
    expect(result[0].score).toBe(0.95);
    expect(result[1].score).toBe(0.9);
  });
});

describe('Letterboxing and Coordinate Mapping', () => {
  it('computes letterbox scale and padding for landscape and portrait images', () => {
    // Landscape 200x100 -> target 128x128
    const landscape = calculateLetterbox(200, 100, 128);
    expect(landscape.scale).toBe(128 / 200);
    expect(landscape.scaledWidth).toBe(128);
    expect(landscape.scaledHeight).toBe(64);
    expect(landscape.padX).toBe(0);
    expect(landscape.padY).toBe(32);

    // Portrait 100x200 -> target 128x128
    const portrait = calculateLetterbox(100, 200, 128);
    expect(portrait.scale).toBe(128 / 200);
    expect(portrait.scaledWidth).toBe(64);
    expect(portrait.scaledHeight).toBe(128);
    expect(portrait.padX).toBe(32);
    expect(portrait.padY).toBe(0);
  });

  it('unletterboxes detection back to original image space', () => {
    const origWidth = 1000;
    const origHeight = 500;
    const letterbox = calculateLetterbox(origWidth, origHeight, 128);

    // Suppose detection is in the center of the image in letterbox coordinates:
    // Scaled height is 64, padY is 32. Center in letterbox: y = 64 / 128 = 0.5.
    const detectionInLetterbox: FaceDetection = {
      x: 0.4,
      y: 0.45,
      width: 0.2,
      height: 0.1,
      score: 0.9,
      keypoints: [{ x: 0.5, y: 0.5 }],
    };

    const unletterboxed = unletterboxDetection(
      detectionInLetterbox,
      letterbox,
      origWidth,
      origHeight,
    );

    expect(unletterboxed.x).toBeGreaterThanOrEqual(0);
    expect(unletterboxed.x + unletterboxed.width).toBeLessThanOrEqual(1.01);
    expect(unletterboxed.y).toBeGreaterThanOrEqual(0);
    expect(unletterboxed.y + unletterboxed.height).toBeLessThanOrEqual(1.01);
    expect(unletterboxed.score).toBe(0.9);
  });

  it('filters out faces smaller than minShortEdgePx', () => {
    const detections: FaceDetection[] = [
      {
        x: 0.1,
        y: 0.1,
        width: 0.1, // 0.1 * 1000 = 100 px > 48 px
        height: 0.1, // 0.1 * 1000 = 100 px > 48 px
        score: 0.9,
        keypoints: [],
      },
      {
        x: 0.5,
        y: 0.5,
        width: 0.02, // 0.02 * 1000 = 20 px < 48 px
        height: 0.03, // 0.03 * 1000 = 30 px < 48 px
        score: 0.85,
        keypoints: [],
      },
    ];

    const filtered = filterMinFaceSize(detections, 1000, 1000, 48);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].score).toBe(0.9);
  });
});
