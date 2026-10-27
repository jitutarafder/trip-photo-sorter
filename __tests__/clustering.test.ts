import {
  l2Normalize,
  cosineDistance,
  computeCentroid,
  averageLinkageDistance,
  clusterEmbeddings,
  FaceEmbeddingItem,
} from '../src/domain/clustering';
import { calculateCropRect } from '../src/domain/faceCrop';
import { CONFIG } from '../src/domain/config';

describe('Face Crop & Rect Calculation', () => {
  it('adds 20% margin around bounding box', () => {
    const bbox = { x: 0.2, y: 0.2, width: 0.2, height: 0.2 };
    // Image 1000 x 1000
    // pixel box: x=200, y=200, w=200, h=200
    // 20% margin = 40px
    // crop: left=160, top=160, right=440, bottom=440 -> w=280, h=280
    const crop = calculateCropRect(bbox, 1000, 1000, 0.2);
    expect(crop.originX).toBe(160);
    expect(crop.originY).toBe(160);
    expect(crop.width).toBe(280);
    expect(crop.height).toBe(280);
  });

  it('clamps crop to image boundaries when face is at edge', () => {
    const bbox = { x: 0.05, y: 0.05, width: 0.2, height: 0.2 };
    // Image 1000 x 1000
    // pixel box: x=50, y=50, w=200, h=200
    // margin = 40px -> left would be 10, top 10
    const cropAtTopLeft = calculateCropRect(bbox, 1000, 1000, 0.2);
    expect(cropAtTopLeft.originX).toBe(10);
    expect(cropAtTopLeft.originY).toBe(10);

    const bboxEdge = { x: 0.01, y: 0.01, width: 0.2, height: 0.2 };
    // pixel box: x=10, y=10 -> left would be -30 -> clamped to 0
    const cropClamped = calculateCropRect(bboxEdge, 1000, 1000, 0.2);
    expect(cropClamped.originX).toBe(0);
    expect(cropClamped.originY).toBe(0);
  });
});

describe('Vector & Embedding Math', () => {
  it('normalizes vector to unit length', () => {
    const vec = new Float32Array([3, 4, 0]);
    const norm = l2Normalize(vec);
    expect(norm[0]).toBeCloseTo(0.6, 5);
    expect(norm[1]).toBeCloseTo(0.8, 5);
    expect(norm[2]).toBe(0);

    const length = Math.sqrt(norm[0] ** 2 + norm[1] ** 2 + norm[2] ** 2);
    expect(length).toBeCloseTo(1.0, 5);
  });

  it('handles zero vector without NaN', () => {
    const zero = new Float32Array([0, 0, 0]);
    const norm = l2Normalize(zero);
    expect(norm[0]).toBe(0);
    expect(norm[1]).toBe(0);
    expect(norm[2]).toBe(0);
  });

  it('computes cosine distance correctly', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    const c = new Float32Array([0, 1, 0]);
    const d = new Float32Array([-1, 0, 0]);

    // Identical: distance = 0
    expect(cosineDistance(a, b)).toBeCloseTo(0.0, 5);

    // Orthogonal: distance = 1.0
    expect(cosineDistance(a, c)).toBeCloseTo(1.0, 5);

    // Opposite: distance = 2.0
    expect(cosineDistance(a, d)).toBeCloseTo(2.0, 5);
  });

  it('computes centroid as L2-normalized mean', () => {
    const v1 = new Float32Array([1, 0]);
    const v2 = new Float32Array([0, 1]);
    const centroid = computeCentroid([v1, v2]);

    expect(centroid[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(centroid[1]).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('calculates average linkage distance between clusters', () => {
    const distMatrix = [
      [0, 0.2, 0.8],
      [0.2, 0, 0.9],
      [0.8, 0.9, 0],
    ];
    // clusterA = [0, 1], clusterB = [2]
    // dist(0, 2) = 0.8, dist(1, 2) = 0.9 -> avg = 0.85
    const avg = averageLinkageDistance([0, 1], [2], distMatrix);
    expect(avg).toBeCloseTo(0.85, 5);
  });
});

describe('Agglomerative Hierarchical Clustering', () => {
  it('returns empty result for empty inputs', () => {
    const result = clusterEmbeddings([]);
    expect(result.clusters).toEqual([]);
    expect(result.othersItemIds).toEqual([]);
  });

  it('clusters similar faces together and separates distinct identities', () => {
    // 3 embeddings for Person A (around [1, 0, 0])
    const pA1 = new Float32Array([0.98, 0.05, 0.02]);
    const pA2 = new Float32Array([0.97, 0.08, 0.01]);
    const pA3 = new Float32Array([0.99, 0.03, 0.04]);

    // 2 embeddings for Person B (around [0, 1, 0])
    const pB1 = new Float32Array([0.02, 0.98, 0.03]);
    const pB2 = new Float32Array([0.05, 0.96, 0.01]);

    // 1 outlier face for Person C (size 1 -> should go to Others)
    const pC1 = new Float32Array([0.01, 0.02, 0.99]);

    const items: FaceEmbeddingItem[] = [
      { id: 'face_a1', embedding: l2Normalize(pA1) },
      { id: 'face_b1', embedding: l2Normalize(pB1) },
      { id: 'face_a2', embedding: l2Normalize(pA2) },
      { id: 'face_c1', embedding: l2Normalize(pC1) },
      { id: 'face_b2', embedding: l2Normalize(pB2) },
      { id: 'face_a3', embedding: l2Normalize(pA3) },
    ];

    const result = clusterEmbeddings(items, CONFIG.CLUSTER_DISTANCE, 2);

    // Person A has 3 faces, Person B has 2 faces -> 2 clusters
    expect(result.clusters).toHaveLength(2);

    // Largest cluster first (Person A with 3 items)
    expect(result.clusters[0].itemIds).toHaveLength(3);
    expect(result.clusters[0].itemIds).toEqual(
      expect.arrayContaining(['face_a1', 'face_a2', 'face_a3']),
    );

    // Second cluster (Person B with 2 items)
    expect(result.clusters[1].itemIds).toHaveLength(2);
    expect(result.clusters[1].itemIds).toEqual(expect.arrayContaining(['face_b1', 'face_b2']));

    // Outlier person C (1 face) goes to Others
    expect(result.othersItemIds).toEqual(['face_c1']);

    // Centroids should be unit length
    for (const cluster of result.clusters) {
      const norm = Math.sqrt(
        cluster.centroid.reduce((sum, val) => sum + val * val, 0),
      );
      expect(norm).toBeCloseTo(1.0, 5);
    }
  });

  it('respects the distance threshold', () => {
    const f1 = new Float32Array([1, 0, 0]);
    const f2 = new Float32Array([0.8, 0.6, 0]); // distance ~ 0.2

    const items: FaceEmbeddingItem[] = [
      { id: 'f1', embedding: f1 },
      { id: 'f2', embedding: f2 },
    ];

    // Tight threshold 0.1 -> cannot merge -> both become size 1 -> Others
    const tightResult = clusterEmbeddings(items, 0.1, 2);
    expect(tightResult.clusters).toHaveLength(0);
    expect(tightResult.othersItemIds).toEqual(['f1', 'f2']);

    // Normal threshold 0.3 -> merges into 1 cluster of 2
    const normalResult = clusterEmbeddings(items, 0.3, 2);
    expect(normalResult.clusters).toHaveLength(1);
    expect(normalResult.clusters[0].itemIds).toEqual(['f1', 'f2']);
  });
});
