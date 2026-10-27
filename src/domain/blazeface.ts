/**
 * Pure TypeScript implementation of BlazeFace short-range anchor generation,
 * output decoding, Non-Maximum Suppression (NMS), and letterbox mapping.
 *
 * NOTE: Per 04_TRD §3, src/domain must NOT import anything from React or Expo.
 */

export interface Anchor {
  xCenter: number;
  yCenter: number;
  width: number;
  height: number;
}

export interface Keypoint {
  x: number;
  y: number;
}

export interface FaceDetection {
  /** Normalized bounding box in range [0, 1] relative to the coordinate space */
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  /** 6 keypoints: right eye, left eye, nose tip, mouth center, right ear, left ear */
  keypoints: Keypoint[];
}

export interface LetterboxInfo {
  scale: number;
  scaledWidth: number;
  scaledHeight: number;
  padX: number;
  padY: number;
  targetSize: number;
}

export interface BlazeFaceOptions {
  scoreThreshold?: number; // default 0.6 per TRD §4
  iouThreshold?: number; // default 0.3
  minFaceSizePx?: number; // default 48 per TRD §4
}

/**
 * Generate the 896 static anchors for BlazeFace short-range model (128x128 input).
 * Matches Google MediaPipe SsdAnchorsCalculator configuration.
 */
export function generateAnchors(): Anchor[] {
  const anchors: Anchor[] = [];
  const numLayers = 4;
  const strides = [8, 16, 16, 16];
  const minScale = 0.1484375; // 19 / 128
  const maxScale = 0.75; // 96 / 128
  const inputSize = 128;
  const anchorOffsetX = 0.5;
  const anchorOffsetY = 0.5;

  const scales: number[] = [];
  for (let l = 0; l < numLayers; l++) {
    scales.push(minScale + ((maxScale - minScale) * l) / (numLayers - 1));
  }

  for (let layerIdx = 0; layerIdx < numLayers; layerIdx++) {
    const stride = strides[layerIdx];
    const gridDim = Math.ceil(inputSize / stride); // 16 for layer 0, 8 for layers 1..3
    const scale = scales[layerIdx];
    const nextScale = layerIdx < numLayers - 1 ? scales[layerIdx + 1] : 1.0;

    for (let y = 0; y < gridDim; y++) {
      for (let x = 0; x < gridDim; x++) {
        const xCenter = (x + anchorOffsetX) / gridDim;
        const yCenter = (y + anchorOffsetY) / gridDim;

        // Anchor 1: square box of scale x scale
        anchors.push({
          xCenter,
          yCenter,
          width: scale,
          height: scale,
        });

        // Anchor 2: geometric mean of current and next scale
        const secondScale = Math.sqrt(scale * nextScale);
        anchors.push({
          xCenter,
          yCenter,
          width: secondScale,
          height: secondScale,
        });
      }
    }
  }

  return anchors;
}

/** Pre-computed 896 anchors */
export const BLAZEFACE_ANCHORS: Anchor[] = generateAnchors();

/**
 * Sigmoid activation function
 */
export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Decodes raw BlazeFace regression and score tensors.
 *
 * @param rawBoxes Float32Array or number[] of shape [896 * 16] or [896, 16]
 * @param rawScores Float32Array or number[] of shape [896]
 * @param anchors Precomputed 896 anchors
 * @param scoreThreshold Minimum score threshold (default 0.6)
 */
export function decodeDetections(
  rawBoxes: ArrayLike<number>,
  rawScores: ArrayLike<number>,
  anchors: Anchor[] = BLAZEFACE_ANCHORS,
  scoreThreshold = 0.6,
): FaceDetection[] {
  const detections: FaceDetection[] = [];
  const numAnchors = anchors.length;

  for (let i = 0; i < numAnchors; i++) {
    const rawScore = rawScores[i];
    const score = sigmoid(rawScore);

    if (score < scoreThreshold) {
      continue;
    }

    const anchor = anchors[i];
    const offset = i * 16;

    // Regressor offsets (scaled by 128)
    const dx = rawBoxes[offset];
    const dy = rawBoxes[offset + 1];
    const dw = rawBoxes[offset + 2];
    const dh = rawBoxes[offset + 3];

    const cx = anchor.xCenter + (dx / 128) * anchor.width;
    const cy = anchor.yCenter + (dy / 128) * anchor.height;
    const w = (dw / 128) * anchor.width;
    const h = (dh / 128) * anchor.height;

    const x = cx - w / 2;
    const y = cy - h / 2;

    const keypoints: Keypoint[] = [];
    for (let k = 0; k < 6; k++) {
      const kpOffset = offset + 4 + k * 2;
      const kpx = anchor.xCenter + (rawBoxes[kpOffset] / 128) * anchor.width;
      const kpy = anchor.yCenter + (rawBoxes[kpOffset + 1] / 128) * anchor.height;
      keypoints.push({ x: kpx, y: kpy });
    }

    detections.push({
      x,
      y,
      width: w,
      height: h,
      score,
      keypoints,
    });
  }

  return detections;
}

