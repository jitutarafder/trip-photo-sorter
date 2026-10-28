import { openDbSync } from '../src/db/client';
import { runMigrationsSync } from '../src/db/migrations';
import { createTrip } from '../src/db/repositories/trips';
import { upsertPhotos } from '../src/db/repositories/photos';
import { insertFaces, getFacesByTripId, getFaceById } from '../src/db/repositories/faces';
import {
  createPerson,
  getPersonById,
  excludePhotoFromPerson,
  getExcludedPhotoIdsForPerson,
} from '../src/db/repositories/people';
import type { PhotoRow, FaceRow } from '../src/db/types';
import {
  moveFacesToPerson,
  moveFaceToPerson,
  removeFacesFromPerson,
  removeFaceFromPerson,
  mergePeople,
} from '../src/services/manualEdits';
import { clusterAndPersistTripFaces } from '../src/services/clustering';
import {
  l2Normalize,
  embeddingToBlob,
  blobToEmbedding,
} from '../src/domain/clustering';

describe('Manual Edits Service (Task 2.7)', () => {
  const db = openDbSync(':memory:');
  const TRIP_ID = 'trip_manual_edits_1';

  beforeEach(() => {
    (db as unknown as { _clear: () => void })._clear();
    runMigrationsSync(db);
  });

  function makeEmbBlob(x: number, y: number, z: number): Uint8Array {
    const f = new Float32Array(128);
    f[0] = x;
    f[1] = y;
    f[2] = z;
    return embeddingToBlob(l2Normalize(f));
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

  describe('moveFacesToPerson & moveFaceToPerson', () => {
    it('moves a face to target person, sets assignment=manual, and recomputes centroids', async () => {
      await createTrip({ id: TRIP_ID, name: 'Move Trip', start_at: 1000, end_at: 2000 }, db);
      await upsertPhotos(createTestPhotos(4), db);

      // Person A: has face_1 [1, 0, 0] and face_2 [0.99, 0.01, 0]
      const personA = await createPerson(
        {
          id: 'person_a',
          trip_id: TRIP_ID,
          name: 'Alice',
          centroid: makeEmbBlob(1, 0, 0),
        },
        db
      );

      // Person B: has face_3 [0, 1, 0]
      const personB = await createPerson(
        {
          id: 'person_b',
          trip_id: TRIP_ID,
          name: 'Bob',
          centroid: makeEmbBlob(0, 1, 0),
        },
        db
      );

      const testFaces: FaceRow[] = [
        {
          id: 'face_1',
          photo_id: 'photo_1',
          person_id: personA.id,
          assignment: 'auto',
          bbox_x: 0.1,
          bbox_y: 0.1,
          bbox_w: 0.2,
          bbox_h: 0.2,
          quality: 0.95,
          quality_ok: 1,
          blur: 60,
          embedding: makeEmbBlob(1, 0, 0),
        },
        {
          id: 'face_2',
          photo_id: 'photo_2',
          person_id: personA.id,
          assignment: 'auto',
          bbox_x: 0.2,
          bbox_y: 0.2,
          bbox_w: 0.2,
          bbox_h: 0.2,
          quality: 0.92,
          quality_ok: 1,
          blur: 55,
          embedding: makeEmbBlob(0, 1, 0), // Wrongly placed in Alice, actually belongs to Bob!
        },
        {
          id: 'face_3',
          photo_id: 'photo_3',
          person_id: personB.id,
          assignment: 'auto',
          bbox_x: 0.3,
          bbox_y: 0.3,
          bbox_w: 0.2,
          bbox_h: 0.2,
          quality: 0.90,
          quality_ok: 1,
          blur: 50,
          embedding: makeEmbBlob(0, 0.98, 0.02),
        },
      ];

      await insertFaces(testFaces, db);

      // Act: Move face_2 from Alice to Bob
      const result = await moveFaceToPerson('face_2', personB.id, db);

      expect(result.movedCount).toBe(1);
      expect(result.affectedPersonIds).toContain(personA.id);

      // Verify face_2 is now in Bob and pinned (assignment='manual')
      const face2 = await getFaceById('face_2', db);
      expect(face2?.person_id).toBe(personB.id);
      expect(face2?.assignment).toBe('manual');

      // Verify Alice's centroid was recomputed (now only contains face_1 [1, 0, 0])
      const updatedAlice = await getPersonById(personA.id, db);
      expect(updatedAlice?.centroid).toBeDefined();
      if (updatedAlice?.centroid) {
        const aliceCentroid = blobToEmbedding(updatedAlice.centroid);
        expect(aliceCentroid[0]).toBeCloseTo(1.0, 5);
        expect(aliceCentroid[1]).toBeCloseTo(0.0, 5);
      }

      // Verify Bob's centroid was recomputed (combined face_2 and face_3)
      const updatedBob = await getPersonById(personB.id, db);
      expect(updatedBob?.centroid).toBeDefined();
      if (updatedBob?.centroid) {
        const bobCentroid = blobToEmbedding(updatedBob.centroid);
        expect(bobCentroid[1]).toBeGreaterThan(0.9);
      }
    });

    it('sets cover_face_id if target person has no cover face', async () => {
      await createTrip({ id: TRIP_ID, name: 'Cover Move Trip', start_at: 1000, end_at: 2000 }, db);
      await upsertPhotos(createTestPhotos(1), db);

      const target = await createPerson(
        { id: 'p_no_cover', trip_id: TRIP_ID, name: null, cover_face_id: null },
        db
      );

      const faceRow: FaceRow = {
        id: 'f_cover_move',
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
        embedding: makeEmbBlob(1, 0, 0),
      };
      await insertFaces([faceRow], db);

      const res = await moveFaceToPerson('f_cover_move', target.id, db);
      expect(res.targetPerson.cover_face_id).toBe('f_cover_move');

      const dbTarget = await getPersonById(target.id, db);
      expect(dbTarget?.cover_face_id).toBe('f_cover_move');
    });

    it('handles batch face moves to person', async () => {
      await createTrip({ id: TRIP_ID, name: 'Batch Move Trip', start_at: 1000, end_at: 2000 }, db);
      await upsertPhotos(createTestPhotos(3), db);

      const target = await createPerson({ id: 'p_batch', trip_id: TRIP_ID, name: 'Batch Target' }, db);

      const faces: FaceRow[] = [
        {
          id: 'bf_1',
          photo_id: 'photo_1',
          person_id: null,
          assignment: 'auto',
          bbox_x: 0.1,
          bbox_y: 0.1,
          bbox_w: 0.2,
          bbox_h: 0.2,
          quality: 0.9,
          quality_ok: 1,
          blur: 50,
          embedding: makeEmbBlob(1, 0, 0),
        },
        {
          id: 'bf_2',
          photo_id: 'photo_2',
          person_id: null,
          assignment: 'auto',
          bbox_x: 0.2,
          bbox_y: 0.2,
          bbox_w: 0.2,
          bbox_h: 0.2,
          quality: 0.9,
          quality_ok: 1,
          blur: 50,
          embedding: makeEmbBlob(0.98, 0.02, 0),
        },
      ];
      await insertFaces(faces, db);

      const res = await moveFacesToPerson(['bf_1', 'bf_2'], target.id, db);
      expect(res.movedCount).toBe(2);

      const f1 = await getFaceById('bf_1', db);
      const f2 = await getFaceById('bf_2', db);
      expect(f1?.person_id).toBe(target.id);
      expect(f1?.assignment).toBe('manual');
      expect(f2?.person_id).toBe(target.id);
      expect(f2?.assignment).toBe('manual');
    });

    it('throws error when target person is not found', async () => {
      await expect(
        moveFaceToPerson('f_test', 'non-existent-person', db)
      ).rejects.toThrow('Target person non-existent-person not found');
    });
  });

  describe('removeFacesFromPerson & removeFaceFromPerson', () => {
    it('removes a face from person to Others, sets assignment=manual, and recomputes centroid', async () => {
      await createTrip({ id: TRIP_ID, name: 'Remove Trip', start_at: 1000, end_at: 2000 }, db);
      await upsertPhotos(createTestPhotos(2), db);

      const person = await createPerson(
        {
          id: 'person_rem',
          trip_id: TRIP_ID,
          name: 'Charlie',
          centroid: makeEmbBlob(1, 0, 0),
        },
        db
      );

      const faces: FaceRow[] = [
        {
          id: 'rf_1',
          photo_id: 'photo_1',
          person_id: person.id,
          assignment: 'auto',
          bbox_x: 0.1,
          bbox_y: 0.1,
          bbox_w: 0.2,
          bbox_h: 0.2,
          quality: 0.95,
          quality_ok: 1,
          blur: 60,
          embedding: makeEmbBlob(1, 0, 0),
        },
        {
          id: 'rf_2',
          photo_id: 'photo_2',
          person_id: person.id,
          assignment: 'auto',
          bbox_x: 0.2,
          bbox_y: 0.2,
          bbox_w: 0.2,
          bbox_h: 0.2,
          quality: 0.90,
          quality_ok: 1,
          blur: 55,
          embedding: makeEmbBlob(0, 1, 0), // Not Charlie! User wants to remove it
        },
      ];
      await insertFaces(faces, db);

      const result = await removeFaceFromPerson('rf_2', TRIP_ID, db);

      expect(result.removedCount).toBe(1);
      expect(result.othersPerson.is_others).toBe(1);

      // Verify rf_2 was moved to Others and pinned (assignment='manual')
      const rf2 = await getFaceById('rf_2', db);
      expect(rf2?.person_id).toBe(result.othersPerson.id);
      expect(rf2?.assignment).toBe('manual');

      // Verify Charlie's centroid was recomputed (now purely [1, 0, 0])
      const updatedCharlie = await getPersonById(person.id, db);
      expect(updatedCharlie?.centroid).toBeDefined();
      if (updatedCharlie?.centroid) {
        const charlieCentroid = blobToEmbedding(updatedCharlie.centroid);
        expect(charlieCentroid[0]).toBeCloseTo(1.0, 5);
        expect(charlieCentroid[1]).toBeCloseTo(0.0, 5);
      }
    });

    it('handles batch face removal from person', async () => {
      await createTrip({ id: TRIP_ID, name: 'Batch Remove Trip', start_at: 1000, end_at: 2000 }, db);
      await upsertPhotos(createTestPhotos(3), db);

      const person = await createPerson(
        { id: 'p_batch_rem', trip_id: TRIP_ID, name: 'Batch Remove Person' },
        db
      );

      const faces: FaceRow[] = [
        {
          id: 'brf_1',
          photo_id: 'photo_1',
          person_id: person.id,
          assignment: 'auto',
          bbox_x: 0.1,
          bbox_y: 0.1,
          bbox_w: 0.2,
          bbox_h: 0.2,
          quality: 0.9,
          quality_ok: 1,
          blur: 50,
          embedding: makeEmbBlob(1, 0, 0),
        },
        {
          id: 'brf_2',
          photo_id: 'photo_2',
          person_id: person.id,
          assignment: 'auto',
          bbox_x: 0.2,
          bbox_y: 0.2,
          bbox_w: 0.2,
          bbox_h: 0.2,
          quality: 0.9,
          quality_ok: 1,
          blur: 50,
          embedding: makeEmbBlob(0, 1, 0),
        },
      ];
      await insertFaces(faces, db);

      const result = await removeFacesFromPerson(['brf_1', 'brf_2'], TRIP_ID, db);
      expect(result.removedCount).toBe(2);

      const f1 = await getFaceById('brf_1', db);
      const f2 = await getFaceById('brf_2', db);
      expect(f1?.person_id).toBe(result.othersPerson.id);
      expect(f1?.assignment).toBe('manual');
      expect(f2?.person_id).toBe(result.othersPerson.id);
      expect(f2?.assignment).toBe('manual');
    });
  });

  describe('mergePeople', () => {
    it('merges source person into target person, transfers faces with assignment=manual, transfers exclusions, and recomputes centroid', async () => {
      await createTrip({ id: TRIP_ID, name: 'Merge People Trip', start_at: 1000, end_at: 2000 }, db);
      await upsertPhotos(createTestPhotos(3), db);

      const targetPerson = await createPerson(
        {
          id: 'target_p',
          trip_id: TRIP_ID,
          name: 'Sarah',
          centroid: makeEmbBlob(1, 0, 0),
        },
        db
      );

      const sourcePerson = await createPerson(
        {
          id: 'source_p',
          trip_id: TRIP_ID,
          name: null, // Unnamed cluster that is actually also Sarah
          centroid: makeEmbBlob(0.98, 0.02, 0),
        },
        db
      );

      const faces: FaceRow[] = [
        {
          id: 'mf_target',
          photo_id: 'photo_1',
          person_id: targetPerson.id,
          assignment: 'auto',
          bbox_x: 0.1,
          bbox_y: 0.1,
          bbox_w: 0.2,
          bbox_h: 0.2,
          quality: 0.95,
          quality_ok: 1,
          blur: 60,
          embedding: makeEmbBlob(1, 0, 0),
        },
        {
          id: 'mf_source_1',
          photo_id: 'photo_2',
          person_id: sourcePerson.id,
          assignment: 'auto',
          bbox_x: 0.2,
          bbox_y: 0.2,
          bbox_w: 0.2,
          bbox_h: 0.2,
          quality: 0.92,
          quality_ok: 1,
          blur: 55,
          embedding: makeEmbBlob(0.96, 0.04, 0),
        },
        {
          id: 'mf_source_2',
          photo_id: 'photo_3',
          person_id: sourcePerson.id,
          assignment: 'auto',
          bbox_x: 0.3,
          bbox_y: 0.3,
          bbox_w: 0.2,
          bbox_h: 0.2,
          quality: 0.90,
          quality_ok: 1,
          blur: 50,
          embedding: makeEmbBlob(0.97, 0.03, 0),
        },
      ];
      await insertFaces(faces, db);

      // Exclude photo_2 for source person
      await excludePhotoFromPerson(sourcePerson.id, 'photo_2', db);

      // Act: Merge sourcePerson into targetPerson
      const result = await mergePeople(targetPerson.id, sourcePerson.id, db);

      expect(result.mergedFacesCount).toBe(2);
      expect(result.targetPerson.id).toBe(targetPerson.id);
      expect(result.targetPerson.name).toBe('Sarah');

      // Verify all faces now belong to targetPerson with assignment='manual'
      const allFaces = await getFacesByTripId(TRIP_ID, {}, db);
      expect(allFaces).toHaveLength(3);
      for (const f of allFaces) {
        expect(f.person_id).toBe(targetPerson.id);
        expect(f.assignment).toBe('manual');
      }

      // Verify sourcePerson was deleted
      const checkSource = await getPersonById(sourcePerson.id, db);
      expect(checkSource).toBeNull();

      // Verify photo exclusion was transferred to targetPerson
      const excluded = await getExcludedPhotoIdsForPerson(targetPerson.id, db);
      expect(excluded).toContain('photo_2');

      // Verify targetPerson centroid was recomputed
      const updatedTarget = await getPersonById(targetPerson.id, db);
      expect(updatedTarget?.centroid).toBeDefined();
    });

    it('adopts source name if target person was unnamed', async () => {
      await createTrip({ id: TRIP_ID, name: 'Adopt Name Trip', start_at: 1000, end_at: 2000 }, db);
      const target = await createPerson({ id: 'p_unnamed_target', trip_id: TRIP_ID, name: null }, db);
      const source = await createPerson({ id: 'p_named_source', trip_id: TRIP_ID, name: 'David' }, db);

      const res = await mergePeople(target.id, source.id, db);
      expect(res.targetPerson.name).toBe('David');

      const dbTarget = await getPersonById(target.id, db);
      expect(dbTarget?.name).toBe('David');
    });

    it('rejects merging a person into themselves', async () => {
      await expect(
        mergePeople('same_id', 'same_id', db)
      ).rejects.toThrow('Cannot merge a person into themselves');
    });
  });

  describe('Rescan & Re-clustering Immunity for Manual Edits (TRD §4)', () => {
    it('ensures manual pinned faces are NEVER overwritten by future auto-clustering', async () => {
      await createTrip({ id: TRIP_ID, name: 'Immunity Trip', start_at: 1000, end_at: 2000 }, db);
      await upsertPhotos(createTestPhotos(3), db);

      const personA = await createPerson({ id: 'p_a', trip_id: TRIP_ID, name: 'Person A' }, db);
      const personB = await createPerson({ id: 'p_b', trip_id: TRIP_ID, name: 'Person B' }, db);

      const faces: FaceRow[] = [
        // Face 1 is auto
        {
          id: 'face_auto',
          photo_id: 'photo_1',
          person_id: personA.id,
          assignment: 'auto',
          bbox_x: 0.1,
          bbox_y: 0.1,
          bbox_w: 0.2,
          bbox_h: 0.2,
          quality: 0.95,
          quality_ok: 1,
          blur: 60,
          embedding: makeEmbBlob(1, 0, 0),
        },
        // Face 2 was manually pinned to Person B, even though embedding is identical to Person A!
        {
          id: 'face_manual_pinned',
          photo_id: 'photo_2',
          person_id: personB.id,
          assignment: 'manual',
          bbox_x: 0.2,
          bbox_y: 0.2,
          bbox_w: 0.2,
          bbox_h: 0.2,
          quality: 0.95,
          quality_ok: 1,
          blur: 60,
          embedding: makeEmbBlob(1, 0, 0), // Identical to Person A
        },
      ];
      await insertFaces(faces, db);

      // Run auto clustering on the trip
      await clusterAndPersistTripFaces(TRIP_ID, {}, db);

      // Verify face_manual_pinned is STILL assigned to Person B and STILL 'manual'!
      const pinnedFace = await getFaceById('face_manual_pinned', db);
      expect(pinnedFace?.person_id).toBe(personB.id);
      expect(pinnedFace?.assignment).toBe('manual');
    });
  });
});
