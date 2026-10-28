import { useState, useCallback } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../db/client';
import type { TripRow } from '../db/types';
import {
  getUserEditedTrips,
  getAutoDetectedTrips,
  createTrip,
  updateTrip,
  deleteTrip,
} from '../db/repositories/trips';
import {
  getPhotosForTripDetection,
  assignPhotosToTrip,
  unassignPhotosFromTrip,
} from '../db/repositories/photos';
import { getOrCreateOthersPerson } from '../db/repositories/people';
import {
  detectTrips,
  generateDefaultTripName,
  type DetectedTrip,
} from '../domain/tripDetection';
import { generateUUID } from '../utils/uuid';

export interface DetectAndPersistTripsOptions {
  db?: SQLiteDatabase;
  gapHours?: number;
  minPhotos?: number;
  minHours?: number;
  timeZone?: string;
}

export interface DetectAndPersistTripsResult {
  detectedCount: number;
  createdCount: number;
  updatedCount: number;
  preservedUserEditedCount: number;
  deletedStaleCount: number;
  trips: TripRow[];
}

/**
 * Orchestrates trip detection from photo timestamps in SQLite, persists detected trips,
 * assigns member photos to their respective trips, and strictly preserves any user-edited trips.
 *
 * Rules:
 * 1. Photos assigned to trips with `is_user_edited = 1` are protected and never reassigned or modified.
 * 2. `is_user_edited = 1` trips are completely preserved (never deleted, renamed, or modified on re-detect).
 * 3. Candidate photos (unassigned or belonging to auto-detected trips) are clustered using the time-gap rule.
 * 4. Existing auto-detected trips (`is_user_edited = 0`) are reconciled:
 *    - Reused if matching clusters overlap with existing trip photos or date ranges.
 *    - Scan statuses, scanned counts, and people are preserved on matched auto-trips.
 *    - Unmatched/stale auto-trips are cleaned up and deleted.
 * 5. All database updates occur inside a single SQLite transaction.
 */
