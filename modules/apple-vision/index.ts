import { requireNativeModule, Platform } from 'expo-modules-core';

export interface VisionFace {
  x: number; // Normalized (0.0 to 1.0), top-left origin
  y: number; // Normalized (0.0 to 1.0), top-left origin
  width: number; // Normalized width
  height: number; // Normalized height
  pixelX: number;
  pixelY: number;
  pixelWidth: number;
  pixelHeight: number;
  confidence: number;
  roll?: number;
  yaw?: number;
  captureQuality?: number;
}

interface AppleVisionModuleInterface {
  detectFaces(imageUri: string): Promise<VisionFace[]>;
}

let AppleVision: AppleVisionModuleInterface | null = null;
if (Platform.OS === 'ios') {
  try {
    AppleVision = requireNativeModule<AppleVisionModuleInterface>('AppleVision');
  } catch {
    // Native module not loaded (e.g. running outside dev client or in test)
    AppleVision = null;
  }
}

export async function detectFacesWithAppleVision(imageUri: string): Promise<VisionFace[]> {
  if (!AppleVision) {
    return [];
  }
  return AppleVision.detectFaces(imageUri);
}

export function isAppleVisionAvailable(): boolean {
  return AppleVision !== null;
}

export default AppleVision;
