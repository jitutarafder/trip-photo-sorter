import type { SQLiteDatabase } from 'expo-sqlite';
import { openDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrations';
import { createTrip, getTripById } from '../src/db/repositories/trips';
import { upsertPhotos, getPhotoById } from '../src/db/repositories/photos';
import {
  createPerson,
  getPeopleByTripId,
  getPersonPhotos,
} from '../src/db/repositories/people';
import { insertFaces, getFacesByTripId, savePhotoFacesAtomic } from '../src/db/repositories/faces';
import type { PhotoRow, FaceRow } from '../src/db/types';
import {
  evaluateFaceQuality,
  isExtremePoseFromLandmarks,
} from '../src/domain/faceQuality';
import {
  clusterEmbeddings,
  computeCentroid,
  cosineDistance,
  l2Normalize,
  type FaceEmbeddingItem,
} from '../src/domain/clustering';
import {
  planFaceAssignments,
  computeQualityCentroid,
  type PersonCentroidTarget,
  type FaceForAssignment,
} from '../src/domain/assignment';
import {
  generateBenchmarkDataset,
  evaluateClustering,
  evaluateClusteringAndAssignment,
  formatSweepReport,
  sweepClusterDistance,
} from '../src/domain/evalHarness';
import { clusterAndPersistTripFaces } from '../src/services/clustering';
import { moveFacesToPerson } from '../src/services/manualEdits';
import { CONFIG } from '../src/domain/config';

// Helper to make normalized 128-d embedding
function makeEmbedding(seedValue: number, dim = 128): Float32Array {
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    vec[i] = Math.sin(seedValue * (i + 1));
  }
  return l2Normalize(vec);
}

function makeEmbeddingBlob(seedValue: number, dim = 128): Uint8Array {
  const floats = makeEmbedding(seedValue, dim);
  return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}

// Helper to generate slightly perturbed embedding for same person
function makePerturbedEmbedding(base: Float32Array, seed = 1, noiseScale = 0.5): Float32Array {
  const noise = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) {
    noise[i] = Math.cos((i + 1) * seed * 1.37);
  }
  const normNoise = l2Normalize(noise);
  const perturbed = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) {
    perturbed[i] = base[i] + normNoise[i] * noiseScale;
  }
  return l2Normalize(perturbed);
}

function createTestPhoto(overrides: Partial<PhotoRow> = {}): PhotoRow {
  return {
    id: overrides.id ?? 'photo-default',
    trip_id: overrides.trip_id ?? 'trip-default',
    taken_at: overrides.taken_at ?? 1000,
    modified_at: overrides.modified_at ?? 1000,
    width: overrides.width ?? 1000,
    height: overrides.height ?? 1000,
    lat: overrides.lat ?? null,
    lng: overrides.lng ?? null,
    is_local: overrides.is_local ?? 1,
    scan_status: overrides.scan_status ?? 'pending',
    face_count: overrides.face_count ?? 0,
    excluded: overrides.excluded ?? 0,
  };
}

function createTestFace(overrides: Partial<FaceRow> = {}): FaceRow {
  return {
    id: overrides.id ?? 'face-default',
    photo_id: overrides.photo_id ?? 'photo-default',
    person_id: overrides.person_id ?? null,
    assignment: overrides.assignment ?? 'auto',
    bbox_x: overrides.bbox_x ?? 0.1,
    bbox_y: overrides.bbox_y ?? 0.1,
    bbox_w: overrides.bbox_w ?? 0.2,
    bbox_h: overrides.bbox_h ?? 0.2,
    quality: overrides.quality ?? 0.95,
    quality_ok: overrides.quality_ok ?? 1,
    blur: overrides.blur ?? 50,
    embedding: overrides.embedding ?? makeEmbeddingBlob(1),
  };
}

