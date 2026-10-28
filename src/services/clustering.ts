import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../db/client';
import { getTripById, updateTrip } from '../db/repositories/trips';
import { getFacesByTripId, assignFacesToPerson } from '../db/repositories/faces';
import {
  createPerson,
  getOrCreateOthersPerson,
  getPeopleByTripId,
} from '../db/repositories/people';
import type { PersonRow } from '../db/types';
import { generateUUID } from '../utils/uuid';
import {
  clusterTripFaces,
  embeddingToBlob,
  type ClusterTripFacesOptions,
  type TripClusteringResult,
} from '../domain/clustering';

export interface ClusterTripOptions extends ClusterTripFacesOptions {
  db?: SQLiteDatabase;
}

export interface ClusterTripResult {
  tripId: string;
  clustersCreated: number;
  facesClustered: number;
  othersFacesCount: number;
  skippedManualFacesCount: number;
  people: PersonRow[];
  othersPerson: PersonRow;
}

/**
 * Clusters detected faces for a trip using average-linkage hierarchical clustering
 * on cosine distance (CONFIG.CLUSTER_DISTANCE), writes people and centroid rows,
 * and updates faces.person_id (Task 2.5).
 *
 * Rules:
 * - Only quality_ok = 1 faces form clusters / centroids.
 * - Clusters with < 2 faces go to "Others".
 * - Low-quality faces (quality_ok = 0) go to "Others".
 * - Manual assignments (assignment = 'manual') are pinned and never changed.
 * - Centroids are stored on people.centroid (128xFloat32 = 512 bytes).
 * - Best representative face (closest to centroid) is set to people.cover_face_id.
 * - Updates trips.scan_status to 'clustering' then 'scanned'.
 */
export async function clusterAndPersistTripFaces(
  tripId: string,
  options: ClusterTripOptions = {},
  db?: SQLiteDatabase
): Promise<ClusterTripResult> {
  const database = db ?? options.db ?? (await getDatabase());

  const trip = await getTripById(tripId, database);
  if (!trip) {
    throw new Error(`Trip with ID "${tripId}" not found`);
  }

  const faces = await getFacesByTripId(tripId, {}, database);

  if (faces.length === 0) {
    const othersPerson = await getOrCreateOthersPerson(tripId, generateUUID(), database);
    await updateTrip(tripId, { scan_status: 'scanned' }, database);
    return {
      tripId,
      clustersCreated: 0,
      facesClustered: 0,
      othersFacesCount: 0,
      skippedManualFacesCount: 0,
      people: [],
      othersPerson,
    };
  }

  // Pure domain clustering
  const clusteringRes = clusterTripFaces(faces, {
    threshold: options.threshold,
    minClusterSize: options.minClusterSize,
  });

  return await persistTripClusters(tripId, clusteringRes, database);
}

/**
 * Persists the clustering result to the SQLite database in a single atomic transaction.
 */
export async function persistTripClusters(
  tripId: string,
  clusteringRes: TripClusteringResult,
  db?: SQLiteDatabase
): Promise<ClusterTripResult> {
  const database = db ?? (await getDatabase());

  let createdPeople: PersonRow[] = [];
  let othersPerson!: PersonRow;

  await database.withTransactionAsync(async () => {
    // 1. Mark trip scan_status as clustering
    await updateTrip(tripId, { scan_status: 'clustering' }, database);

    // 2. Remove previously auto-generated unnamed people on re-cluster,
    // preserving any named people or people who have manual face assignments.
    await database.runAsync(
      `DELETE FROM people
       WHERE trip_id = ?
         AND is_others = 0
         AND name IS NULL
         AND id NOT IN (
           SELECT DISTINCT person_id FROM faces WHERE assignment = 'manual' AND person_id IS NOT NULL
         );`,
      [tripId]
    );

    // 3. Create person row for each cluster and assign faces
    createdPeople = [];
    for (const cluster of clusteringRes.clusters) {
      const personId = generateUUID();
      const person = await createPerson(
        {
          id: personId,
          trip_id: tripId,
          name: null,
          is_others: 0,
          cover_face_id: cluster.coverFaceId,
          centroid: embeddingToBlob(cluster.centroid),
        },
        database
      );
      createdPeople.push(person);

      await assignFacesToPerson(cluster.itemIds, personId, 'auto', database);
    }

    // 4. Ensure single "Others" person exists for this trip
    othersPerson = await getOrCreateOthersPerson(tripId, generateUUID(), database);

    // 5. Assign othersItemIds (single-face clusters + low-quality faces) to Others
    if (clusteringRes.othersItemIds.length > 0) {
      await assignFacesToPerson(
        clusteringRes.othersItemIds,
        othersPerson.id,
        'auto',
        database
      );
    }

    // 6. Mark trip scan_status as scanned
    await updateTrip(tripId, { scan_status: 'scanned' }, database);
  });

  const allPeople = await getPeopleByTripId(tripId, database);
  const nonOthers = allPeople.filter((p) => p.is_others === 0);
  const foundOthers = allPeople.find((p) => p.is_others === 1) ?? othersPerson;

  const totalFacesClustered = clusteringRes.clusters.reduce(
    (sum, c) => sum + c.itemIds.length,
    0
  );

  return {
    tripId,
    clustersCreated: clusteringRes.clusters.length,
    facesClustered: totalFacesClustered,
    othersFacesCount: clusteringRes.othersItemIds.length,
    skippedManualFacesCount: clusteringRes.skippedManualFaceIds.length,
    people: nonOthers,
    othersPerson: foundOthers,
  };
}

// Re-export domain clustering functions for convenience
export * from '../domain/clustering';
