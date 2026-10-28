import { openDbSync } from '../src/db/client';
import { runMigrationsSync } from '../src/db/migrations';
import { createTrip } from '../src/db/repositories/trips';
import { upsertPhotos } from '../src/db/repositories/photos';
import { insertFaces, getFacesByTripId } from '../src/db/repositories/faces';
import { createPerson, getPeopleByTripId, getPersonById } from '../src/db/repositories/people';
import type { PhotoRow, FaceRow } from '../src/db/types';
import {
  validatePersonName,
  computeQualityCentroid,
  planFaceAssignments,
  type FaceForAssignment,
  type PersonCentroidTarget,
} from '../src/domain/assignment';
import {
  nameAndAssignPerson,
  recomputePersonCentroid,
} from '../src/services/assignment';
import { l2Normalize, embeddingToBlob } from '../src/domain/clustering';

describe('Person Name Validation (AppFlow §3.6, Schema §1)', () => {
  it('validates and trims normal names', () => {
    const res = validatePersonName('  John Doe  ');
    expect(res.valid).toBe(true);
    expect(res.trimmedName).toBe('John Doe');
  });

  it('rejects empty names or whitespace-only names', () => {
    expect(validatePersonName('').valid).toBe(false);
    expect(validatePersonName('   ').valid).toBe(false);
    expect(validatePersonName('   ').error).toBe('Name cannot be empty');
  });

  it('rejects names longer than 40 characters', () => {
    const longName = 'A'.repeat(41);
    const res = validatePersonName(longName);
    expect(res.valid).toBe(false);
    expect(res.error).toBe('Name must be 40 characters or fewer');
  });

  it('rejects names with illegal filesystem characters (/, \\, :)', () => {
    expect(validatePersonName('John/Doe').valid).toBe(false);
    expect(validatePersonName('John\\Doe').valid).toBe(false);
    expect(validatePersonName('John:Doe').valid).toBe(false);
    expect(validatePersonName('John:Doe').error).toBe('Name cannot contain /, \\, or :');
  });

  it('rejects duplicate names within the same trip (case-insensitive)', () => {
    const existing = ['Alice', 'Bob', 'Charlie'];
    const resExact = validatePersonName('Alice', existing);
    expect(resExact.valid).toBe(false);
    expect(resExact.error).toBe('Name already used in this trip');

    const resLower = validatePersonName('alice', existing);
    expect(resLower.valid).toBe(false);

    const resUnique = validatePersonName('David', existing);
    expect(resUnique.valid).toBe(true);
  });
});

describe('Centroid Computation (TRD §4)', () => {
  it('computes L2-normalized centroid from quality_ok = 1 faces only', () => {
    const v1 = l2Normalize(new Float32Array([1, 0, 0]));
    const v2 = l2Normalize(new Float32Array([0, 1, 0]));
    const vBlurry = l2Normalize(new Float32Array([0, 0, 100])); // Extreme outlier if included

    const faces = [
      { quality_ok: 1, embedding: v1 },
      { quality_ok: 1, embedding: v2 },
      { quality_ok: 0, embedding: vBlurry }, // Must be ignored!
    ];

    const centroid = computeQualityCentroid(faces);
    expect(centroid).not.toBeNull();
    if (centroid) {
      expect(centroid[0]).toBeCloseTo(Math.SQRT1_2, 5);
      expect(centroid[1]).toBeCloseTo(Math.SQRT1_2, 5);
      expect(centroid[2]).toBeCloseTo(0, 5); // vBlurry was excluded!
    }
  });

  it('returns null if there are no quality_ok = 1 faces', () => {
    const faces = [
      { quality_ok: 0, embedding: new Float32Array([1, 0, 0]) },
      { quality_ok: 0, embedding: new Float32Array([0, 1, 0]) },
    ];
    expect(computeQualityCentroid(faces)).toBeNull();
    expect(computeQualityCentroid([])).toBeNull();
  });
});