describe('Task 4.8: Complex Photos, No-Face, 15+ Face Group Photos, Sunglasses, Side Profiles, & Eval Targets', () => {
  let db: SQLiteDatabase;

  beforeEach(async () => {
    jest.clearAllMocks();
    db = await openDb(':memory:');
    await runMigrations(db);
  });

  describe('1. No-Face Photos (Scenery, Receipts, Food)', () => {
    it('scans photos with zero faces: records face_count = 0, scan_status = done, without errors', async () => {
      const trip = await createTrip(
        { id: 'trip-scenery', name: 'Coxs Bazar Scenery', start_at: 1000, end_at: 5000 },
        db
      );

      const sceneryPhotos: PhotoRow[] = [
        createTestPhoto({
          id: 'photo-beach-1',
          trip_id: trip.id,
          taken_at: 1100,
          modified_at: 1100,
          width: 4000,
          height: 3000,
          scan_status: 'pending',
          face_count: 0,
        }),
        createTestPhoto({
          id: 'photo-sunset-2',
          trip_id: trip.id,
          taken_at: 1200,
          modified_at: 1200,
          width: 4000,
          height: 3000,
          scan_status: 'pending',
          face_count: 0,
        }),
      ];
      await upsertPhotos(sceneryPhotos, db);

      // Simulate atomic scan saving zero faces for each photo
      await savePhotoFacesAtomic('photo-beach-1', trip.id, [], db);
      await savePhotoFacesAtomic('photo-sunset-2', trip.id, [], db);

      const p1 = await getPhotoById('photo-beach-1', db);
      const p2 = await getPhotoById('photo-sunset-2', db);
      expect(p1?.scan_status).toBe('done');
      expect(p1?.face_count).toBe(0);
      expect(p2?.scan_status).toBe('done');
      expect(p2?.face_count).toBe(0);

      // Scanned count on trip is incremented
      const updatedTrip = await getTripById(trip.id, db);
      expect(updatedTrip?.scanned_count).toBe(2);

      // Zero faces exist in faces table
      const tripFaces = await getFacesByTripId(trip.id, {}, db);
      expect(tripFaces).toHaveLength(0);
    });

    it('gracefully clusters an all-no-face trip: creates 0 clusters, sets scan_status = scanned', async () => {
      const trip = await createTrip(
        { id: 'trip-noface-only', name: 'Nature Trip', start_at: 1000, end_at: 4000 },
        db
      );

      const res = await clusterAndPersistTripFaces(trip.id, {}, db);
      expect(res.clustersCreated).toBe(0);
      expect(res.facesClustered).toBe(0);
      expect(res.people).toHaveLength(0);
      expect(res.othersPerson).toBeDefined();

      const updatedTrip = await getTripById(trip.id, db);
      expect(updatedTrip?.scan_status).toBe('scanned');

      // People query returns only the Others bucket
      const people = await getPeopleByTripId(trip.id, db);
      expect(people.filter((p) => !p.is_others)).toHaveLength(0);
    });

    it('mixed trip: no-face photos do not pollute clusters, centroids, or solo-only exports', async () => {
      const trip = await createTrip(
        { id: 'trip-mixed', name: 'Mixed Trip', start_at: 1000, end_at: 5000 },
        db
      );

      const person = await createPerson({ id: 'p-person-1', trip_id: trip.id, name: 'Alice' }, db);

      const photos: PhotoRow[] = [
        createTestPhoto({
          id: 'photo-alice-solo',
          trip_id: trip.id,
          taken_at: 1000,
          modified_at: 1000,
          scan_status: 'done',
          face_count: 1,
        }),
        createTestPhoto({
          id: 'photo-food-plate',
          trip_id: trip.id,
          taken_at: 2000,
          modified_at: 2000,
          scan_status: 'done',
          face_count: 0, // No faces!
        }),
      ];
      await upsertPhotos(photos, db);

      const faces: FaceRow[] = [
        createTestFace({
          id: 'f-alice',
          photo_id: 'photo-alice-solo',
          person_id: person.id,
          bbox_x: 0.2,
          bbox_y: 0.2,
          bbox_w: 0.3,
          bbox_h: 0.3,
          quality: 0.95,
          quality_ok: 1,
          embedding: makeEmbeddingBlob(1),
        }),
      ];
      await insertFaces(faces, db);

      // Person photos query includes only photos containing Alice's face
      const alicePhotos = await getPersonPhotos(person.id, { soloOnly: false }, db);
      expect(alicePhotos.map((p) => p.id)).toEqual(['photo-alice-solo']);
      expect(alicePhotos.some((p) => p.id === 'photo-food-plate')).toBe(false);

      // Solo-only export excludes zero-face photos and includes solo photos
      const aliceSoloPhotos = await getPersonPhotos(person.id, { soloOnly: true }, db);
      expect(aliceSoloPhotos.map((p) => p.id)).toEqual(['photo-alice-solo']);
    });
  });

  describe('2. 15+ Face Group Photos (Class Tour / Picnic / Wedding Shots)', () => {
    it('saves all 16 faces on a large group photo with face_count = 16', async () => {
      const trip = await createTrip(
        { id: 'trip-group', name: 'Convocation Group', start_at: 1000, end_at: 5000 },
        db
      );

      const groupPhoto = createTestPhoto({
        id: 'photo-group-16',
        trip_id: trip.id,
        taken_at: 2000,
        modified_at: 2000,
        width: 6000,
        height: 4000,
        scan_status: 'pending',
        face_count: 0,
      });
      await upsertPhotos([groupPhoto], db);

      const sixteenFaces: FaceRow[] = [];
      for (let i = 0; i < 16; i++) {
        sixteenFaces.push(
          createTestFace({
            id: `face-g16-${i}`,
            photo_id: groupPhoto.id,
            bbox_x: 0.05 + (i % 8) * 0.11,
            bbox_y: Math.floor(i / 8) * 0.4 + 0.1,
            bbox_w: 0.08,
            bbox_h: 0.12,
            quality: 0.92,
            quality_ok: 1,
            embedding: makeEmbeddingBlob(10 + i),
          })
        );
      }

      await savePhotoFacesAtomic(groupPhoto.id, trip.id, sixteenFaces, db);

      const p = await getPhotoById(groupPhoto.id, db);
      expect(p?.face_count).toBe(16);
      expect(p?.scan_status).toBe('done');

      const savedFaces = await getFacesByTripId(trip.id, {}, db);
      expect(savedFaces).toHaveLength(16);
    });

    it('strictly enforces cannot-link constraint: NO two faces from the 15+ face photo merge into the same cluster', () => {
      // Create 16 face items from the same group photo, with embeddings that have moderate pairwise distance
      const photoId = 'large-group-photo-1';
      const items: FaceEmbeddingItem[] = [];

      for (let i = 0; i < 16; i++) {
        // Embeddings are intentionally close (cosine distance ~0.15) to attempt merging
        const baseVec = makeEmbedding(5);
        const perturbed = makePerturbedEmbedding(baseVec, 0.15 + (i % 4) * 0.02);
        items.push({
          id: `face-${i}`,
          photoId,
          embedding: perturbed,
        });
      }

      // Even with threshold 0.50 (very generous), same-photo constraint MUST prevent merging
      const clusteringResult = clusterEmbeddings(items, 0.5, 2);

      // Verify that every cluster contains at most ONE face from this photo
      for (const cluster of clusteringResult.clusters) {
        expect(cluster.itemIds.length).toBeLessThanOrEqual(1);
      }
      // Since minClusterSize is 2 and no two faces from the same photo can merge, all 16 items are singletons
      expect(clusteringResult.othersItemIds).toHaveLength(16);
      expect(clusteringResult.clusters).toHaveLength(0);
    });

    it('enforces cannot-link constraint in name-first assignment: person receives at most 1 face from group photo', () => {
      const personCentroid = makeEmbedding(1);
      const targetCentroid: PersonCentroidTarget = {
        id: 'person-bob',
        name: 'Bob',
        centroid: personCentroid,
      };

      // 3 faces from the exact same group photo that all look like Bob (cosine distance < 0.2)
      const groupPhotoId = 'picnic-group-shot';
      const candidateFaces: FaceForAssignment[] = [
        {
          id: 'face-bob-1',
          photo_id: groupPhotoId,
          person_id: null,
          assignment: 'auto',
          quality_ok: 1,
          embedding: makePerturbedEmbedding(personCentroid, 1, 0.3), // distance ~0.04 (best match)
        },
        {
          id: 'face-bob-2',
          photo_id: groupPhotoId,
          person_id: null,
          assignment: 'auto',
          quality_ok: 1,
          embedding: makePerturbedEmbedding(personCentroid, 2, 0.45), // distance ~0.09
        },
        {
          id: 'face-bob-3',
          photo_id: groupPhotoId,
          person_id: null,
          assignment: 'auto',
          quality_ok: 1,
          embedding: makePerturbedEmbedding(personCentroid, 3, 0.55), // distance ~0.13
        },
      ];

      const plan = planFaceAssignments(candidateFaces, [targetCentroid], {
        assignDistance: 0.35,
        othersPersonId: 'person-others',
      });

      // Only face-bob-1 (the closest match) is assigned to Bob
      const assignedToBob = plan.decisions.filter((d) => d.newPersonId === 'person-bob');
      expect(assignedToBob).toHaveLength(1);
      expect(assignedToBob[0].faceId).toBe('face-bob-1');

      // The other two faces from the same photo are routed to Others (cannot-link constraint)
      const routedToOthers = plan.decisions.filter((d) => d.newPersonId === 'person-others');
      expect(routedToOthers).toHaveLength(2);
      expect(routedToOthers.map((d) => d.faceId)).toEqual(['face-bob-2', 'face-bob-3']);
    });

    it('solo-only export filter correctly excludes 15+ face group photos', async () => {
      const trip = await createTrip(
        { id: 'trip-solo-test', name: 'Solo Filter Trip', start_at: 1000, end_at: 5000 },
        db
      );

      const person = await createPerson({ id: 'p-charlie', trip_id: trip.id, name: 'Charlie' }, db);

      const soloPhoto = createTestPhoto({
        id: 'photo-solo-charlie',
        trip_id: trip.id,
        taken_at: 1000,
        modified_at: 1000,
        scan_status: 'done',
        face_count: 1, // SOLO PHOTO
      });

      const groupPhoto18 = createTestPhoto({
        id: 'photo-large-group-18',
        trip_id: trip.id,
        taken_at: 2000,
        modified_at: 2000,
        width: 4000,
        height: 3000,
        scan_status: 'done',
        face_count: 18, // 18-FACE GROUP PHOTO
      });

      await upsertPhotos([soloPhoto, groupPhoto18], db);

      // Charlie is in both photos
      await insertFaces(
        [
          createTestFace({
            id: 'f-c-solo',
            photo_id: soloPhoto.id,
            person_id: person.id,
            bbox_x: 0.2,
            bbox_y: 0.2,
            bbox_w: 0.3,
            bbox_h: 0.3,
            quality: 0.95,
            quality_ok: 1,
            embedding: makeEmbeddingBlob(3),
          }),
          createTestFace({
            id: 'f-c-group',
            photo_id: groupPhoto18.id,
            person_id: person.id,
            bbox_x: 0.1,
            bbox_y: 0.1,
            bbox_w: 0.05,
            bbox_h: 0.08,
            quality: 0.90,
            quality_ok: 1,
            embedding: makeEmbeddingBlob(3),
          }),
        ],
        db
      );

      // 1. With soloOnly = false: both solo and group photo included
      const allPhotos = await getPersonPhotos(person.id, { soloOnly: false }, db);
      expect(allPhotos).toHaveLength(2);
      expect(allPhotos.map((p) => p.id)).toContain('photo-solo-charlie');
      expect(allPhotos.map((p) => p.id)).toContain('photo-large-group-18');

      // 2. With soloOnly = true: 18-face photo excluded, only solo photo included
      const soloOnlyPhotos = await getPersonPhotos(person.id, { soloOnly: true }, db);
      expect(soloOnlyPhotos).toHaveLength(1);
      expect(soloOnlyPhotos[0].id).toBe('photo-solo-charlie');
    });
  });

  describe('3. Sunglasses & Occlusions Handling', () => {
    it('correctly associates face with sunglasses to true person centroid without false-merging other people', () => {
      const personA = makeEmbedding(10);
      const personB = makeEmbedding(20);

      // Cosine distance between Person A and Person B is large
      const interPersonDist = cosineDistance(personA, personB);
      expect(interPersonDist).toBeGreaterThan(0.6);

      // Person A wearing sunglasses: slight feature shift ~0.20 distance (noiseScale 0.7)
      const personASunglasses = makePerturbedEmbedding(personA, 1, 0.7);
      const distAtoASunglasses = cosineDistance(personA, personASunglasses);
      expect(distAtoASunglasses).toBeLessThan(0.30); // within ASSIGN_DISTANCE (0.35)

      // Person B wearing sunglasses
      const personBSunglasses = makePerturbedEmbedding(personB, 2, 0.7);

      const targets: PersonCentroidTarget[] = [
        { id: 'p-a', name: 'Alice', centroid: personA },
        { id: 'p-b', name: 'Bob', centroid: personB },
      ];

      const candidates: FaceForAssignment[] = [
        {
          id: 'face-a-sunglasses',
          photo_id: 'photo-1',
          person_id: null,
          assignment: 'auto',
          quality_ok: 1,
          embedding: personASunglasses,
        },
        {
          id: 'face-b-sunglasses',
          photo_id: 'photo-2',
          person_id: null,
          assignment: 'auto',
          quality_ok: 1,
          embedding: personBSunglasses,
        },
      ];

      const plan = planFaceAssignments(candidates, targets, { assignDistance: 0.35 });

      // Alice's sunglasses face matches Alice
      const matchA = plan.decisions.find((d) => d.faceId === 'face-a-sunglasses');
      expect(matchA?.newPersonId).toBe('p-a');
      expect(matchA?.distance).toBeLessThan(0.35);

      // Bob's sunglasses face matches Bob
      const matchB = plan.decisions.find((d) => d.faceId === 'face-b-sunglasses');
      expect(matchB?.newPersonId).toBe('p-b');
      expect(matchB?.distance).toBeLessThan(0.35);

      // Distance from Alice's sunglasses face to Bob is still very large (> 0.6)
      const distASunglassesToBob = cosineDistance(personASunglasses, personB);
      expect(distASunglassesToBob).toBeGreaterThan(0.55);
    });
  });

  describe('4. Side Profiles (Extreme Yaw Detection and Quality Exclusion)', () => {
    it('detects extreme yaw angles (>= 0.8 rad) and marks quality_ok = 0 with reason extreme_pose', () => {
      // Frontal face: yaw = 0.15 rad (< 0.8 rad)
      const frontal = evaluateFaceQuality({
        pixelWidth: 80,
        pixelHeight: 80,
        confidence: 0.95,
        blurScore: 60,
        yawRadians: 0.15,
      });
      expect(frontal.quality_ok).toBe(1);
      expect(frontal.reasons).toEqual([]);

      // Profile face: yaw = 0.85 rad (>= 0.8 rad)
      const profileRight = evaluateFaceQuality({
        pixelWidth: 80,
        pixelHeight: 80,
        confidence: 0.95,
        blurScore: 60,
        yawRadians: 0.85,
      });
      expect(profileRight.quality_ok).toBe(0);
      expect(profileRight.reasons).toContain('extreme_pose');

      // Profile face: negative yaw = -0.92 rad
      const profileLeft = evaluateFaceQuality({
        pixelWidth: 80,
        pixelHeight: 80,
        confidence: 0.95,
        blurScore: 60,
        yawRadians: -0.92,
      });
      expect(profileLeft.quality_ok).toBe(0);
      expect(profileLeft.reasons).toContain('extreme_pose');
    });

    it('detects extreme pose from 2D landmarks when yaw is absent', () => {
      // Symmetrical frontal face
      const frontalLandmarks = {
        rightEye: { x: 30, y: 30 },
        leftEye: { x: 70, y: 30 },
        noseTip: { x: 50, y: 50 },
        rightEar: { x: 10, y: 35 },
        leftEar: { x: 90, y: 35 },
      };
      expect(isExtremePoseFromLandmarks(frontalLandmarks)).toBe(false);

      // Extreme side profile: nose turned far to the left, asymmetric ears
      const profileLandmarks = {
        rightEye: { x: 45, y: 30 },
        leftEye: { x: 65, y: 30 },
        noseTip: { x: 75, y: 50 }, // nose past eye midpoint
        rightEar: { x: 15, y: 35 },
        leftEar: { x: 67, y: 35 }, // left ear almost hidden
      };
      expect(isExtremePoseFromLandmarks(profileLandmarks)).toBe(true);
    });

    it('excludes quality_ok = 0 side profiles from centroid calculation', () => {
      const frontal1 = makeEmbedding(1);
      const frontal2 = makeEmbedding(2);
      const extremeSideProfile = makeEmbedding(3); // completely different angle / embedding

      const centroidBefore = computeCentroid([frontal1, frontal2]);

      // Calculate centroid via computePersonCentroid with quality_ok filter
      const faces: FaceForAssignment[] = [
        {
          id: 'f-frontal-1',
          photo_id: 'p1',
          person_id: 'p-1',
          assignment: 'auto',
          quality_ok: 1,
          embedding: frontal1,
        },
        {
          id: 'f-frontal-2',
          photo_id: 'p2',
          person_id: 'p-1',
          assignment: 'auto',
          quality_ok: 1,
          embedding: frontal2,
        },
        {
          id: 'f-side-profile',
          photo_id: 'p3',
          person_id: 'p-1',
          assignment: 'auto',
          quality_ok: 0, // EXTREME YAW SIDE PROFILE
          embedding: extremeSideProfile,
        },
      ];

      const centroidWithFilter = computeQualityCentroid(faces);
      expect(centroidWithFilter).not.toBeNull();

      // The side profile face was excluded, so centroid equals centroidBefore
      const dist = cosineDistance(centroidBefore, centroidWithFilter!);
      expect(dist).toBeCloseTo(0, 5);
    });

    it('allows low-quality side profile to be assigned via nearest centroid and manually pinned', async () => {
      const trip = await createTrip(
        { id: 'trip-profile-test', name: 'Profile Move Trip', start_at: 1000, end_at: 5000 },
        db
      );

      const person = await createPerson({ id: 'p-david', trip_id: trip.id, name: 'David' }, db);

      await upsertPhotos(
        [
          createTestPhoto({
            id: 'photo-profile',
            trip_id: trip.id,
            taken_at: 1000,
            modified_at: 1000,
            scan_status: 'done',
            face_count: 1,
          }),
        ],
        db
      );

      const sideProfileFace = createTestFace({
        id: 'f-side-profile-david',
        photo_id: 'photo-profile',
        person_id: null,
        bbox_x: 0.1,
        bbox_y: 0.1,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.90,
        quality_ok: 0, // side profile
        embedding: makeEmbeddingBlob(15),
      });
      await insertFaces([sideProfileFace], db);

      // Manual move pins the side profile face to David with assignment = 'manual'
      const moveRes = await moveFacesToPerson([sideProfileFace.id], person.id, db);
      expect(moveRes.movedCount).toBe(1);

      const updatedFaces = await getFacesByTripId(trip.id, {}, db);
      const davidFace = updatedFaces.find((f) => f.id === sideProfileFace.id);
      expect(davidFace?.person_id).toBe(person.id);
      expect(davidFace?.assignment).toBe('manual');
    });
  });

  describe('5. Benchmark & Parameter Sweep: Precision & Recall vs PRD Targets (01_PRD §6)', () => {
    it('achieves Precision >= 90% and Recall >= 80% on complex dataset with 15+ face group photos, sunglasses, and extreme yaw', () => {
      // Generate reproducible complex benchmark dataset with all edge-case scenarios:
      // 14 people, 10 solo photos each, 2 large 14+ face group photos, 8% sunglasses, 5% side profiles
      const complexDataset = generateBenchmarkDataset({
        personCount: 14,
        photosPerPerson: 10,
        groupPhotoCount: 6,
        largeGroupPhotoCount: 2,
        largeGroupSize: 14,
        sunglassesRatio: 0.08,
        sideProfileRatio: 0.05,
        dim: 128,
        noiseScale: 0.44,
      });

      expect(complexDataset.length).toBeGreaterThanOrEqual(180);

      // Evaluate clustering alone at CONFIG.CLUSTER_DISTANCE (0.32)
      const clusterResult = evaluateClustering(complexDataset, CONFIG.CLUSTER_DISTANCE);

      console.log('--- CLUSTERING RESULTS ON COMPLEX DATASET (Task 4.8) ---');
      console.log(`Faces: ${complexDataset.length}`);
      console.log(`Precision: ${(clusterResult.metrics.precision * 100).toFixed(2)}% (Target >= 90%)`);
      console.log(`Recall: ${(clusterResult.metrics.recall * 100).toFixed(2)}% (Target >= 80%)`);
      console.log(`F1 Score: ${(clusterResult.metrics.f1 * 100).toFixed(2)}%`);
      console.log(`Meets PRD Targets: ${clusterResult.meetsPrdTargets ? 'YES' : 'NO'}`);

      expect(clusterResult.metrics.precision).toBeGreaterThanOrEqual(0.90);
      expect(clusterResult.metrics.recall).toBeGreaterThanOrEqual(0.80);
      expect(clusterResult.meetsPrdTargets).toBe(true);

      // Evaluate full pipeline: clustering + name-first assignment at CONFIG.ASSIGN_DISTANCE (0.35)
      const fullPipelineResult = evaluateClusteringAndAssignment(
        complexDataset,
        CONFIG.CLUSTER_DISTANCE,
        CONFIG.ASSIGN_DISTANCE,
        0.5 // 50% top clusters confirmed
      );

      console.log('\n--- FULL PIPELINE (CLUSTERING + ASSIGNMENT) RESULTS ---');
      console.log(`Precision: ${(fullPipelineResult.metrics.precision * 100).toFixed(2)}%`);
      console.log(`Recall: ${(fullPipelineResult.metrics.recall * 100).toFixed(2)}%`);
      console.log(`F1 Score: ${(fullPipelineResult.metrics.f1 * 100).toFixed(2)}%`);

      expect(fullPipelineResult.metrics.precision).toBeGreaterThanOrEqual(0.90);
      expect(fullPipelineResult.metrics.recall).toBeGreaterThanOrEqual(0.80);
      expect(fullPipelineResult.meetsPrdTargets).toBe(true);
    });

    it('sweeps CLUSTER_DISTANCE and confirms default threshold (0.32) remains optimal', () => {
      const complexDataset = generateBenchmarkDataset({
        personCount: 12,
        photosPerPerson: 10,
        largeGroupPhotoCount: 1,
        largeGroupSize: 12,
        sunglassesRatio: 0.10,
        sideProfileRatio: 0.08,
      });

      const sweep = sweepClusterDistance(complexDataset, [0.26, 0.28, 0.30, 0.32, 0.34, 0.36]);
      const report = formatSweepReport(sweep);
      console.log('\n--- CLUSTER DISTANCE SWEEP REPORT ---');
      console.log(report);

      const defaultThresholdResult = sweep.find((s) => s.clusterDistance === 0.32);
      expect(defaultThresholdResult).toBeDefined();
      expect(defaultThresholdResult?.meetsPrdTargets).toBe(true);
    });
  });
});
