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

  const photoIds = items.map((it) => it.photoId);

  // Pre-calculate pairwise distance matrix
  const distMatrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = cosineDistance(items[i].embedding, items[j].embedding);
      distMatrix[i][j] = d;
      distMatrix[j][i] = d;
    }
  }

  // Initialize each item as its own cluster (indices into items array)
  let activeClusters: number[][] = items.map((_, idx) => [idx]);

  while (activeClusters.length > 1) {
    let minDistance = Infinity;
    let mergeIdxA = -1;
    let mergeIdxB = -1;

    // Find pair of clusters with minimum average distance
    for (let a = 0; a < activeClusters.length; a++) {
      for (let b = a + 1; b < activeClusters.length; b++) {
        // Cannot-link constraint: faces from the exact same photo cannot merge
        if (haveOverlappingPhotos(activeClusters[a], activeClusters[b], photoIds)) {
          continue;
        }

        const d = averageLinkageDistance(activeClusters[a], activeClusters[b], distMatrix);
        if (d < minDistance) {
          minDistance = d;
          mergeIdxA = a;
          mergeIdxB = b;
        }
      }
    }

    // Stop if closest clusters exceed the distance threshold
    if (minDistance > threshold || mergeIdxA === -1 || mergeIdxB === -1) {
      break;
    }

    // Merge cluster B into cluster A and remove cluster B
    const merged = activeClusters[mergeIdxA].concat(activeClusters[mergeIdxB]);
    const nextClusters: number[][] = [];
    for (let i = 0; i < activeClusters.length; i++) {
      if (i === mergeIdxA) {
        nextClusters.push(merged);
      } else if (i !== mergeIdxB) {
        nextClusters.push(activeClusters[i]);
      }
    }
    activeClusters = nextClusters;
  }

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
      clusters.push({
        id: `person_${clusterCounter++}`,
        itemIds,
        centroid,
      });
    } else {
      for (const idx of clusterIndices) {
        othersItemIds.push(items[idx].id);
      }
    }
  }

  return { clusters, othersItemIds };
}