describe('planFaceAssignments (Domain Algorithm)', () => {
  function makeEmb(x: number, y: number, z: number): Float32Array {
    const f = new Float32Array(128);
    f[0] = x;
    f[1] = y;
    f[2] = z;
    return l2Normalize(f);
  }

  it('assigns auto faces to nearest centroid if distance < ASSIGN_DISTANCE', () => {
    const personA: PersonCentroidTarget = {
      id: 'p_alice',
      name: 'Alice',
      centroid: makeEmb(1, 0, 0),
    };
    const personB: PersonCentroidTarget = {
      id: 'p_bob',
      name: 'Bob',
      centroid: makeEmb(0, 1, 0),
    };

    const faces: FaceForAssignment[] = [
      // Close to Alice: d = 1 - 0.98 = 0.02 < 0.35
      {
        id: 'f1',
        photo_id: 'photo_1',
        person_id: null,
        assignment: 'auto',
        quality_ok: 1,
        embedding: makeEmb(0.98, 0.05, 0),
      },
      // Close to Bob: d = 1 - 0.95 = 0.05 < 0.35
      {
        id: 'f2',
        photo_id: 'photo_2',
        person_id: null,
        assignment: 'auto',
        quality_ok: 1,
        embedding: makeEmb(0.05, 0.95, 0),
      },
      // Far from both: d > 0.35 -> should go to Others
      {
        id: 'f3',
        photo_id: 'photo_3',
        person_id: null,
        assignment: 'auto',
        quality_ok: 1,
        embedding: makeEmb(0, 0, 1),
      },
    ];

    const plan = planFaceAssignments(faces, [personA, personB], {
      assignDistance: 0.35,
      othersPersonId: 'p_others',
    });

    expect(plan.totalReassigned).toBe(3);
    expect(plan.addedCountsByPersonId['p_alice']).toBe(1);
    expect(plan.addedCountsByPersonId['p_bob']).toBe(1);

    const d1 = plan.decisions.find((d) => d.faceId === 'f1');
    expect(d1?.newPersonId).toBe('p_alice');

    const d2 = plan.decisions.find((d) => d.faceId === 'f2');
    expect(d2?.newPersonId).toBe('p_bob');

    const d3 = plan.decisions.find((d) => d.faceId === 'f3');
    expect(d3?.newPersonId).toBe('p_others');
  });

  it('never modifies manual pinned faces even if closer to another centroid', () => {
    const personA: PersonCentroidTarget = {
      id: 'p_alice',
      name: 'Alice',
      centroid: makeEmb(1, 0, 0),
    };

    const faces: FaceForAssignment[] = [
      {
        id: 'f_pinned',
        photo_id: 'photo_1',
        person_id: 'p_charlie',
        assignment: 'manual', // Pinned to Charlie
        quality_ok: 1,
        embedding: makeEmb(0.99, 0.01, 0), // Very close to Alice!
      },
    ];

    const plan = planFaceAssignments(faces, [personA], {
      assignDistance: 0.35,
      othersPersonId: 'p_others',
    });

    expect(plan.skippedManualCount).toBe(1);
    expect(plan.totalReassigned).toBe(0);

    const d = plan.decisions.find((dec) => dec.faceId === 'f_pinned');
    expect(d?.newPersonId).toBe('p_charlie');
    expect(d?.changed).toBe(false);
  });

  it('enforces same-photo constraint: only the closer face in the same photo is assigned to a person', () => {
    const personA: PersonCentroidTarget = {
      id: 'p_alice',
      name: 'Alice',
      centroid: makeEmb(1, 0, 0),
    };

    // Both faces are in photo_same!
    // f_close distance ~ 0.01
    // f_far distance ~ 0.15 (both < 0.35)
    const faces: FaceForAssignment[] = [
      {
        id: 'f_close',
        photo_id: 'photo_same',
        person_id: null,
        assignment: 'auto',
        quality_ok: 1,
        embedding: makeEmb(0.99, 0.01, 0),
      },
      {
        id: 'f_far',
        photo_id: 'photo_same',
        person_id: null,
        assignment: 'auto',
        quality_ok: 1,
        embedding: makeEmb(0.85, 0.15, 0),
      },
    ];

    const plan = planFaceAssignments(faces, [personA], {
      assignDistance: 0.35,
      othersPersonId: 'p_others',
    });

    const dClose = plan.decisions.find((d) => d.faceId === 'f_close');
    const dFar = plan.decisions.find((d) => d.faceId === 'f_far');

    // Closer face gets Alice
    expect(dClose?.newPersonId).toBe('p_alice');
    // Second face in the same photo cannot be Alice, goes to Others!
    expect(dFar?.newPersonId).toBe('p_others');
  });

  it('allows quality_ok = 0 faces to be assigned to nearest centroid if within distance', () => {
    const personA: PersonCentroidTarget = {
      id: 'p_alice',
      name: 'Alice',
      centroid: makeEmb(1, 0, 0),
    };

    const faces: FaceForAssignment[] = [
      {
        id: 'f_blurry',
        photo_id: 'photo_1',
        person_id: null,
        assignment: 'auto',
        quality_ok: 0, // Blurry or small face
        embedding: makeEmb(0.95, 0.05, 0), // Close to Alice
      },
    ];

    const plan = planFaceAssignments(faces, [personA], {
      assignDistance: 0.35,
      othersPersonId: 'p_others',
    });

    const d = plan.decisions.find((dec) => dec.faceId === 'f_blurry');
    expect(d?.newPersonId).toBe('p_alice');
  });
});

