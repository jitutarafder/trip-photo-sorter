// Pure TypeScript face crop calculation (TRD §4)
// No imports from React, React Native, or Expo

export interface NormalizedRect {
  x: number; // 0 to 1
  y: number; // 0 to 1
  width: number; // 0 to 1
  height: number; // 0 to 1
}

export interface PixelCropRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/**
 * Calculates a crop rectangle from a normalized face bounding box,
 * expanding it by `margin` (default 20% per TRD §4) and clamping to image bounds.
 */
export function calculateCropRect(
  bbox: NormalizedRect,
  imageWidth: number,
  imageHeight: number,
  margin = 0.2,
): PixelCropRect {
  // Convert normalized coordinates to pixel coordinates
  const pixelX = bbox.x * imageWidth;
  const pixelY = bbox.y * imageHeight;
  const pixelW = bbox.width * imageWidth;
  const pixelH = bbox.height * imageHeight;

  // Expand dimensions by margin on each side
  const marginX = pixelW * margin;
  const marginY = pixelH * margin;

  let left = pixelX - marginX;
  let top = pixelY - marginY;
  let right = pixelX + pixelW + marginX;
  let bottom = pixelY + pixelH + marginY;

  // Clamp to image bounds
  left = Math.max(0, Math.min(imageWidth, left));
  top = Math.max(0, Math.min(imageHeight, top));
  right = Math.max(0, Math.min(imageWidth, right));
  bottom = Math.max(0, Math.min(imageHeight, bottom));

  const width = Math.max(1, Math.round(right - left));
  const height = Math.max(1, Math.round(bottom - top));

  return {
    originX: Math.round(left),
    originY: Math.round(top),
    width,
    height,
  };
}
