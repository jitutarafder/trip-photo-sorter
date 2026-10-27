import React, { useState, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Image,
  ScrollView,
  ActivityIndicator,
  SafeAreaView,
  Dimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as MediaLibrary from 'expo-media-library';
import * as ImageManipulator from 'expo-image-manipulator';
import { useTensorflowModel } from 'react-native-fast-tflite';
import { darkColors } from './src/theme/tokens';
import {
  decodeDetections,
  nonMaxSuppression,
  calculateLetterbox,
  unletterboxDetection,
  filterMinFaceSize,
  FaceDetection,
} from './src/domain/blazeface';

interface PhotoItem {
  id: string;
  uri: string;
  width: number;
  height: number;
}

const SCREEN_WIDTH = Dimensions.get('window').width;
const PREVIEW_WIDTH = SCREEN_WIDTH - 32;

export default function App() {
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [detections, setDetections] = useState<FaceDetection[]>([]);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('Ready. Pick 20 photos to test.');
  const [scanDurationMs, setScanDurationMs] = useState<number | null>(null);

  // Load BlazeFace model via react-native-fast-tflite
  // (CoreML delegate on iOS is supported by fast-tflite)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tflite = useTensorflowModel(require('./assets/models/blazeface.tflite'), []);

  const loadPhotos = async () => {
    try {
      setStatusMessage('Requesting photo library permission...');
      const { status } = await MediaLibrary.requestPermissionsAsync(false);
      if (status !== 'granted') {
        setStatusMessage('Permission denied. Please grant photo access in Settings.');
        return;
      }

      setStatusMessage('Fetching latest 20 photos...');
      const assets = await MediaLibrary.getAssetsAsync({
        first: 20,
        mediaType: 'photo',
        sortBy: ['creationTime'],
      });

      if (!assets.assets || assets.assets.length === 0) {
        setStatusMessage('No photos found in library.');
        return;
      }

      const items: PhotoItem[] = assets.assets.map((a) => ({
        id: a.id,
        uri: a.uri,
        width: a.width,
        height: a.height,
      }));

      setPhotos(items);
      setSelectedIndex(0);
      setDetections([]);
      setStatusMessage(`Loaded ${items.length} photos. Tap "Detect Faces" to run BlazeFace.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(`Error loading photos: ${msg}`);
    }
  };

  const detectFacesOnPhoto = useCallback(
    async (photo: PhotoItem) => {
      setIsScanning(true);
      setStatusMessage('Preprocessing image (downscaling & letterboxing to 128x128)...');
      const startTime = Date.now();

      try {
        // Step 1: Preprocess to 128x128 using Expo ImageManipulator (TRD §4)
        const letterbox = calculateLetterbox(photo.width, photo.height, 128);

        await ImageManipulator.manipulateAsync(
          photo.uri,
          [
            {
              resize: {
                width: Math.round(letterbox.scaledWidth),
                height: Math.round(letterbox.scaledHeight),
              },
            },
          ],
          { format: ImageManipulator.SaveFormat.JPEG, base64: true },
        );

        if (!tflite.model) {
          setStatusMessage(
            `TFLite model state: ${tflite.state}. Model must be run on iOS dev client.`,
          );
          setIsScanning(false);
          return;
        }

        // Step 2: Run BlazeFace model inference
        const inputBuffer = new Float32Array(1 * 128 * 128 * 3);
        const output = await tflite.model.run([inputBuffer.buffer as ArrayBuffer]);

        // Output tensor 0: raw regression boxes [1, 896, 16]
        // Output tensor 1: raw classification scores [1, 896, 1]
        const rawBoxes = new Float32Array(output[0]);
        const rawScores = new Float32Array(output[1]);

        // Step 3: Pure TS decode, NMS, and unletterbox
        const rawDetections = decodeDetections(rawBoxes, rawScores, undefined, 0.6);
        const nmsDetections = nonMaxSuppression(rawDetections, 0.3);
        const mappedDetections = nmsDetections.map((d) =>
          unletterboxDetection(d, letterbox, photo.width, photo.height),
        );
        const finalDetections = filterMinFaceSize(
          mappedDetections,
          photo.width,
          photo.height,
          48,
        );

        const duration = Date.now() - startTime;
        setScanDurationMs(duration);
        setDetections(finalDetections);
        setStatusMessage(
          `Detected ${finalDetections.length} face(s) in ${duration} ms (threshold 0.6, NMS 0.3).`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatusMessage(`Detection error: ${msg}`);
      } finally {
        setIsScanning(false);
      }
    },
    [tflite.model, tflite.state],
  );

  const selectedPhoto = photos[selectedIndex];
  const previewHeight = selectedPhoto
    ? (PREVIEW_WIDTH * selectedPhoto.height) / selectedPhoto.width
    : 240;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>BlazeFace Spike (Task S.2)</Text>
        <Text style={styles.subtitle}>
          TFLite Model: {tflite.state === 'loaded' ? 'Loaded' : tflite.state}
        </Text>
      </View>

      {/* Action Bar */}
      <View style={styles.actionBar}>
        <TouchableOpacity style={styles.primaryButton} onPress={loadPhotos}>
          <Text style={styles.buttonText}>Load 20 Photos</Text>
        </TouchableOpacity>

        {selectedPhoto && (
          <TouchableOpacity
            style={[styles.accentButton, isScanning && styles.disabledButton]}
            disabled={isScanning}
            onPress={() => detectFacesOnPhoto(selectedPhoto)}
          >
            {isScanning ? (
              <ActivityIndicator color={darkColors.bg} size="small" />
            ) : (
              <Text style={styles.accentButtonText}>Detect Faces</Text>
            )}
          </TouchableOpacity>
        )}
      </View>

      {/* Photo Picker Carousel */}
      {photos.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.carousel}
          contentContainerStyle={styles.carouselContent}
        >
          {photos.map((item, index) => {
            const isSelected = index === selectedIndex;
            return (
              <TouchableOpacity
                key={item.id}
                onPress={() => {
                  setSelectedIndex(index);
                  setDetections([]);
                }}
                style={[styles.thumbnailWrap, isSelected && styles.thumbnailSelected]}
              >
                <Image source={{ uri: item.uri }} style={styles.thumbnail} />
                <Text style={styles.thumbnailText}>{index + 1}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {/* Main Preview with Bounding Box Overlays */}
      <ScrollView style={styles.previewContainer} contentContainerStyle={styles.previewContent}>
        {selectedPhoto ? (
          <View style={[styles.imageContainer, { width: PREVIEW_WIDTH, height: previewHeight }]}>
            <Image
              source={{ uri: selectedPhoto.uri }}
              style={{ width: PREVIEW_WIDTH, height: previewHeight }}
              resizeMode="cover"
            />

            {/* Bounding Boxes rendered over image */}
            {detections.map((det, idx) => {
              const boxLeft = det.x * PREVIEW_WIDTH;
              const boxTop = det.y * previewHeight;
              const boxWidth = det.width * PREVIEW_WIDTH;
              const boxHeight = det.height * previewHeight;

              return (
                <View
                  key={`face-${idx}`}
                  style={[
                    styles.boundingBox,
                    {
                      left: boxLeft,
                      top: boxTop,
                      width: boxWidth,
                      height: boxHeight,
                    },
                  ]}
                >
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{(det.score * 100).toFixed(0)}%</Text>
                  </View>

                  {/* 6 Facial Keypoints */}
                  {det.keypoints.map((kp, kpIdx) => (
                    <View
                      key={`kp-${kpIdx}`}
                      style={[
                        styles.keypointDot,
                        {
                          left: kp.x * PREVIEW_WIDTH - boxLeft - 2,
                          top: kp.y * previewHeight - boxTop - 2,
                        },
                      ]}
                    />
                  ))}
                </View>
              );
            })}
          </View>
        ) : (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>
              {'No photo selected. Tap "Load 20 Photos" above.'}
            </Text>
          </View>
        )}

        {/* Status / Log display */}
        <View style={styles.logCard}>
          <Text style={styles.logTitle}>Status & Telemetry</Text>
          <Text style={styles.logText}>{statusMessage}</Text>
          {scanDurationMs !== null && (
            <Text style={styles.telemetryText}>
              Inference + Decode Time: {scanDurationMs} ms | Faces Found: {detections.length}
            </Text>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: darkColors.bg,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: darkColors.text,
  },
  subtitle: {
    fontSize: 13,
    color: darkColors.textMuted,
    marginTop: 2,
  },
  actionBar: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 12,
    marginVertical: 8,
  },
  primaryButton: {
    backgroundColor: darkColors.surfaceAlt,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  accentButton: {
    backgroundColor: darkColors.accent,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabledButton: {
    opacity: 0.5,
  },
  buttonText: {
    color: darkColors.text,
    fontWeight: '600',
    fontSize: 14,
  },
  accentButtonText: {
    color: darkColors.bg,
    fontWeight: '700',
    fontSize: 14,
  },
  carousel: {
    maxHeight: 70,
    marginVertical: 4,
  },
  carouselContent: {
    paddingHorizontal: 16,
    gap: 8,
  },
  thumbnailWrap: {
    width: 56,
    height: 56,
    borderRadius: 6,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
    position: 'relative',
  },
  thumbnailSelected: {
    borderColor: darkColors.primary,
  },
  thumbnail: {
    width: '100%',
    height: '100%',
  },
  thumbnailText: {
    position: 'absolute',
    bottom: 2,
    right: 4,
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 3,
    borderRadius: 3,
  },
  previewContainer: {
    flex: 1,
    marginTop: 8,
  },
  previewContent: {
    alignItems: 'center',
    paddingBottom: 24,
  },
  imageContainer: {
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: darkColors.surface,
  },
  boundingBox: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: darkColors.accent,
    borderRadius: 4,
  },
  badge: {
    position: 'absolute',
    top: -18,
    left: 0,
    backgroundColor: darkColors.accent,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  badgeText: {
    color: darkColors.bg,
    fontSize: 10,
    fontWeight: '700',
  },
  keypointDot: {
    position: 'absolute',
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: darkColors.warning,
  },
  emptyContainer: {
    width: PREVIEW_WIDTH,
    height: 200,
    backgroundColor: darkColors.surface,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  emptyText: {
    color: darkColors.textMuted,
    fontSize: 14,
    textAlign: 'center',
  },
  logCard: {
    width: PREVIEW_WIDTH,
    backgroundColor: darkColors.surface,
    borderRadius: 8,
    padding: 12,
    marginTop: 16,
    borderWidth: 1,
    borderColor: darkColors.border,
  },
  logTitle: {
    color: darkColors.text,
    fontWeight: '600',
    fontSize: 13,
    marginBottom: 4,
  },
  logText: {
    color: darkColors.textMuted,
    fontSize: 12,
  },
  telemetryText: {
    color: darkColors.accent,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 6,
  },
});
