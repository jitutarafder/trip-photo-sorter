// Pure TypeScript Face Clustering & Embedding Math (TRD §4)
// No imports from React, React Native, or Expo

import { CONFIG } from './config';

export interface FaceEmbeddingItem {
  id: string;
  embedding: Float32Array;
  photoId?: string;
}

export interface FaceCluster {
  id: string;
  itemIds: string[];
  centroid: Float32Array;
  coverFaceId?: string;
}

export interface ClusteringResult {
  clusters: FaceCluster[];
  othersItemIds: string[];
}

/**
 * Normalizes a vector to have unit L2 length (||v||_2 = 1.0).
 * If norm is 0, returns a zero vector.
 */
export function l2Normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i];
  }

  const norm = Math.sqrt(sumSq);
  const result = new Float32Array(vec.length);
  if (norm < 1e-9) {
    return result;
  }

  const invNorm = 1.0 / norm;
  for (let i = 0; i < vec.length; i++) {
    result[i] = vec[i] * invNorm;
  }
  return result;
}

/**
 * Calculates cosine distance between two embedding vectors:
 * 1.0 - (a · b) / (||a|| * ||b||)
 * Returns a value in [0, 2], where 0 = identical, 1 = orthogonal, 2 = opposite.
 */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) {
    return 1.0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom < 1e-9) {
    return 1.0;
  }

  const cosineSim = dot / denom;
  // Clamp similarity to [-1.0, 1.0] to prevent floating point inaccuracies
  const clampedSim = Math.max(-1.0, Math.min(1.0, cosineSim));
  return 1.0 - clampedSim;
}

/**
 * Computes the L2-normalized centroid (mean embedding) of a set of face embeddings.
 */
export function computeCentroid(embeddings: Float32Array[]): Float32Array {
  if (embeddings.length === 0) {
    return new Float32Array(0);
  }

  const dim = embeddings[0].length;
  const mean = new Float32Array(dim);

  for (let i = 0; i < embeddings.length; i++) {
    const emb = embeddings[i];
    for (let d = 0; d < dim; d++) {
      mean[d] += emb[d];
    }
  }

  const count = embeddings.length;
  for (let d = 0; d < dim; d++) {
    mean[d] /= count;
  }

  return l2Normalize(mean);
}

/**
 * Calculates average linkage distance between two clusters of item indices.
 * dist(A, B) = sum(d(i, j)) / (|A| * |B|)
 */
export function averageLinkageDistance(
  clusterA: number[],
  clusterB: number[],
  distanceMatrix: number[][],
): number {
  let sum = 0;
  for (let i = 0; i < clusterA.length; i++) {
    const idxA = clusterA[i];
    for (let j = 0; j < clusterB.length; j++) {
      const idxB = clusterB[j];
      sum += distanceMatrix[idxA][idxB];
    }
  }
  return sum / (clusterA.length * clusterB.length);
}

/**
 * Checks whether two clusters contain faces originating from the exact same photo.
 * A single photograph cannot contain multiple faces of the same person (cannot-link constraint).
 */
export function haveOverlappingPhotos(
  clusterA: number[],
  clusterB: number[],
  photoIds: (string | undefined)[],
): boolean {
  const seenPhotos = new Set<string>();
  for (let i = 0; i < clusterA.length; i++) {
    const pid = photoIds[clusterA[i]];
    if (pid !== undefined) {
      seenPhotos.add(pid);
    }
  }
  for (let i = 0; i < clusterB.length; i++) {
    const pid = photoIds[clusterB[i]];
    if (pid !== undefined && seenPhotos.has(pid)) {
      return true;
    }
  }
  return false;
}

/**
 * Agglomerative hierarchical clustering with average linkage and same-photo cannot-link constraint.
 * (TRD §4: threshold CLUSTER_DISTANCE = 0.45, clusters with 1 face -> Others)
 */
