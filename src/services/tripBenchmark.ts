// Benchmark Service for 300-Photo Trip (Plan Task 2.11, PRD §6)
// Measures scan time, throughput (photos/sec), per-photo latency, and peak memory

import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import { runMigrationsSync } from '../db/migrations';
import { createTrip, updateTrip } from '../db/repositories/trips';
import { upsertPhotos, updatePhotoScanStatus } from '../db/repositories/photos';
import { insertFace } from '../db/repositories/faces';
import { createPerson } from '../db/repositories/people';
import type { PhotoRow } from '../db/types';
import {
  clusterEmbeddings,
  l2Normalize,
} from '../domain/clustering';
import {
  evaluateFaceQuality,
  type FaceQualityInput,
} from '../domain/faceQuality';
import { CONFIG } from '../domain/config';
import { generateUUID } from '../utils/uuid';

export interface MemorySnapshot {
  timestamp: number;
  heapUsedMb: number;
}

export interface TripBenchmarkConfig {
  photoCount?: number;
  personCount?: number;
  concurrency?: number;
  simulatedDetectionLatencyMs?: number;
  simulatedEmbeddingLatencyMs?: number;
}

export interface TripBenchmarkResult {
  photoCount: number;
  totalDurationMs: number;
  scanDurationMs: number;
  clusteringDurationMs: number;
  throughputPhotosPerSec: number;
  avgLatencyPerPhotoMs: number;
  p95LatencyMs: number;
  facesFound: number;
  qualityOkFaces: number;
  qualityFilteredFaces: number;
  clustersCount: number;
  othersCount: number;
  startMemoryMb: number;
  peakMemoryMb: number;
  endMemoryMb: number;
  memoryDeltaMb: number;
  peakMemoryPassed: boolean; // Target: < 400 MB (01_PRD §6)
  totalTimePassed: boolean; // Target: < 3 min = 180s (01_PRD §6)
  meetsAllTargets: boolean;
  timestamp: string;
}

/**
 * Returns current heap / memory usage in megabytes.
 */
export function getCurrentMemoryUsageMb(): number {
  if (typeof process !== 'undefined' && process.memoryUsage) {
    const mem = process.memoryUsage();
    return Math.round((mem.heapUsed / (1024 * 1024)) * 100) / 100;
  }
  const hermes = (global as any).HermesInternal;
  if (hermes?.getInstrumentedStats) {
    const stats = hermes.getInstrumentedStats();
    if (stats.jsNumAllocatedBytes) {
      return Math.round((stats.jsNumAllocatedBytes / (1024 * 1024)) * 100) / 100;
    }
  }
  const perf = (global as any).performance;
  if (perf?.memory?.usedJSHeapSize) {
    return Math.round((perf.memory.usedJSHeapSize / (1024 * 1024)) * 100) / 100;
  }
  return 0;
}

/**
 * Executes a full 300-photo trip benchmark:
 * 1. Initializes database with 300 photos in a trip.
 * 2. Processes photos sequentially with concurrency 2 (TRD §4).
 * 3. Evaluates face quality (Laplacian variance blur, pose, size, confidence).
 * 4. Extracts embeddings and inserts into SQLite `faces`.
 * 5. Runs hierarchical agglomerative clustering (`CLUSTER_DISTANCE = 0.32`).
 * 6. Tracks per-photo latency and peak memory throughout the run.
 */
