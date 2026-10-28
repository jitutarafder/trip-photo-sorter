import { openDbSync } from '../src/db/client';
import { runMigrationsSync } from '../src/db/migrations';
import { createTrip, getTripById } from '../src/db/repositories/trips';
import { upsertPhotos } from '../src/db/repositories/photos';
import { insertFaces, getFacesByTripId } from '../src/db/repositories/faces';
import { getPeopleByTripId, createPerson } from '../src/db/repositories/people';
import type { PhotoRow, FaceRow } from '../src/db/types';
import {
  l2Normalize,
  cosineDistance,
  computeCentroid,
  averageLinkageDistance,
  clusterEmbeddings,
  blobToEmbedding,
  embeddingToBlob,
  clusterTripFaces,
  type FaceEmbeddingItem,
} from '../src/domain/clustering';
import {
  clusterAndPersistTripFaces,
  persistTripClusters,
} from '../src/services/clustering';
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

  it('converts between Float32Array and SQLite BLOB (Uint8Array) with roundtrip fidelity', () => {
    const original = new Float32Array([0.1234, -0.5678, 0.9999, 0.0]);
    const blob = embeddingToBlob(original);
    expect(blob.byteLength).toBe(16); // 4 floats * 4 bytes

    const restored = blobToEmbedding(blob);
    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 6);
    }

    // Handles empty buffer
    expect(blobToEmbedding(new Uint8Array(0))).toEqual(new Float32Array(0));
  });
});

describe('Agglomerative Hierarchical Clustering', () => {
  it('returns empty result for empty inputs', () => {
    const result = clusterEmbeddings([]);
    expect(result.clusters).toEqual([]);
    expect(result.othersItemIds).toEqual([]);
  });

  it('clusters similar faces together, assigns coverFaceId, and separates distinct identities', () => {
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
    expect(result.clusters[0].coverFaceId).toBeDefined();
    expect(result.clusters[0].itemIds).toContain(result.clusters[0].coverFaceId);

    // Second cluster (Person B with 2 items)
    expect(result.clusters[1].itemIds).toHaveLength(2);
    expect(result.clusters[1].itemIds).toEqual(expect.arrayContaining(['face_b1', 'face_b2']));
    expect(result.clusters[1].coverFaceId).toBeDefined();

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

  it('never merges faces from the exact same photo (cannot-link constraint)', () => {
    // Two faces that have very close embeddings (e.g. distance = 0.05)
    // but they come from the EXACT same photo (photo_49)
    const f1 = new Float32Array([1, 0, 0]);
    const f2 = new Float32Array([0.99, 0.01, 0]);

    const items: FaceEmbeddingItem[] = [
      { id: 'f1', embedding: f1, photoId: 'photo_49' },
      { id: 'f2', embedding: f2, photoId: 'photo_49' },
    ];

    // Even with a very permissive threshold of 0.6, they must NOT merge!
    const result = clusterEmbeddings(items, 0.6, 2);
    expect(result.clusters).toHaveLength(0);
    expect(result.othersItemIds).toEqual(['f1', 'f2']);
  });
});

describe('clusterTripFaces (Domain Logic)', () => {
  it('excludes low-quality faces (quality_ok=0) and manual faces (assignment=manual)', () => {
    const embA1 = l2Normalize(new Float32Array([1, 0, 0]));
    const embA2 = l2Normalize(new Float32Array([0.98, 0.05, 0]));
    const embLowQ = l2Normalize(new Float32Array([0.97, 0.06, 0]));
    const embManual = l2Normalize(new Float32Array([1, 0, 0]));

    const faces = [
      {
        id: 'face_1',
        photo_id: 'p1',
        assignment: 'auto' as const,
        quality_ok: 1,
        embedding: embA1,
      },
      {
        id: 'face_2',
        photo_id: 'p2',
        assignment: 'auto' as const,
        quality_ok: 1,
        embedding: embA2,
      },
      {
        id: 'face_low_q',
        photo_id: 'p3',
        assignment: 'auto' as const,
        quality_ok: 0, // Should be excluded from cluster and routed to Others!
        embedding: embLowQ,
      },
      {
        id: 'face_manual',
        photo_id: 'p4',
        assignment: 'manual' as const, // Should be skipped and never reassigned!
        quality_ok: 1,
        embedding: embManual,
      },
    ];

    const result = clusterTripFaces(faces, { threshold: 0.35, minClusterSize: 2 });

    // face_1 and face_2 merge into 1 cluster
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].itemIds).toEqual(['face_1', 'face_2']);
    expect(result.clusters[0].coverFaceId).toBeDefined();

    // face_low_q goes to others
    expect(result.othersItemIds).toEqual(['face_low_q']);

    // face_manual is skipped
    expect(result.skippedManualFaceIds).toEqual(['face_manual']);
  });
});