export function clusterEmbeddings(
  items: FaceEmbeddingItem[],
  threshold: number = CONFIG.CLUSTER_DISTANCE,
  minClusterSize: number = CONFIG.MIN_CLUSTER_SIZE,
): ClusteringResult {
  const n = items.length;
  if (n === 0) {
    return { clusters: [], othersItemIds: [] };
  }

  // Pre-calculate pairwise distance matrix using contiguous Float32Array (4 bytes/float)
  const clusterDist = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = cosineDistance(items[i].embedding, items[j].embedding);
      clusterDist[i * n + j] = d;
      clusterDist[j * n + i] = d;
    }
  }

  // Internal cluster representation with item indices, photo ID set, and cluster size
  interface InternalCluster {
    indices: number[];
    photoIds: Set<string>;
    size: number;
  }

  const internalClusters: InternalCluster[] = items.map((it, idx) => ({
    indices: [idx],
    photoIds: it.photoId ? new Set([it.photoId]) : new Set<string>(),
    size: 1,
  }));

  // Active cluster IDs (referencing internalClusters array)
  const active: number[] = items.map((_, idx) => idx);

  // Lance-Williams recurrence relation for average-linkage UPGMA (O(N^2) instead of O(N^4))
  while (active.length > 1) {
    let minDistance = Infinity;
    let mergeIdxA = -1;
    let mergeIdxB = -1;

    for (let a = 0; a < active.length; a++) {
      const cA = active[a];
      const clusterA = internalClusters[cA];

      for (let b = a + 1; b < active.length; b++) {
        const cB = active[b];
        const d = clusterDist[cA * n + cB];
        if (d >= minDistance) {
          continue;
        }

        const clusterB = internalClusters[cB];
        // Cannot-link constraint: faces from the exact same photo cannot merge
        let hasOverlap = false;
        const [smaller, larger] =
          clusterA.photoIds.size <= clusterB.photoIds.size
            ? [clusterA.photoIds, clusterB.photoIds]
            : [clusterB.photoIds, clusterA.photoIds];

        for (const pid of smaller) {
          if (larger.has(pid)) {
            hasOverlap = true;
            break;
          }
        }
        if (hasOverlap) {
          continue;
        }

        minDistance = d;
        mergeIdxA = a;
        mergeIdxB = b;
      }
    }

    // Stop if closest clusters exceed the distance threshold
    if (minDistance > threshold || mergeIdxA === -1 || mergeIdxB === -1) {
      break;
    }

    const cA = active[mergeIdxA];
    const cB = active[mergeIdxB];
    const clusterA = internalClusters[cA];
    const clusterB = internalClusters[cB];

    const sizeA = clusterA.size;
    const sizeB = clusterB.size;
    const newSize = sizeA + sizeB;

    // Lance-Williams update for all remaining active clusters:
    // D(A U B, C) = (sizeA * D(A, C) + sizeB * D(B, C)) / (sizeA + sizeB)
    for (let i = 0; i < active.length; i++) {
      if (i === mergeIdxA || i === mergeIdxB) continue;
      const cC = active[i];
      const dAC = clusterDist[cA * n + cC];
      const dBC = clusterDist[cB * n + cC];
      const newD = (sizeA * dAC + sizeB * dBC) / newSize;
      clusterDist[cA * n + cC] = newD;
      clusterDist[cC * n + cA] = newD;
    }

    // Merge B into A
    clusterA.indices.push(...clusterB.indices);
    for (const pid of clusterB.photoIds) {
      clusterA.photoIds.add(pid);
    }
    clusterA.size = newSize;

    // Remove B from active list
    active.splice(mergeIdxB, 1);
  }

  // Extract merged cluster index lists
  const activeClusters = active.map((cIdx) => internalClusters[cIdx].indices);

  // Separate clusters by minClusterSize
  const clusters: FaceCluster[] = [];
  const othersItemIds: string[] = [];

  // Sort clusters by size descending
  activeClusters.sort((a, b) => b.length - a.length);

  let clusterCounter = 1;
  for (const clusterIndices of activeClusters) {
    if (clusterIndices.length >= minClusterSize) {
      const itemIds = clusterIndices.map((idx) => items[idx].id);
      const embeddings = clusterIndices.map((idx) => items[idx].embedding);
      const centroid = computeCentroid(embeddings);

      // Select cover face as the face closest to the cluster centroid
      let bestFaceId = itemIds[0];
      let minCentroidDist = Infinity;
      for (let i = 0; i < itemIds.length; i++) {
        const dist = cosineDistance(embeddings[i], centroid);
        if (dist < minCentroidDist) {
          minCentroidDist = dist;
          bestFaceId = itemIds[i];
        }
      }

      clusters.push({
        id: `person_${clusterCounter++}`,
        itemIds,
        centroid,
        coverFaceId: bestFaceId,
      });
    } else {
      for (const idx of clusterIndices) {
        othersItemIds.push(items[idx].id);
      }
    }
  }

  return { clusters, othersItemIds };
}

/**
 * Converts a raw SQLite BLOB (Uint8Array) of 128 Float32 values (512 bytes)
 * into an aligned Float32Array embedding vector.
 */
export function blobToEmbedding(blob: Uint8Array): Float32Array {
  if (blob.byteLength === 0) {
    return new Float32Array(0);
  }
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

/**
 * Converts a Float32Array embedding vector into a Uint8Array suitable for SQLite BLOB storage.
 */
export function embeddingToBlob(floats: Float32Array): Uint8Array {
  return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}

export interface FaceClusteringInput {
  id: string;
  photo_id: string;
  assignment?: 'auto' | 'manual';
  quality_ok: number;
  embedding: Uint8Array | Float32Array;
}

export interface TripClusteringResult {
  clusters: FaceCluster[];
  othersItemIds: string[];
  skippedManualFaceIds: string[];
}

export interface ClusterTripFacesOptions {
  threshold?: number;
  minClusterSize?: number;
}

/**
 * Pure domain face clustering for a trip:
 * - Filters out manual face assignments (they are pinned and never changed).
 * - Routes low-quality faces (quality_ok !== 1) to Others.
 * - Clusters high-quality auto faces using average-linkage on cosine distance.
 * - Clusters with < minClusterSize go to Others.
 * - Selects cover face (closest face to centroid) for each cluster.
 */
export function clusterTripFaces(
  faces: FaceClusteringInput[],
  options: ClusterTripFacesOptions = {}
): TripClusteringResult {
  const threshold = options.threshold ?? CONFIG.CLUSTER_DISTANCE;
  const minClusterSize = options.minClusterSize ?? CONFIG.MIN_CLUSTER_SIZE;

  const skippedManualFaceIds: string[] = [];
  const lowQualityOthersFaceIds: string[] = [];
  const candidateItems: FaceEmbeddingItem[] = [];

  for (const face of faces) {
    if (face.assignment === 'manual') {
      skippedManualFaceIds.push(face.id);
      continue;
    }

    if (face.quality_ok !== 1) {
      lowQualityOthersFaceIds.push(face.id);
      continue;
    }

    const embedding =
      face.embedding instanceof Float32Array
        ? face.embedding
        : blobToEmbedding(face.embedding);

    candidateItems.push({
      id: face.id,
      embedding,
      photoId: face.photo_id,
    });
  }

  const { clusters, othersItemIds: singleFaceOthers } = clusterEmbeddings(
    candidateItems,
    threshold,
    minClusterSize
  );

  return {
    clusters,
    othersItemIds: [...lowQualityOthersFaceIds, ...singleFaceOthers],
    skippedManualFaceIds,
  };
}