export async function run300PhotoBenchmark(
  options: TripBenchmarkConfig = {},
  customDb?: SQLiteDatabase
): Promise<TripBenchmarkResult> {
  const photoCount = options.photoCount ?? 300;
  const personCount = options.personCount ?? 15;
  const concurrency = options.concurrency ?? 2;
  const simDetectLatency = options.simulatedDetectionLatencyMs ?? 0;
  const simEmbedLatency = options.simulatedEmbeddingLatencyMs ?? 0;

  const db = customDb ?? openDatabaseSync(':memory:');
  runMigrationsSync(db);

  // Setup trip
  const tripId = generateUUID();
  const now = Date.now();
  await createTrip(
    {
      id: tripId,
      name: 'Benchmark 300-Photo Trip',
      start_at: now - 3 * 24 * 3600 * 1000,
      end_at: now,
      photo_count: photoCount,
    },
    db
  );

  // Pseudo-random generator for reproducible benchmark data
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const randNorm = () => {
    const u = Math.max(1e-7, rand());
    const v = rand();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  };

  // Base vectors for individuals
  const dim = 128;
  const personBaseVectors: Float32Array[] = [];
  for (let p = 0; p < personCount; p++) {
    const vec = new Float32Array(dim);
    for (let d = 0; d < dim; d++) {
      vec[d] = randNorm();
    }
    personBaseVectors.push(l2Normalize(vec));
  }

  // Pre-generate 300 photo metadata records in DB
  const photoRows: PhotoRow[] = [];
  const photoIds: string[] = [];
  for (let i = 0; i < photoCount; i++) {
    const photoId = `bench_p_${i + 1}`;
    photoIds.push(photoId);
    photoRows.push({
      id: photoId,
      trip_id: tripId,
      taken_at: now - (photoCount - i) * 60 * 1000,
      modified_at: now,
      width: 3024,
      height: 4032,
      lat: null,
      lng: null,
      is_local: 1,
      scan_status: 'pending',
      face_count: 0,
      excluded: 0,
    });
  }
  await upsertPhotos(photoRows, db);

  // Start Benchmark Tracking
  const startMemoryMb = getCurrentMemoryUsageMb();
  let peakMemoryMb = startMemoryMb;
  const startTime = Date.now();
  const perPhotoLatencies: number[] = [];

  let totalFacesFound = 0;
  let qualityOkFaces = 0;
  let qualityFilteredFaces = 0;

  // Process photos with concurrency (TRD §4: sequential scan with concurrency 2)
  for (let i = 0; i < photoIds.length; i += concurrency) {
    const batch = photoIds.slice(i, i + concurrency);

    await Promise.all(
      batch.map(async (photoId) => {
        const photoStart = Date.now();

        if (simDetectLatency > 0) {
          await new Promise((resolve) => setTimeout(resolve, simDetectLatency));
        }

        // Realistic face distribution:
        // ~15% scenic photos (0 faces)
        // ~60% solo/duo photos (1-2 faces)
        // ~25% group photos (3-6 faces)
        const roll = rand();
        let faceCountInPhoto = 1;
        if (roll < 0.15) {
          faceCountInPhoto = 0;
        } else if (roll < 0.75) {
          faceCountInPhoto = 1 + Math.floor(rand() * 2);
        } else {
          faceCountInPhoto = 3 + Math.floor(rand() * 4);
        }

        // Generate faces for this photo
        const selectedPeople = new Set<number>();
        while (selectedPeople.size < Math.min(faceCountInPhoto, personCount)) {
          selectedPeople.add(Math.floor(rand() * personCount));
        }

        let photoFaceCounter = 0;
        for (const personIdx of selectedPeople) {
          photoFaceCounter++;
          totalFacesFound++;

          if (simEmbedLatency > 0) {
            await new Promise((resolve) => setTimeout(resolve, simEmbedLatency));
          }

          // Generate perturbed embedding
          const base = personBaseVectors[personIdx];
          const perturbed = new Float32Array(dim);
          const noise = 0.45;
          for (let d = 0; d < dim; d++) {
            perturbed[d] = base[d] + randNorm() * (noise / Math.sqrt(dim));
          }
          const embedding = l2Normalize(perturbed);

          // Evaluate quality (Plan 2.4)
          // 8% of faces are blurry / low-confidence
          const isLowQuality = rand() < 0.08;
          const confidence = isLowQuality ? 0.45 : 0.88 + rand() * 0.1;
          const blur = isLowQuality ? 18 + rand() * 10 : 45 + rand() * 40;
          const size = isLowQuality ? 22 : 60 + rand() * 120;

          const qualityInput: FaceQualityInput = {
            pixelWidth: size,
            pixelHeight: size,
            confidence,
            blurScore: blur,
            yawRadians: 0.15,
          };
          const qualityResult = evaluateFaceQuality(qualityInput);
          const isQualityOk = qualityResult.quality_ok === 1;

          if (isQualityOk) {
            qualityOkFaces++;
          } else {
            qualityFilteredFaces++;
          }

          // Persist face to DB (Plan 2.3)
          await insertFace(
            {
              id: `face_${photoId}_${photoFaceCounter}`,
              photo_id: photoId,
              person_id: null,
              assignment: 'auto',
              bbox_x: 0.2,
              bbox_y: 0.2,
              bbox_w: 0.2,
              bbox_h: 0.2,
              quality: confidence,
              quality_ok: isQualityOk ? 1 : 0,
              blur,
              embedding: new Uint8Array(embedding.buffer),
            },
            db
          );
        }

        // Mark photo done
        await updatePhotoScanStatus(photoId, 'done', photoFaceCounter, db);

        const photoDuration = Date.now() - photoStart;
        perPhotoLatencies.push(photoDuration);

        // Check memory
        const currentMem = getCurrentMemoryUsageMb();
        if (currentMem > peakMemoryMb) {
          peakMemoryMb = currentMem;
        }
      })
    );
  }

  const scanEndTime = Date.now();
  const scanDurationMs = scanEndTime - startTime;

  // Step 2: Hierarchical Clustering (Plan 2.5)
  // Fetch all quality_ok = 1 faces from database
  const faceRows = db
    .getAllSync<{
      id: string;
      photo_id: string;
      embedding: Uint8Array;
    }>('SELECT id, photo_id, embedding FROM faces WHERE quality_ok = 1')
    .map((row) => ({
      id: row.id,
      photoId: row.photo_id,
      embedding: new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4
      ),
    }));

  const clusterStartTime = Date.now();
  const clusteringResult = clusterEmbeddings(
    faceRows,
    CONFIG.CLUSTER_DISTANCE,
    CONFIG.MIN_CLUSTER_SIZE
  );
  const clusterEndTime = Date.now();
  const clusteringDurationMs = clusterEndTime - clusterStartTime;

  // Persist clusters as people
  for (let c = 0; c < clusteringResult.clusters.length; c++) {
    const cluster = clusteringResult.clusters[c];
    await createPerson(
      {
        id: `person_${c + 1}`,
        trip_id: tripId,
        name: `Person ${c + 1}`,
        is_others: 0,
        centroid: new Uint8Array(cluster.centroid.buffer),
      },
      db
    );
  }

  // Update trip scan status
  await updateTrip(
    tripId,
    {
      scan_status: 'scanned',
      scanned_count: photoCount,
    },
    db
  );

  const totalEndTime = Date.now();
  const totalDurationMs = totalEndTime - startTime;
  const endMemoryMb = getCurrentMemoryUsageMb();
  if (endMemoryMb > peakMemoryMb) {
    peakMemoryMb = endMemoryMb;
  }

  // Latency percentiles
  perPhotoLatencies.sort((a, b) => a - b);
  const avgLatencyPerPhotoMs =
    perPhotoLatencies.reduce((acc, v) => acc + v, 0) / (perPhotoLatencies.length || 1);
  const p95Index = Math.min(
    perPhotoLatencies.length - 1,
    Math.floor(perPhotoLatencies.length * 0.95)
  );
  const p95LatencyMs = perPhotoLatencies[p95Index] ?? 0;

  const throughputPhotosPerSec =
    totalDurationMs > 0 ? (photoCount / (totalDurationMs / 1000)) : 0;

  // Targets from 01_PRD §6:
  // - Peak memory < 400 MB
  // - Total time for 300 photos < 3 min (180,000 ms)
  const peakMemoryPassed = peakMemoryMb < 400;
  const totalTimePassed = totalDurationMs < 180000;
  const meetsAllTargets = peakMemoryPassed && totalTimePassed;

  return {
    photoCount,
    totalDurationMs,
    scanDurationMs,
    clusteringDurationMs,
    throughputPhotosPerSec: Math.round(throughputPhotosPerSec * 100) / 100,
    avgLatencyPerPhotoMs: Math.round(avgLatencyPerPhotoMs * 100) / 100,
    p95LatencyMs: Math.round(p95LatencyMs * 100) / 100,
    facesFound: totalFacesFound,
    qualityOkFaces,
    qualityFilteredFaces,
    clustersCount: clusteringResult.clusters.length,
    othersCount: clusteringResult.othersItemIds.length,
    startMemoryMb,
    peakMemoryMb,
    endMemoryMb,
    memoryDeltaMb: Math.round((endMemoryMb - startMemoryMb) * 100) / 100,
    peakMemoryPassed,
    totalTimePassed,
    meetsAllTargets,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Formats a benchmark report for logging and documentation.
 */
export function formatBenchmarkReport(res: TripBenchmarkResult): string {
  const lines: string[] = [];
  lines.push('========================================================================');
  lines.push('          300-PHOTO TRIP BENCHMARK RESULTS (Plan Task 2.11)             ');
  lines.push('   PRD §6 Targets: Peak RAM < 400 MB · Total Duration < 3 min (180s)    ');
  lines.push('========================================================================');
  lines.push(`• Photo Count:            ${res.photoCount} photos`);
  lines.push(`• Total Duration:         ${(res.totalDurationMs / 1000).toFixed(2)} s (${res.totalDurationMs} ms)`);
  lines.push(`• Scan Pipeline Duration: ${(res.scanDurationMs / 1000).toFixed(2)} s`);
  lines.push(`• Clustering Duration:    ${(res.clusteringDurationMs / 1000).toFixed(2)} s`);
  lines.push(`• Scan Throughput:        ${res.throughputPhotosPerSec.toFixed(2)} photos/sec`);
  lines.push(`• Avg Latency per Photo:  ${res.avgLatencyPerPhotoMs.toFixed(2)} ms`);
  lines.push(`• P95 Latency per Photo:  ${res.p95LatencyMs.toFixed(2)} ms`);
  lines.push('------------------------------------------------------------------------');
  lines.push(`• Total Faces Found:      ${res.facesFound}`);
  lines.push(`• Quality OK Faces:       ${res.qualityOkFaces}`);
  lines.push(`• Filtered Faces:         ${res.qualityFilteredFaces} (blurry/low-confidence/pose)`);
  lines.push(`• Discovered People:      ${res.clustersCount} clusters`);
  lines.push(`• Others (Single Faces):  ${res.othersCount} faces`);
  lines.push('------------------------------------------------------------------------');
  lines.push(`• Start Memory:           ${res.startMemoryMb.toFixed(2)} MB`);
  lines.push(`• Peak Memory:            ${res.peakMemoryMb.toFixed(2)} MB (Target < 400 MB: ${res.peakMemoryPassed ? '✓ PASS' : '✗ FAIL'})`);
  lines.push(`• End Memory:             ${res.endMemoryMb.toFixed(2)} MB`);
  lines.push(`• Memory Delta:           ${res.memoryDeltaMb > 0 ? '+' : ''}${res.memoryDeltaMb.toFixed(2)} MB`);
  lines.push(`• Total Time Target:      ${res.totalTimePassed ? '✓ PASS (< 3 min)' : '✗ FAIL'}`);
  lines.push(`• Overall Status:         ${res.meetsAllTargets ? '✓ ALL TARGETS MET' : '✗ FAILED TARGETS'}`);
  lines.push('========================================================================\n');
  return lines.join('\n');
}
