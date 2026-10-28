import * as MediaLibrary from 'expo-media-library';
import * as ImageManipulator from 'expo-image-manipulator';
import { calculateCropRect } from '../domain/faceCrop';

export interface FaceThumbnailInput {
  faceId?: string | null;
  photoId: string;
  bbox_x?: number | null;
  bbox_y?: number | null;
  bbox_w?: number | null;
  bbox_h?: number | null;
  photoWidth?: number | null;
  photoHeight?: number | null;
}

const thumbnailCache = new Map<string, string>();

/**
 * Resolves a cropped face thumbnail URI for a given face and photo.
 * Caches results in memory to keep bubble rendering fast (TRD §1, 03_UI_Spec §6).
 */
export async function getFaceThumbnail(
  input: FaceThumbnailInput
): Promise<string | null> {
  const cacheKey = input.faceId || `${input.photoId}_${input.bbox_x}_${input.bbox_y}`;
  if (thumbnailCache.has(cacheKey)) {
    return thumbnailCache.get(cacheKey)!;
  }

  try {
    const asset = await MediaLibrary.getAssetInfoAsync(input.photoId);
    if (!asset || (!asset.localUri && !asset.uri)) {
      return null;
    }

    const photoUri = asset.localUri || asset.uri;

    // If bounding box coordinates are provided, crop the face
    if (
      input.bbox_x !== null &&
      input.bbox_x !== undefined &&
      input.bbox_y !== null &&
      input.bbox_y !== undefined &&
      input.bbox_w !== null &&
      input.bbox_w !== undefined &&
      input.bbox_h !== null &&
      input.bbox_h !== undefined
    ) {
      const width = input.photoWidth || asset.width || 1000;
      const height = input.photoHeight || asset.height || 1000;

      const cropRect = calculateCropRect(
        {
          x: input.bbox_x,
          y: input.bbox_y,
          width: input.bbox_w,
          height: input.bbox_h,
        },
        width,
        height,
        0.2
      );

      try {
        const cropResult = await ImageManipulator.manipulateAsync(
          photoUri,
          [
            { crop: cropRect },
            { resize: { width: 140, height: 140 } },
          ],
          { format: ImageManipulator.SaveFormat.JPEG }
        );
        thumbnailCache.set(cacheKey, cropResult.uri);
        return cropResult.uri;
      } catch {
        // Fall back to original photo URI if manipulation fails
        thumbnailCache.set(cacheKey, photoUri);
        return photoUri;
      }
    }

    // No bounding box: use original photo URI
    thumbnailCache.set(cacheKey, photoUri);
    return photoUri;
  } catch {
    return null;
  }
}

/**
 * Clears the in-memory face thumbnail cache.
 */
export function clearFaceThumbnailCache(): void {
  thumbnailCache.clear();
}