/**
 * Computes Intersection over Union (IoU) between two boxes.
 */
export function computeIoU(
  boxA: { x: number; y: number; width: number; height: number },
  boxB: { x: number; y: number; width: number; height: number },
): number {
  const xA = Math.max(boxA.x, boxB.x);
  const yA = Math.max(boxA.y, boxB.y);
  const xB = Math.min(boxA.x + boxA.width, boxB.x + boxB.width);
  const yB = Math.min(boxA.y + boxA.height, boxB.y + boxB.height);

  const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
  const boxAArea = boxA.width * boxA.height;
  const boxBArea = boxB.width * boxB.height;
  const unionArea = boxAArea + boxBArea - interArea;

  return unionArea > 0 ? interArea / unionArea : 0;
}

/**
 * Applies Non-Maximum Suppression (NMS) to face detections.
 */
export function nonMaxSuppression(
  detections: FaceDetection[],
  iouThreshold = 0.3,
): FaceDetection[] {
  if (detections.length === 0) return [];

  // Sort descending by score
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const selected: FaceDetection[] = [];

  for (const candidate of sorted) {
    let shouldSelect = true;

    for (const chosen of selected) {
      if (computeIoU(candidate, chosen) > iouThreshold) {
        shouldSelect = false;
        break;
      }
    }

    if (shouldSelect) {
      selected.push(candidate);
    }
  }

  return selected;
}

/**
 * Calculates letterbox transformation parameters for fitting an image into target square (128x128).
 */
export function calculateLetterbox(
  srcWidth: number,
  srcHeight: number,
  targetSize = 128,
): LetterboxInfo {
  const scale = Math.min(targetSize / srcWidth, targetSize / srcHeight);
  const scaledWidth = srcWidth * scale;
  const scaledHeight = srcHeight * scale;
  const padX = (targetSize - scaledWidth) / 2;
  const padY = (targetSize - scaledHeight) / 2;

  return {
    scale,
    scaledWidth,
    scaledHeight,
    padX,
    padY,
    targetSize,
  };
}

/**
 * Maps a detection in 128x128 letterbox space back to original image coordinates.
 * Returns normalized bounding box [0, 1] relative to the original image dimensions.
 */
export function unletterboxDetection(
  detection: FaceDetection,
  info: LetterboxInfo,
  srcWidth: number,
  srcHeight: number,
): FaceDetection {
  // Coordinates in 128x128 pixel space
  const xPixel = detection.x * info.targetSize;
  const yPixel = detection.y * info.targetSize;
  const wPixel = detection.width * info.targetSize;
  const hPixel = detection.height * info.targetSize;

  // Unpad and unscale to original image pixels
  const origX = Math.max(0, (xPixel - info.padX) / info.scale);
  const origY = Math.max(0, (yPixel - info.padY) / info.scale);
  const origW = Math.min(srcWidth - origX, wPixel / info.scale);
  const origH = Math.min(srcHeight - origY, hPixel / info.scale);

  // Keypoints
  const unletterboxedKeypoints = detection.keypoints.map((kp) => {
    const kpPixelX = kp.x * info.targetSize;
    const kpPixelY = kp.y * info.targetSize;
    return {
      x: Math.max(0, Math.min(1, (kpPixelX - info.padX) / info.scale / srcWidth)),
      y: Math.max(0, Math.min(1, (kpPixelY - info.padY) / info.scale / srcHeight)),
    };
  });

  return {
    x: origX / srcWidth,
    y: origY / srcHeight,
    width: origW / srcWidth,
    height: origH / srcHeight,
    score: detection.score,
    keypoints: unletterboxedKeypoints,
  };
}

/**
 * Filter detections by minimum face size in pixels on the original image.
 * TRD §4: drop faces with short edge < 48 px.
 */
export function filterMinFaceSize(
  detections: FaceDetection[],
  imageWidth: number,
  imageHeight: number,
  minShortEdgePx = 48,
): FaceDetection[] {
  return detections.filter((det) => {
    const widthPx = det.width * imageWidth;
    const heightPx = det.height * imageHeight;
    const shortEdgePx = Math.min(widthPx, heightPx);
    return shortEdgePx >= minShortEdgePx;
  });
}
