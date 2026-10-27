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
import { CONFIG } from './src/domain/config';
import {
  decodeDetections,
  nonMaxSuppression,
  calculateLetterbox,
  unletterboxDetection,
  filterMinFaceSize,
  FaceDetection,
} from './src/domain/blazeface';
import { calculateCropRect } from './src/domain/faceCrop';
import {
  clusterEmbeddings,
  l2Normalize,
  ClusteringResult,
  FaceEmbeddingItem,
} from './src/domain/clustering';
import { base64ToRgbTensor } from './src/utils/imagePixels';

interface PhotoItem {
  id: string;
  uri: string;
  width: number;
  height: number;
}

interface ScannedFace {
  id: string;
  photoId: string;
  cropUri: string;
  embedding: Float32Array;
  bbox: { x: number; y: number; width: number; height: number };
}

const SCREEN_WIDTH = Dimensions.get('window').width;
const PREVIEW_WIDTH = SCREEN_WIDTH - 32;

export default function App() {
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [activeTab, setActiveTab] = useState<'clusters' | 'inspector'>('clusters');
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('Ready. Load 50-100 photos to test.');
  const [progressText, setProgressText] = useState<string>('');

  // Scanned data
  const [photoDetections, setPhotoDetections] = useState<Map<string, FaceDetection[]>>(new Map());
  const [scannedFaces, setScannedFaces] = useState<ScannedFace[]>([]);
  const [clusteringResult, setClusteringResult] = useState<ClusteringResult | null>(null);
  const [clusterThreshold, setClusterThreshold] = useState<number>(CONFIG.CLUSTER_DISTANCE);

  const reclusterWithThreshold = useCallback(
    (newThreshold: number) => {
      setClusterThreshold(newThreshold);
      if (scannedFaces.length === 0) {
        return;
      }
      const embeddingItems: FaceEmbeddingItem[] = scannedFaces.map((f) => ({
        id: f.id,
        embedding: f.embedding,
      }));
      const res = clusterEmbeddings(embeddingItems, newThreshold, CONFIG.MIN_CLUSTER_SIZE);
      setClusteringResult(res);
      setStatusMessage(
        `Re-clustered at threshold ${newThreshold.toFixed(2)}: ${res.clusters.length} people + ${res.othersItemIds.length} Others.`,
      );
    },
    [scannedFaces],
  );

  // Telemetry
  const [telemetry, setTelemetry] = useState<{
    photosScanned: number;
    facesFound: number;
    totalDurationMs: number;
    clustersCount: number;
  } | null>(null);

  // Load models via react-native-fast-tflite
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const blazeface = useTensorflowModel(require('./assets/models/blazeface.tflite'), []);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mobilefacenet = useTensorflowModel(require('./assets/models/mobilefacenet.tflite'), []);

  const loadPhotos = async (count: number) => {
    try {
      setStatusMessage(`Requesting photo library permission...`);
      const { status } = await MediaLibrary.requestPermissionsAsync(false);
      if (status !== 'granted') {
        setStatusMessage('Permission denied. Please grant photo access in Settings.');
        return;
      }

      setStatusMessage(`Fetching latest ${count} photos...`);
      const assets = await MediaLibrary.getAssetsAsync({
        first: count,
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
      setScannedFaces([]);
      setClusteringResult(null);
      setTelemetry(null);
      setStatusMessage(`Loaded ${items.length} photos. Tap "Scan & Cluster" to run pipeline.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(`Error loading photos: ${msg}`);
    }
  };

  const runFacePipeline = useCallback(async () => {
    if (photos.length === 0) {
      setStatusMessage('Please load photos first.');
      return;
    }

    if (!blazeface.model || !mobilefacenet.model) {
      setStatusMessage(
        `Models not ready. BlazeFace: ${blazeface.state}, MobileFaceNet: ${mobilefacenet.state}. Must run on iOS dev client.`,
      );
      return;
    }

    setIsScanning(true);
    setStatusMessage(`Starting scan on ${photos.length} photos...`);
    const startTime = Date.now();

    const newScannedFaces: ScannedFace[] = [];
    const detectionsMap = new Map<string, FaceDetection[]>();
    let totalFacesDetected = 0;

    try {
      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i];
        setProgressText(`Processing photo ${i + 1}/${photos.length} (${totalFacesDetected} faces)...`);

        // Step 1: Preprocess to 128x128 for BlazeFace
        const letterbox = calculateLetterbox(
          photo.width,
          photo.height,
          CONFIG.BLAZEFACE_INPUT_SIZE,
        );

        const manipulated = await ImageManipulator.manipulateAsync(
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

        if (!manipulated.base64) {
          continue;
        }

        const sW = Math.round(letterbox.scaledWidth);
        const sH = Math.round(letterbox.scaledHeight);
        const rawPixels = base64ToRgbTensor(manipulated.base64, sW, sH, 127.5, 127.5);
        if (!rawPixels) {
          continue;
        }

        // Place scaled image into 128x128 letterbox buffer centered at (padX, padY)
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

        // Step 2: BlazeFace detection
        const bfOutput = await blazeface.model.run([bfInput.buffer as ArrayBuffer]);
        const out0 = new Float32Array(bfOutput[0]);
        const out1 = new Float32Array(bfOutput[1]);
        // Regressors have 14,336 elements (896 * 16), classificators have 896 elements
        const rawBoxes = out0.length > out1.length ? out0 : out1;
        const rawScores = out0.length > out1.length ? out1 : out0;

        const rawDetections = decodeDetections(
          rawBoxes,
          rawScores,
          undefined,
          CONFIG.BLAZEFACE_SCORE_THRESHOLD,
        );
        const nmsDetections = nonMaxSuppression(rawDetections, CONFIG.BLAZEFACE_IOU_THRESHOLD);
        const mappedDetections = nmsDetections.map((d) =>
          unletterboxDetection(d, letterbox, photo.width, photo.height),
        );
        const validDetections = filterMinFaceSize(
          mappedDetections,
          photo.width,
          photo.height,
          CONFIG.MIN_FACE_SIZE,
        );

        detectionsMap.set(photo.id, validDetections);

        // Step 3: Extract face crops and MobileFaceNet embeddings
        for (let f = 0; f < validDetections.length; f++) {
          const det = validDetections[f];
          totalFacesDetected++;

          // Crop face with 20% margin
          const cropRect = calculateCropRect(
            { x: det.x, y: det.y, width: det.width, height: det.height },
            photo.width,
            photo.height,
            CONFIG.CROP_MARGIN,
          );

          const cropResult = await ImageManipulator.manipulateAsync(
            photo.uri,
            [
              { crop: cropRect },
              {
                resize: {
                  width: CONFIG.MOBILEFACENET_INPUT_SIZE,
                  height: CONFIG.MOBILEFACENET_INPUT_SIZE,
                },
              },
            ],
            { format: ImageManipulator.SaveFormat.JPEG, base64: true },
          );

          if (!cropResult.base64) {
            continue;
          }

          const mfnInput = base64ToRgbTensor(
            cropResult.base64,
            CONFIG.MOBILEFACENET_INPUT_SIZE,
            CONFIG.MOBILEFACENET_INPUT_SIZE,
            127.5,
            128.0,
          );

          if (!mfnInput) {
            continue;
          }

          // Run MobileFaceNet inference
          const mfnOutput = await mobilefacenet.model.run([mfnInput.buffer as ArrayBuffer]);
          const rawEmbedding = new Float32Array(mfnOutput[0]);
          const normalizedEmb = l2Normalize(rawEmbedding);

          newScannedFaces.push({
            id: `face_${photo.id}_${f}`,
            photoId: photo.id,
            cropUri: cropResult.uri,
            embedding: normalizedEmb,
            bbox: { x: det.x, y: det.y, width: det.width, height: det.height },
          });
        }
      }

      // Step 4: Run pure TS hierarchical agglomerative clustering
      setProgressText('Clustering face embeddings...');
      const embeddingItems: FaceEmbeddingItem[] = newScannedFaces.map((f) => ({
        id: f.id,
        embedding: f.embedding,
      }));

      const clusterRes = clusterEmbeddings(
        embeddingItems,
        CONFIG.CLUSTER_DISTANCE,
        CONFIG.MIN_CLUSTER_SIZE,
      );

      const durationMs = Date.now() - startTime;
      setPhotoDetections(detectionsMap);
      setScannedFaces(newScannedFaces);
      setClusteringResult(clusterRes);
      setTelemetry({
        photosScanned: photos.length,
        facesFound: newScannedFaces.length,
        totalDurationMs: durationMs,
        clustersCount: clusterRes.clusters.length,
      });

      setStatusMessage(
        `Done! Scanned ${photos.length} photos in ${(durationMs / 1000).toFixed(1)}s. Found ${newScannedFaces.length} faces in ${clusterRes.clusters.length} people + ${clusterRes.othersItemIds.length} Others.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(`Pipeline error: ${msg}`);
    } finally {
      setIsScanning(false);
      setProgressText('');
    }
  }, [photos, blazeface.model, blazeface.state, mobilefacenet.model, mobilefacenet.state]);

  const selectedPhoto = photos[selectedIndex];

  const detectSelectedPhoto = useCallback(async () => {
    if (!selectedPhoto) {
      return;
    }
    if (!blazeface.model) {
      setStatusMessage('BlazeFace model not ready.');
      return;
    }

    try {
      setStatusMessage(`Detecting faces on Photo #${selectedIndex + 1}...`);
      const letterbox = calculateLetterbox(
        selectedPhoto.width,
        selectedPhoto.height,
        CONFIG.BLAZEFACE_INPUT_SIZE,
      );

      const manipulated = await ImageManipulator.manipulateAsync(
        selectedPhoto.uri,
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

      if (!manipulated.base64) {
        setStatusMessage('Error: ImageManipulator produced no base64.');
        return;
      }

      const sW = Math.round(letterbox.scaledWidth);
      const sH = Math.round(letterbox.scaledHeight);
      const rawPixels = base64ToRgbTensor(manipulated.base64, sW, sH, 127.5, 127.5);
      if (!rawPixels) {
        setStatusMessage('Error: Skia base64ToRgbTensor returned null.');
        return;
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

      const bfOutput = await blazeface.model.run([bfInput.buffer as ArrayBuffer]);
      const out0 = new Float32Array(bfOutput[0]);
      const out1 = new Float32Array(bfOutput[1]);
      const rawBoxes = out0.length > out1.length ? out0 : out1;
      const rawScores = out0.length > out1.length ? out1 : out0;

      let maxSig = 0;
      for (let i = 0; i < rawScores.length; i++) {
        const sig = 1 / (1 + Math.exp(-rawScores[i]));
        if (sig > maxSig) maxSig = sig;
      }

      const rawDetections = decodeDetections(
        rawBoxes,
        rawScores,
        undefined,
        0.5,
      );
      const nmsDetections = nonMaxSuppression(rawDetections, CONFIG.BLAZEFACE_IOU_THRESHOLD);
      const mappedDetections = nmsDetections.map((d) =>
        unletterboxDetection(d, letterbox, selectedPhoto.width, selectedPhoto.height),
      );

      const nextMap = new Map(photoDetections);
      nextMap.set(selectedPhoto.id, mappedDetections);
      setPhotoDetections(nextMap);

      setStatusMessage(
        `Photo #${selectedIndex + 1}: Found ${mappedDetections.length} face(s) | Peak confidence: ${(maxSig * 100).toFixed(1)}%`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(`Error on photo: ${msg}`);
    }
  }, [selectedPhoto, selectedIndex, blazeface.model, photoDetections]);

  const currentDetections = selectedPhoto ? photoDetections.get(selectedPhoto.id) || [] : [];
  const previewHeight = selectedPhoto
    ? (PREVIEW_WIDTH * selectedPhoto.height) / selectedPhoto.width
    : 240;

  // Map face ID to ScannedFace record for easy rendering
  const faceMap = new Map<string, ScannedFace>();
  for (const face of scannedFaces) {
    faceMap.set(face.id, face);
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Face Spike (Task S.3)</Text>
        <Text style={styles.subtitle}>
          BlazeFace: {blazeface.state} | MobileFaceNet: {mobilefacenet.state}
        </Text>
      </View>

      {/* Action Bar */}
      <View style={styles.actionBar}>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => loadPhotos(50)}
          disabled={isScanning}
        >
          <Text style={styles.secondaryButtonText}>Load 50 Photos</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => loadPhotos(100)}
          disabled={isScanning}
        >
          <Text style={styles.secondaryButtonText}>Load 100</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.primaryButton,
            (isScanning || photos.length === 0) && styles.buttonDisabled,
          ]}
          onPress={runFacePipeline}
          disabled={isScanning || photos.length === 0}
        >
          {isScanning ? (
            <ActivityIndicator color={darkColors.onPrimary} size="small" />
          ) : (
            <Text style={styles.buttonText}>Scan & Cluster</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Tab Switcher */}
      <View style={styles.tabContainer}>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'clusters' && styles.tabButtonActive]}
          onPress={() => setActiveTab('clusters')}
        >
          <Text
            style={[styles.tabButtonText, activeTab === 'clusters' && styles.tabButtonTextActive]}
          >
            People Clusters ({clusteringResult?.clusters.length ?? 0})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'inspector' && styles.tabButtonActive]}
          onPress={() => setActiveTab('inspector')}
        >
          <Text
            style={[styles.tabButtonText, activeTab === 'inspector' && styles.tabButtonTextActive]}
          >
            Photo Inspector ({photos.length})
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.content} contentContainerStyle={styles.scrollContent}>
        {/* Progress notification */}
        {isScanning && (
          <View style={styles.progressCard}>
            <ActivityIndicator color={darkColors.primary} size="small" />
            <Text style={styles.progressText}>{progressText}</Text>
          </View>
        )}

        {/* Tab 1: Clusters & Face Crops */}
        {activeTab === 'clusters' && (
          <View style={styles.clustersContainer}>
            {clusteringResult ? (
              <>
                {/* Live Threshold Tuning Bar */}
                <View style={styles.thresholdBar}>
                  <Text style={styles.thresholdLabel}>
                    Threshold: {clusterThreshold.toFixed(2)}
                  </Text>
                  <View style={styles.thresholdButtons}>
                    <TouchableOpacity
                      style={styles.thresholdBtn}
                      onPress={() =>
                        reclusterWithThreshold(
                          Math.max(0.3, Math.round((clusterThreshold - 0.05) * 100) / 100),
                        )
                      }
                    >
                      <Text style={styles.thresholdBtnText}>- 0.05 (Split)</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.thresholdBtn, styles.thresholdBtnActive]}
                      onPress={() =>
                        reclusterWithThreshold(
                          Math.min(0.9, Math.round((clusterThreshold + 0.05) * 100) / 100),
                        )
                      }
                    >
                      <Text style={[styles.thresholdBtnText, styles.thresholdBtnTextActive]}>
                        + 0.05 (Merge)
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {clusteringResult.clusters.map((cluster, cIndex) => (
                  <View key={cluster.id} style={styles.clusterCard}>
                    <View style={styles.clusterHeader}>
                      <Text style={styles.clusterTitle}>
                        Person {cIndex + 1} ({cluster.itemIds.length} faces)
                      </Text>
                      <Text style={styles.clusterBadge}>Group {cIndex + 1}</Text>
                    </View>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.cropsRow}>
                      {cluster.itemIds.map((faceId) => {
                        const face = faceMap.get(faceId);
                        if (!face) return null;
                        return (
                          <View key={faceId} style={styles.cropWrapper}>
                            <Image source={{ uri: face.cropUri }} style={styles.cropImage} />
                          </View>
                        );
                      })}
                    </ScrollView>
                  </View>
                ))}

                {/* Others Bucket */}
                {clusteringResult.othersItemIds.length > 0 && (
                  <View style={styles.clusterCard}>
                    <View style={styles.clusterHeader}>
                      <Text style={styles.clusterTitle}>
                        Others ({clusteringResult.othersItemIds.length} single faces)
                      </Text>
                      <Text style={styles.othersBadge}>Unclustered</Text>
                    </View>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.cropsRow}>
                      {clusteringResult.othersItemIds.map((faceId) => {
                        const face = faceMap.get(faceId);
                        if (!face) return null;
                        return (
                          <View key={faceId} style={styles.cropWrapper}>
                            <Image source={{ uri: face.cropUri }} style={styles.cropImage} />
                          </View>
                        );
                      })}
                    </ScrollView>
                  </View>
                )}
              </>
            ) : (
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>
                  {'No clusters yet. Tap "Load 50 Photos" then "Scan & Cluster" above.'}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Tab 2: Photo Inspector */}
        {activeTab === 'inspector' && (
          <View style={styles.inspectorContainer}>
            {/* Horizontal thumbnail carousel */}
            {photos.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.thumbnailCarousel}
              >
                {photos.map((item, index) => (
                  <TouchableOpacity
                    key={item.id}
                    onPress={() => setSelectedIndex(index)}
                    style={[
                      styles.thumbnailWrapper,
                      index === selectedIndex && styles.thumbnailSelected,
                    ]}
                  >
                    <Image source={{ uri: item.uri }} style={styles.thumbnail} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}

            {/* Single Photo Action Button */}
            {selectedPhoto && (
              <TouchableOpacity
                style={styles.singleDetectButton}
                onPress={detectSelectedPhoto}
                disabled={isScanning}
              >
                <Text style={styles.singleDetectButtonText}>
                  Detect Faces on This Photo (#{selectedIndex + 1})
                </Text>
              </TouchableOpacity>
            )}

            {/* Photo Preview with Bounding Boxes */}
            {selectedPhoto ? (
              <View style={[styles.previewContainer, { height: previewHeight }]}>
                <Image
                  source={{ uri: selectedPhoto.uri }}
                  style={[styles.previewImage, { height: previewHeight }]}
                  resizeMode="contain"
                />
                {currentDetections.map((det, index) => {
                  const boxLeft = det.x * PREVIEW_WIDTH;
                  const boxTop = det.y * previewHeight;
                  const boxW = det.width * PREVIEW_WIDTH;
                  const boxH = det.height * previewHeight;

                  return (
                    <View
                      key={index}
                      style={[
                        styles.boundingBox,
                        { left: boxLeft, top: boxTop, width: boxW, height: boxH },
                      ]}
                    >
                      <Text style={styles.boxScore}>{(det.score * 100).toFixed(0)}%</Text>
                    </View>
                  );
                })}
              </View>
            ) : (
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>
                  {'No photo selected. Tap "Load 50 Photos" above.'}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Status / Telemetry card */}
        <View style={styles.logCard}>
          <Text style={styles.logTitle}>Status & Telemetry</Text>
          <Text style={styles.logText}>{statusMessage}</Text>
          {telemetry && (
            <View style={styles.telemetrySection}>
              <Text style={styles.telemetryText}>
                Photos: {telemetry.photosScanned} | Faces: {telemetry.facesFound} | Clusters: {telemetry.clustersCount}
              </Text>
              <Text style={styles.telemetryText}>
                Total Time: {(telemetry.totalDurationMs / 1000).toFixed(2)} s (
                {(telemetry.totalDurationMs / telemetry.photosScanned).toFixed(0)} ms/photo)
              </Text>
              <Text style={styles.telemetryHighlight}>
                Throughput: {(telemetry.photosScanned / (telemetry.totalDurationMs / 1000)).toFixed(2)} photos/sec
                (Gate Target: ≥ 2 photos/s)
              </Text>
            </View>
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
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: darkColors.border,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: darkColors.text,
  },
  subtitle: {
    fontSize: 12,
    color: darkColors.textMuted,
    marginTop: 2,
  },
  actionBar: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  primaryButton: {
    flex: 1,
    backgroundColor: darkColors.primary,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButton: {
    backgroundColor: darkColors.surfaceAlt,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: darkColors.onPrimary,
    fontWeight: '600',
    fontSize: 14,
  },
  secondaryButtonText: {
    color: darkColors.text,
    fontWeight: '500',
    fontSize: 13,
  },
  tabContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: darkColors.border,
    backgroundColor: darkColors.surface,
  },
  tabButton: {
    paddingVertical: 10,
    marginRight: 16,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabButtonActive: {
    borderBottomColor: darkColors.primary,
  },
  tabButtonText: {
    fontSize: 13,
    color: darkColors.textMuted,
    fontWeight: '500',
  },
  tabButtonTextActive: {
    color: darkColors.primary,
    fontWeight: '600',
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    gap: 16,
  },
  progressCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: darkColors.surface,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: darkColors.primary,
  },
  progressText: {
    color: darkColors.text,
    fontSize: 13,
    flex: 1,
  },
  clustersContainer: {
    gap: 12,
  },
  clusterCard: {
    backgroundColor: darkColors.surface,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: darkColors.border,
  },
  clusterHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  clusterTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: darkColors.text,
  },
  clusterBadge: {
    fontSize: 11,
    fontWeight: '600',
    color: darkColors.accent,
    backgroundColor: darkColors.surfaceAlt,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  othersBadge: {
    fontSize: 11,
    fontWeight: '600',
    color: darkColors.warning,
    backgroundColor: darkColors.surfaceAlt,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  cropsRow: {
    flexDirection: 'row',
  },
  cropWrapper: {
    marginRight: 8,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: darkColors.border,
  },
  cropImage: {
    width: 64,
    height: 64,
    backgroundColor: darkColors.surfaceAlt,
  },
  inspectorContainer: {
    gap: 12,
  },
  thumbnailCarousel: {
    height: 70,
  },
  thumbnailWrapper: {
    width: 64,
    height: 64,
    borderRadius: 8,
    marginRight: 8,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  thumbnailSelected: {
    borderColor: darkColors.primary,
  },
  thumbnail: {
    width: '100%',
    height: '100%',
  },
  previewContainer: {
    width: PREVIEW_WIDTH,
    backgroundColor: darkColors.surface,
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
    alignSelf: 'center',
  },
  previewImage: {
    width: PREVIEW_WIDTH,
  },
  boundingBox: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: darkColors.accent,
    backgroundColor: 'rgba(61, 219, 176, 0.1)',
  },
  boxScore: {
    position: 'absolute',
    top: -16,
    left: 0,
    backgroundColor: darkColors.accent,
    color: darkColors.bg,
    fontSize: 10,
    fontWeight: '700',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 2,
  },
  emptyContainer: {
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: darkColors.surface,
    borderRadius: 12,
  },
  emptyText: {
    color: darkColors.textMuted,
    fontSize: 13,
    textAlign: 'center',
  },
  logCard: {
    backgroundColor: darkColors.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: darkColors.border,
  },
  logTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: darkColors.textMuted,
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  logText: {
    fontSize: 13,
    color: darkColors.text,
    lineHeight: 18,
  },
  telemetrySection: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: darkColors.border,
    gap: 4,
  },
  telemetryText: {
    fontSize: 12,
    color: darkColors.textMuted,
  },
  telemetryHighlight: {
    fontSize: 12,
    color: darkColors.accent,
    fontWeight: '600',
    marginTop: 2,
  },
  singleDetectButton: {
    backgroundColor: darkColors.surfaceAlt,
    borderWidth: 1,
    borderColor: darkColors.primary,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  singleDetectButtonText: {
    color: darkColors.primary,
    fontSize: 13,
    fontWeight: '600',
  },
  thresholdBar: {
    backgroundColor: darkColors.surface,
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: darkColors.border,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  thresholdLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: darkColors.text,
  },
  thresholdButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  thresholdBtn: {
    backgroundColor: darkColors.surfaceAlt,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  thresholdBtnActive: {
    backgroundColor: darkColors.primary,
  },
  thresholdBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: darkColors.text,
  },
  thresholdBtnTextActive: {
    color: darkColors.onPrimary,
  },
});