describe('Trip Face Clustering Persistence (Task 2.5)', () => {
  const db = openDbSync(':memory:');
  const TRIP_ID = 'trip_cluster_test_1';

  beforeEach(() => {
    (db as unknown as { _clear: () => void })._clear();
    runMigrationsSync(db);
  });

  function createTestEmbedding(x: number, y: number, z: number): Uint8Array {
    const floats = new Float32Array(128);
    floats[0] = x;
    floats[1] = y;
    floats[2] = z;
    const norm = l2Normalize(floats);
    return embeddingToBlob(norm);
  }

  function createTestPhotos(count: number): PhotoRow[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `photo_${i + 1}`,
      trip_id: TRIP_ID,
      taken_at: 1700000000000 + i * 60000,
      modified_at: 1700000000000 + i * 60000,
      width: 1920,
      height: 1080,
      lat: null,
      lng: null,
      is_local: 1,
      scan_status: 'done',
      face_count: 1,
      excluded: 0,
    }));
  }

  it('clusters faces, creates people rows with centroids and cover faces, and updates faces.person_id', async () => {
    await createTrip({ id: TRIP_ID, name: 'Clustering Trip', start_at: 1000, end_at: 2000 }, db);
    await upsertPhotos(createTestPhotos(6), db);

    // 6 faces:
    // Person A: 3 faces (photo 1, 2, 3) with embeddings around [1, 0, 0]
    // Person B: 2 faces (photo 4, 5) with embeddings around [0, 1, 0]
    // Others: 1 face (photo 6) with outlier embedding around [0, 0, 1]
    const testFaces: FaceRow[] = [
      {
        id: 'f_a1',
        photo_id: 'photo_1',
        person_id: null,
        assignment: 'auto',
        bbox_x: 0.1,
        bbox_y: 0.1,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.95,
        quality_ok: 1,
        blur: 60,
        embedding: createTestEmbedding(0.98, 0.02, 0.01),
      },
      {
        id: 'f_a2',
        photo_id: 'photo_2',
        person_id: null,
        assignment: 'auto',
        bbox_x: 0.2,
        bbox_y: 0.2,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.92,
        quality_ok: 1,
        blur: 55,
        embedding: createTestEmbedding(0.97, 0.03, 0.01),
      },
      {
        id: 'f_a3',
        photo_id: 'photo_3',
        person_id: null,
        assignment: 'auto',
        bbox_x: 0.3,
        bbox_y: 0.3,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.90,
        quality_ok: 1,
        blur: 50,
        embedding: createTestEmbedding(0.99, 0.01, 0.02),
      },
      {
        id: 'f_b1',
        photo_id: 'photo_4',
        person_id: null,
        assignment: 'auto',
        bbox_x: 0.1,
        bbox_y: 0.1,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.94,
        quality_ok: 1,
        blur: 65,
        embedding: createTestEmbedding(0.01, 0.98, 0.02),
      },
      {
        id: 'f_b2',
        photo_id: 'photo_5',
        person_id: null,
        assignment: 'auto',
        bbox_x: 0.2,
        bbox_y: 0.2,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.91,
        quality_ok: 1,
        blur: 58,
        embedding: createTestEmbedding(0.02, 0.97, 0.01),
      },
      {
        id: 'f_c1',
        photo_id: 'photo_6',
        person_id: null,
        assignment: 'auto',
        bbox_x: 0.1,
        bbox_y: 0.1,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.88,
        quality_ok: 1,
        blur: 45,
        embedding: createTestEmbedding(0.01, 0.02, 0.99),
      },
    ];

    await insertFaces(testFaces, db);

    const result = await clusterAndPersistTripFaces(TRIP_ID, {}, db);

    expect(result.clustersCreated).toBe(2);
    expect(result.facesClustered).toBe(5); // 3 for Person A + 2 for Person B
    expect(result.othersFacesCount).toBe(1); // 1 single face in Others
    expect(result.people).toHaveLength(2);
    expect(result.othersPerson).toBeDefined();
    expect(result.othersPerson.is_others).toBe(1);

    // Verify people in DB
    const dbPeople = await getPeopleByTripId(TRIP_ID, db);
    // 2 clusters + 1 Others person = 3 people
    expect(dbPeople).toHaveLength(3);

    const personA = dbPeople.find((p) => p.is_others === 0 && p.cover_face_id?.startsWith('f_a'));
    const personB = dbPeople.find((p) => p.is_others === 0 && p.cover_face_id?.startsWith('f_b'));
    const others = dbPeople.find((p) => p.is_others === 1);

    expect(personA).toBeDefined();
    expect(personA?.centroid).toBeDefined();
    expect(personA?.centroid?.byteLength).toBe(512); // 128 floats * 4 bytes

    expect(personB).toBeDefined();
    expect(personB?.centroid).toBeDefined();
    expect(personB?.centroid?.byteLength).toBe(512);

    expect(others).toBeDefined();
    expect(others?.name).toBe('Others');

    // Verify face rows in DB have updated person_id
    const dbFaces = await getFacesByTripId(TRIP_ID, {}, db);
    const facesA = dbFaces.filter((f) => f.id.startsWith('f_a'));
    for (const f of facesA) {
      expect(f.person_id).toBe(personA?.id);
      expect(f.assignment).toBe('auto');
    }

    const facesB = dbFaces.filter((f) => f.id.startsWith('f_b'));
    for (const f of facesB) {
      expect(f.person_id).toBe(personB?.id);
      expect(f.assignment).toBe('auto');
    }

    const faceC = dbFaces.find((f) => f.id === 'f_c1');
    expect(faceC?.person_id).toBe(others?.id);

    // Verify trip scan_status is 'scanned'
    const trip = await getTripById(TRIP_ID, db);
    expect(trip?.scan_status).toBe('scanned');
  });

  it('routes low-quality faces (quality_ok = 0) to Others and preserves manual face assignments', async () => {
    await createTrip({ id: TRIP_ID, name: 'Quality and Manual Trip', start_at: 1000, end_at: 2000 }, db);
    await upsertPhotos(createTestPhotos(4), db);

    // Pre-create an existing named person for a manually assigned face
    const manualPerson = await createPerson(
      {
        id: 'manual_person_1',
        trip_id: TRIP_ID,
        name: 'Alice',
        is_others: 0,
      },
      db
    );

    const testFaces: FaceRow[] = [
      // Cluster of 2 high quality faces
      {
        id: 'f_norm_1',
        photo_id: 'photo_1',
        person_id: null,
        assignment: 'auto',
        bbox_x: 0.1,
        bbox_y: 0.1,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.95,
        quality_ok: 1,
        blur: 70,
        embedding: createTestEmbedding(0.99, 0.01, 0.0),
      },
      {
        id: 'f_norm_2',
        photo_id: 'photo_2',
        person_id: null,
        assignment: 'auto',
        bbox_x: 0.2,
        bbox_y: 0.2,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.92,
        quality_ok: 1,
        blur: 65,
        embedding: createTestEmbedding(0.98, 0.02, 0.0),
      },
      // Low-quality face: quality_ok = 0 -> must go to Others
      {
        id: 'f_blurry',
        photo_id: 'photo_3',
        person_id: null,
        assignment: 'auto',
        bbox_x: 0.1,
        bbox_y: 0.1,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.6,
        quality_ok: 0,
        blur: 15,
        embedding: createTestEmbedding(0.99, 0.01, 0.0),
      },
      // Manual pinned face: assignment = 'manual' -> must not be changed
      {
        id: 'f_pinned',
        photo_id: 'photo_4',
        person_id: manualPerson.id,
        assignment: 'manual',
        bbox_x: 0.1,
        bbox_y: 0.1,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.9,
        quality_ok: 1,
        blur: 80,
        embedding: createTestEmbedding(0.99, 0.01, 0.0),
      },
    ];

    await insertFaces(testFaces, db);

    const result = await clusterAndPersistTripFaces(TRIP_ID, {}, db);

    expect(result.clustersCreated).toBe(1);
    expect(result.facesClustered).toBe(2);
    expect(result.othersFacesCount).toBe(1); // Low quality face in Others
    expect(result.skippedManualFacesCount).toBe(1); // Manual face skipped

    // Verify pinned face is unchanged
    const allFaces = await getFacesByTripId(TRIP_ID, {}, db);
    const pinnedFace = allFaces.find((f) => f.id === 'f_pinned');
    expect(pinnedFace?.person_id).toBe(manualPerson.id);
    expect(pinnedFace?.assignment).toBe('manual');

    // Verify low quality face is in Others
    const blurryFace = allFaces.find((f) => f.id === 'f_blurry');
    expect(blurryFace?.person_id).toBe(result.othersPerson.id);

    // Verify named person 'Alice' was preserved
    const people = await getPeopleByTripId(TRIP_ID, db);
    const alice = people.find((p) => p.name === 'Alice');
    expect(alice).toBeDefined();
  });

  it('handles empty trip with 0 faces gracefully', async () => {
    await createTrip({ id: TRIP_ID, name: 'Empty Faces Trip', start_at: 1000, end_at: 2000 }, db);
    const result = await clusterAndPersistTripFaces(TRIP_ID, {}, db);
    expect(result.clustersCreated).toBe(0);
    expect(result.facesClustered).toBe(0);
    expect(result.othersPerson).toBeDefined();

    const trip = await getTripById(TRIP_ID, db);
    expect(trip?.scan_status).toBe('scanned');
  });

  it('throws error when trip does not exist', async () => {
    await expect(
      clusterAndPersistTripFaces('non-existent-trip-id', {}, db)
    ).rejects.toThrow('Trip with ID "non-existent-trip-id" not found');
  });

  it('persists pre-calculated clustering result using persistTripClusters', async () => {
    await createTrip({ id: TRIP_ID, name: 'Direct Persist Trip', start_at: 1000, end_at: 2000 }, db);
    await upsertPhotos(createTestPhotos(2), db);

    const testFaces: FaceRow[] = [
      {
        id: 'direct_f1',
        photo_id: 'photo_1',
        person_id: null,
        assignment: 'auto',
        bbox_x: 0.1,
        bbox_y: 0.1,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.95,
        quality_ok: 1,
        blur: 70,
        embedding: createTestEmbedding(1, 0, 0),
      },
      {
        id: 'direct_f2',
        photo_id: 'photo_2',
        person_id: null,
        assignment: 'auto',
        bbox_x: 0.2,
        bbox_y: 0.2,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.92,
        quality_ok: 1,
        blur: 65,
        embedding: createTestEmbedding(0.99, 0.01, 0),
      },
    ];
    await insertFaces(testFaces, db);

    const clusteringRes = {
      clusters: [
        {
          id: 'person_1',
          itemIds: ['direct_f1', 'direct_f2'],
          centroid: new Float32Array(128).fill(1 / Math.sqrt(128)),
          coverFaceId: 'direct_f1',
        },
      ],
      othersItemIds: [],
      skippedManualFaceIds: [],
    };

    const res = await persistTripClusters(TRIP_ID, clusteringRes, db);
    expect(res.clustersCreated).toBe(1);
    expect(res.facesClustered).toBe(2);
    expect(res.people).toHaveLength(1);
    expect(res.people[0].cover_face_id).toBe('direct_f1');
  });
});