describe('nameAndAssignPerson Service & Database Integration (Task 2.6)', () => {
  const db = openDbSync(':memory:');
  const TRIP_ID = 'trip_name_assign_1';

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
      id: `p_${i + 1}`,
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

  it('names a person, computes centroid, and auto-adds remaining similar faces across the trip', async () => {
    await createTrip({ id: TRIP_ID, name: 'Naming Trip', start_at: 1000, end_at: 2000 }, db);
    await upsertPhotos(createTestPhotos(5), db);

    // Initial unnamed person created by clustering with 2 faces
    const unnamedPerson = await createPerson(
      {
        id: 'person_unnamed_1',
        trip_id: TRIP_ID,
        name: null,
        is_others: 0,
      },
      db
    );

    // Setup faces in database:
    // f1, f2: currently assigned to unnamedPerson
    // f3: in Others (unassigned), but embedding is very similar to unnamedPerson (d < 0.35)
    // f4: in Others (unassigned), embedding is an outlier (d > 0.35)
    // f5: manually assigned to Bob (pinned)
    const bob = await createPerson(
      {
        id: 'person_bob',
        trip_id: TRIP_ID,
        name: 'Bob',
        is_others: 0,
      },
      db
    );

    const testFaces: FaceRow[] = [
      {
        id: 'face_1',
        photo_id: 'p_1',
        person_id: unnamedPerson.id,
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
        photo_id: 'p_2',
        person_id: unnamedPerson.id,
        assignment: 'auto',
        bbox_x: 0.2,
        bbox_y: 0.2,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.92,
        quality_ok: 1,
        blur: 55,
        embedding: makeEmbBlob(0.98, 0.02, 0),
      },
      // In Others, but close to Rafi! (should be auto-added)
      {
        id: 'face_3',
        photo_id: 'p_3',
        person_id: null,
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
      // In Others, outlier
      {
        id: 'face_4',
        photo_id: 'p_4',
        person_id: null,
        assignment: 'auto',
        bbox_x: 0.4,
        bbox_y: 0.4,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.85,
        quality_ok: 1,
        blur: 40,
        embedding: makeEmbBlob(0, 1, 0),
      },
      // Manually pinned to Bob
      {
        id: 'face_5',
        photo_id: 'p_5',
        person_id: bob.id,
        assignment: 'manual',
        bbox_x: 0.5,
        bbox_y: 0.5,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.95,
        quality_ok: 1,
        blur: 70,
        embedding: makeEmbBlob(0.99, 0.01, 0), // Close to Rafi, but pinned to Bob!
      },
    ];

    await insertFaces(testFaces, db);

    // Act: Name person_unnamed_1 as 'Rafi'
    const result = await nameAndAssignPerson(
      TRIP_ID,
      unnamedPerson.id,
      'Rafi',
      { assignDistance: 0.35 },
      db
    );

    // Verify stats
    expect(result.person.name).toBe('Rafi');
    expect(result.centroid).toBeDefined();
    expect(result.addedToThisPersonCount).toBe(1); // face_3 was added to Rafi!
    expect(result.totalFacesInPerson).toBe(3); // face_1 + face_2 + face_3

    // Verify person row in SQLite has name and centroid BLOB
    const updatedPerson = await getPersonById(unnamedPerson.id, db);
    expect(updatedPerson?.name).toBe('Rafi');
    expect(updatedPerson?.centroid).toBeDefined();
    expect(updatedPerson?.centroid?.byteLength).toBe(512);

    // Verify face rows in SQLite
    const allFaces = await getFacesByTripId(TRIP_ID, {}, db);
    const f1 = allFaces.find((f) => f.id === 'face_1');
    const f2 = allFaces.find((f) => f.id === 'face_2');
    const f3 = allFaces.find((f) => f.id === 'face_3');
    const f4 = allFaces.find((f) => f.id === 'face_4');
    const f5 = allFaces.find((f) => f.id === 'face_5');

    expect(f1?.person_id).toBe(unnamedPerson.id);
    expect(f2?.person_id).toBe(unnamedPerson.id);
    // face_3 was auto-added to Rafi!
    expect(f3?.person_id).toBe(unnamedPerson.id);
    expect(f3?.assignment).toBe('auto');

    // face_4 stays in Others
    const people = await getPeopleByTripId(TRIP_ID, db);
    const others = people.find((p) => p.is_others === 1);
    expect(f4?.person_id).toBe(others?.id);

    // face_5 was pinned to Bob and remained untouched
    expect(f5?.person_id).toBe(bob.id);
    expect(f5?.assignment).toBe('manual');
  });

  it('rejects duplicate names and aborts transaction without modifying DB', async () => {
    await createTrip({ id: TRIP_ID, name: 'Dup Trip', start_at: 1000, end_at: 2000 }, db);
    await createPerson({ id: 'p_existing', trip_id: TRIP_ID, name: 'Alice' }, db);
    const p2 = await createPerson({ id: 'p_two', trip_id: TRIP_ID, name: null }, db);

    await expect(
      nameAndAssignPerson(TRIP_ID, p2.id, 'Alice', {}, db)
    ).rejects.toThrow('Name already used in this trip');

    // Verify p2 is still unnamed
    const checkP2 = await getPersonById(p2.id, db);
    expect(checkP2?.name).toBeNull();
  });

  it('updates cover_face_id when user picks a clear face', async () => {
    await createTrip({ id: TRIP_ID, name: 'Cover Face Trip', start_at: 1000, end_at: 2000 }, db);
    await upsertPhotos(createTestPhotos(2), db);

    const person = await createPerson({ id: 'p_cover', trip_id: TRIP_ID, name: null }, db);
    const faceRow: FaceRow = {
      id: 'picked_face_99',
      photo_id: 'p_1',
      person_id: person.id,
      assignment: 'auto',
      bbox_x: 0.1,
      bbox_y: 0.1,
      bbox_w: 0.2,
      bbox_h: 0.2,
      quality: 0.98,
      quality_ok: 1,
      blur: 85,
      embedding: makeEmbBlob(1, 0, 0),
    };
    await insertFaces([faceRow], db);

    const result = await nameAndAssignPerson(
      TRIP_ID,
      person.id,
      'Sara',
      { pickedFaceId: 'picked_face_99' },
      db
    );

    expect(result.person.cover_face_id).toBe('picked_face_99');
    const dbPerson = await getPersonById(person.id, db);
    expect(dbPerson?.cover_face_id).toBe('picked_face_99');
  });

  it('recomputes centroid after manual face edits with recomputePersonCentroid', async () => {
    await createTrip({ id: TRIP_ID, name: 'Recompute Trip', start_at: 1000, end_at: 2000 }, db);
    await upsertPhotos(createTestPhotos(2), db);

    const person = await createPerson({ id: 'p_recomp', trip_id: TRIP_ID, name: 'Tom' }, db);
    const face1: FaceRow = {
      id: 'f_t1',
      photo_id: 'p_1',
      person_id: person.id,
      assignment: 'auto',
      bbox_x: 0.1,
      bbox_y: 0.1,
      bbox_w: 0.2,
      bbox_h: 0.2,
      quality: 0.95,
      quality_ok: 1,
      blur: 70,
      embedding: makeEmbBlob(1, 0, 0),
    };
    const face2: FaceRow = {
      id: 'f_t2',
      photo_id: 'p_2',
      person_id: person.id,
      assignment: 'manual',
      bbox_x: 0.2,
      bbox_y: 0.2,
      bbox_w: 0.2,
      bbox_h: 0.2,
      quality: 0.92,
      quality_ok: 1,
      blur: 65,
      embedding: makeEmbBlob(0, 1, 0),
    };
    await insertFaces([face1, face2], db);

    const newCentroid = await recomputePersonCentroid(person.id, db);
    expect(newCentroid).not.toBeNull();
    if (newCentroid) {
      expect(newCentroid[0]).toBeCloseTo(Math.SQRT1_2, 5);
      expect(newCentroid[1]).toBeCloseTo(Math.SQRT1_2, 5);
    }

    const updated = await getPersonById(person.id, db);
    expect(updated?.centroid).toBeDefined();
  });
});