export async function detectAndPersistTrips(
  options: DetectAndPersistTripsOptions = {}
): Promise<DetectAndPersistTripsResult> {
  const database = options.db ?? (await getDatabase());
  const now = Date.now();

  // 1. Fetch user-edited trips which are protected from automatic re-detection
  const userEditedTrips = await getUserEditedTrips(database);
  const userEditedTripIds = userEditedTrips.map((t) => t.id);
  const preservedUserEditedCount = userEditedTrips.length;

  // 2. Fetch all candidate photos for trip detection (excluding photos assigned to user-edited trips)
  const candidatePhotos = await getPhotosForTripDetection(userEditedTripIds, database);

  // If there are no candidate photos available to detect trips
  if (candidatePhotos.length === 0) {
    const existingAutoTrips = await getAutoDetectedTrips(database);
    let deletedStaleCount = 0;

    if (existingAutoTrips.length > 0) {
      await database.withTransactionAsync(async () => {
        for (const autoTrip of existingAutoTrips) {
          await unassignPhotosFromTrip(autoTrip.id, database);
          await deleteTrip(autoTrip.id, database);
          deletedStaleCount++;
        }
      });
    }

    return {
      detectedCount: 0,
      createdCount: 0,
      updatedCount: 0,
      preservedUserEditedCount,
      deletedStaleCount,
      trips: [...userEditedTrips].sort((a, b) => b.start_at - a.start_at),
    };
  }

  // 3. Run pure domain trip detection engine on candidate photos
  const detectedClusters = detectTrips(candidatePhotos, {
    gapHours: options.gapHours,
    minPhotos: options.minPhotos,
    minHours: options.minHours,
    timeZone: options.timeZone,
  });

  // 4. Fetch existing auto-detected trips for reconciliation
  const existingAutoTrips = await getAutoDetectedTrips(database);

  // Map photo ID -> existing trip ID for overlap calculation
  const photoToExistingTripId = new Map<string, string>();
  for (const photo of candidatePhotos) {
    if (photo.trip_id) {
      photoToExistingTripId.set(photo.id, photo.trip_id);
    }
  }

  // Determine 1-to-1 matches between detected clusters and existing auto-trips
  const availableExistingTrips = new Map<string, TripRow>(
    existingAutoTrips.map((t) => [t.id, t])
  );
  const clusterMatches = new Map<number, TripRow>(); // cluster index -> matched existing auto-trip

  detectedClusters.forEach((cluster, clusterIndex) => {
    // Count photo overlap with available existing auto-trips
    const overlapCounts = new Map<string, number>();
    for (const photoId of cluster.photo_ids) {
      const existingTripId = photoToExistingTripId.get(photoId);
      if (existingTripId && availableExistingTrips.has(existingTripId)) {
        overlapCounts.set(existingTripId, (overlapCounts.get(existingTripId) ?? 0) + 1);
      }
    }

    // Pick existing trip with highest photo overlap
    let bestTripId: string | null = null;
    let maxOverlap = 0;
    for (const [tripId, count] of overlapCounts.entries()) {
      if (count > maxOverlap) {
        maxOverlap = count;
        bestTripId = tripId;
      }
    }

    // If no photo overlap, check date range overlap with remaining available trips
    if (!bestTripId) {
      for (const [tripId, existingTrip] of availableExistingTrips.entries()) {
        const hasTimeOverlap =
          Math.max(cluster.start_at, existingTrip.start_at) <=
          Math.min(cluster.end_at, existingTrip.end_at);
        if (hasTimeOverlap) {
          bestTripId = tripId;
          break;
        }
      }
    }

    if (bestTripId) {
      const matchedTrip = availableExistingTrips.get(bestTripId)!;
      clusterMatches.set(clusterIndex, matchedTrip);
      availableExistingTrips.delete(bestTripId); // 1-to-1 matching
    }
  });

  let createdCount = 0;
  let updatedCount = 0;
  let deletedStaleCount = 0;
  const processedTrips: TripRow[] = [...userEditedTrips];
  const allAssignedPhotoIds = new Set<string>();

  // 5. Execute all database mutations in a single atomic transaction
  await database.withTransactionAsync(async () => {
    for (let i = 0; i < detectedClusters.length; i++) {
      const cluster: DetectedTrip = detectedClusters[i];
      const matchedExisting = clusterMatches.get(i);

      if (matchedExisting) {
        // Reuse existing auto-trip, updating date span, cover photo, photo count, and name
        const shouldRegenerateName =
          matchedExisting.name.startsWith('Trip · ') ||
          matchedExisting.name === cluster.name;

        const newName = shouldRegenerateName
          ? generateDefaultTripName(cluster.start_at, cluster.end_at, {
              timeZone: options.timeZone,
            })
          : matchedExisting.name;

        const updated = await updateTrip(
          matchedExisting.id,
          {
            name: newName,
            start_at: cluster.start_at,
            end_at: cluster.end_at,
            photo_count: cluster.photo_count,
            cover_photo_id: cluster.cover_photo_id,
            updated_at: now,
          },
          database
        );

        // Assign member photos to this trip
        await assignPhotosToTrip(cluster.photo_ids, matchedExisting.id, database);
        for (const pid of cluster.photo_ids) {
          allAssignedPhotoIds.add(pid);
        }

        if (updated) {
          processedTrips.push(updated);
        }
        updatedCount++;
      } else {
        // Create brand new trip
        const newTripId = generateUUID();
        const created = await createTrip(
          {
            id: newTripId,
            name: cluster.name,
            start_at: cluster.start_at,
            end_at: cluster.end_at,
            photo_count: cluster.photo_count,
            cover_photo_id: cluster.cover_photo_id,
            is_away: 0,
            is_hidden: 0,
            is_user_edited: 0,
            scan_status: 'not_scanned',
            scanned_count: 0,
            created_at: now,
            updated_at: now,
          },
          database
        );

        // Create default "Others" bucket in people table
        await getOrCreateOthersPerson(newTripId, generateUUID(), database);

        // Assign member photos to the new trip
        await assignPhotosToTrip(cluster.photo_ids, newTripId, database);
        for (const pid of cluster.photo_ids) {
          allAssignedPhotoIds.add(pid);
        }

        processedTrips.push(created);
        createdCount++;
      }
    }

    // 6. Delete remaining unmatched (stale) auto-trips
    for (const staleTrip of availableExistingTrips.values()) {
      await unassignPhotosFromTrip(staleTrip.id, database);
      await deleteTrip(staleTrip.id, database);
      deletedStaleCount++;
    }

    // 7. Unassign candidate photos that were previously attached to an auto-trip but are no longer in any cluster
    const photosToUnassign: string[] = [];
    for (const photo of candidatePhotos) {
      if (photo.trip_id && !allAssignedPhotoIds.has(photo.id)) {
        photosToUnassign.push(photo.id);
      }
    }

    if (photosToUnassign.length > 0) {
      await assignPhotosToTrip(photosToUnassign, null, database);
    }
  });

  // Sort trips newest first (start_at DESC)
  processedTrips.sort((a, b) => b.start_at - a.start_at);

  return {
    detectedCount: detectedClusters.length,
    createdCount,
    updatedCount,
    preservedUserEditedCount,
    deletedStaleCount,
    trips: processedTrips,
  };
}

export interface UseTripDetectionResult {
  isDetecting: boolean;
  error: Error | null;
  lastResult: DetectAndPersistTripsResult | null;
  detect: (options?: DetectAndPersistTripsOptions) => Promise<DetectAndPersistTripsResult>;
}

/**
 * Hook to trigger and monitor automatic trip detection and persistence.
 */
export function useTripDetection(): UseTripDetectionResult {
  const [isDetecting, setIsDetecting] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastResult, setLastResult] = useState<DetectAndPersistTripsResult | null>(null);

  const detect = useCallback(async (opts: DetectAndPersistTripsOptions = {}) => {
    setIsDetecting(true);
    setError(null);
    try {
      const result = await detectAndPersistTrips(opts);
      setLastResult(result);
      return result;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      throw e;
    } finally {
      setIsDetecting(false);
    }
  }, []);

  return {
    isDetecting,
    error,
    lastResult,
    detect,
  };
}
