import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../db/client';
import {
  getPersonById,
  getPeopleByTripId,
  updatePerson,
  getOrCreateOthersPerson,
} from '../db/repositories/people';
import {
  getFacesByTripId,
  getFacesByPersonId,
  assignFacesToPerson,
} from '../db/repositories/faces';
import type { PersonRow } from '../db/types';
import { generateUUID } from '../utils/uuid';
import {
  validatePersonName,
  computeQualityCentroid,
  planFaceAssignments,
  type PersonCentroidTarget,
  type AssignmentPlan,
} from '../domain/assignment';
import { embeddingToBlob } from '../domain/clustering';

export interface NameAndAssignOptions {
  db?: SQLiteDatabase;
  assignDistance?: number;
  pickedFaceId?: string; // Optional user-picked clear face to set as cover_face_id
}

export interface NameAndAssignResult {
  person: PersonRow;
  centroid: Float32Array | null;
  addedToThisPersonCount: number;
  totalReassigned: number;
  totalFacesInPerson: number;
  plan: AssignmentPlan;
}

/**
 * Executes the Name-first assignment workflow (TRD §4, PRD US-05b, AppFlow §3.5):
 * 1. Validates the given name (trimmed, 1-40 chars, no illegal chars, unique in trip).
 * 2. Computes/updates the person's centroid from its quality_ok = 1 faces.
 * 3. Re-assigns remaining auto faces in the trip to the nearest centroid if distance < ASSIGN_DISTANCE.
 * 4. Pinned manual faces (assignment='manual') are never touched.
 * 5. Runs atomically within a SQLite transaction and returns reassignment stats.
 */
export async function nameAndAssignPerson(
  tripId: string,
  personId: string,
  name: string,
  options: NameAndAssignOptions = {},
  db?: SQLiteDatabase
): Promise<NameAndAssignResult> {
  const database = db ?? options.db ?? (await getDatabase());

  // 1. Fetch target person
  const targetPerson = await getPersonById(personId, database);
  if (!targetPerson) {
    throw new Error(`Person with ID "${personId}" not found`);
  }

  // 2. Fetch existing people in trip to validate uniqueness
  const tripPeople = await getPeopleByTripId(tripId, database);
  const otherNames = tripPeople
    .filter((p) => p.id !== personId)
    .map((p) => p.name);

  const nameValidation = validatePersonName(name, otherNames);
  if (!nameValidation.valid) {
    throw new Error(nameValidation.error ?? 'Invalid person name');
  }
  const cleanName = nameValidation.trimmedName;

  // 3. Ensure single "Others" person exists for the trip
  const othersPerson = await getOrCreateOthersPerson(tripId, generateUUID(), database);

  let updatedPerson!: PersonRow;
  let finalCentroid: Float32Array | null = null;
  let plan!: AssignmentPlan;

  await database.withTransactionAsync(async () => {
    // Step A: Update person name (and cover_face_id if picked)
    const personUpdates: Partial<PersonRow> = {
      name: cleanName,
    };
    if (options.pickedFaceId) {
      personUpdates.cover_face_id = options.pickedFaceId;
    }
    await updatePerson(personId, personUpdates, database);

    // Step B: Fetch faces currently assigned to this person to compute centroid
    const currentFaces = await getFacesByPersonId(personId, database);
    finalCentroid = computeQualityCentroid(currentFaces);

    if (finalCentroid) {
      await updatePerson(
        personId,
        { centroid: embeddingToBlob(finalCentroid) },
        database
      );
    }

    // Step C: Gather all named people in the trip with centroids
    const allPeople = await getPeopleByTripId(tripId, database);
    const peopleCentroids: PersonCentroidTarget[] = [];

    for (const p of allPeople) {
      if (p.is_others === 1) continue;
      // If this is target person, use freshly computed centroid
      if (p.id === personId) {
        if (finalCentroid) {
          peopleCentroids.push({
            id: p.id,
            name: cleanName,
            centroid: finalCentroid,
          });
        }
      } else if (p.name && p.centroid) {
        // Other already named person with centroid
        peopleCentroids.push({
          id: p.id,
          name: p.name,
          centroid: p.centroid,
        });
      }
    }

    // Step D: Fetch all faces in trip and plan assignments
    const allFaces = await getFacesByTripId(tripId, {}, database);
    plan = planFaceAssignments(allFaces, peopleCentroids, {
      assignDistance: options.assignDistance,
      othersPersonId: othersPerson.id,
    });

    // Step E: Apply changed assignments
    // Group face IDs by newPersonId to batch updates
    const updatesByPersonId = new Map<string | null, string[]>();
    for (const decision of plan.decisions) {
      if (decision.changed) {
        const group = updatesByPersonId.get(decision.newPersonId) || [];
        group.push(decision.faceId);
        updatesByPersonId.set(decision.newPersonId, group);
      }
    }

    for (const [newPid, faceIds] of updatesByPersonId.entries()) {
      await assignFacesToPerson(faceIds, newPid, 'auto', database);
    }

    // Step F: Refresh target person row
    const refreshed = await getPersonById(personId, database);
    if (!refreshed) {
      throw new Error(`Failed to reload person ${personId}`);
    }
    updatedPerson = refreshed;
  });

  const finalFaces = await getFacesByPersonId(personId, database);
  const addedToThisPerson = plan.addedCountsByPersonId[personId] || 0;

  return {
    person: updatedPerson,
    centroid: finalCentroid,
    addedToThisPersonCount: addedToThisPerson,
    totalReassigned: plan.totalReassigned,
    totalFacesInPerson: finalFaces.length,
    plan,
  };
}

/**
 * Recomputes and updates a person's centroid from its current quality_ok = 1 faces.
 * Used after manual edits (merging, moving faces, deleting faces).
 */
export async function recomputePersonCentroid(
  personId: string,
  db?: SQLiteDatabase
): Promise<Float32Array | null> {
  const database = db ?? (await getDatabase());
  const faces = await getFacesByPersonId(personId, database);
  const centroid = computeQualityCentroid(faces);

  await updatePerson(
    personId,
    {
      centroid: centroid ? embeddingToBlob(centroid) : null,
    },
    database
  );

  return centroid;
}
