import { Skia } from '@shopify/react-native-skia';

/**
 * Decodes a JPEG/PNG base64 string using Skia and extracts normalized RGB Float32Array pixel tensor.
 *
 * @param base64 Base64 encoded image string
 * @param width Expected image width
 * @param height Expected image height
 * @param mean Normalization mean (default 127.5)
 * @param std Normalization standard deviation / scale (default 127.5)
 * @returns Float32Array of shape [height * width * 3] or null if decode fails
 */
export function base64ToRgbTensor(
  base64: string,
  width: number,
  height: number,
  mean = 127.5,
  std = 127.5,
): Float32Array | null {
  try {
    const data = Skia.Data.fromBase64(base64);
    let image = Skia.Image.MakeImageFromEncoded(data);
    if (!image) {
      console.warn('[base64ToRgbTensor] MakeImageFromEncoded returned null');
      return null;
    }

    image = image.makeNonTextureImage();
    const pixels = image.readPixels();
    if (!pixels) {
      console.warn('[base64ToRgbTensor] image.readPixels() returned null');
      return null;
    }

    const actualW = image.width();
    const actualH = image.height();
    const totalPixels = actualW * actualH;
    const tensor = new Float32Array(totalPixels * 3);
    const invStd = 1.0 / std;

    for (let i = 0; i < totalPixels; i++) {
      const srcIdx = i * 4;
      const dstIdx = i * 3;
      tensor[dstIdx + 0] = (pixels[srcIdx + 0] - mean) * invStd;
      tensor[dstIdx + 1] = (pixels[srcIdx + 1] - mean) * invStd;
      tensor[dstIdx + 2] = (pixels[srcIdx + 2] - mean) * invStd;
    }

    return tensor;
  } catch (err) {
    console.warn('[base64ToRgbTensor] Error:', err);
    return null;
  }
}
