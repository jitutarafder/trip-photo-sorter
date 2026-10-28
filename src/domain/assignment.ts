// Pure TypeScript Name-First Face Assignment (TRD §4, PRD US-05b, Plan Task 2.6)
// No imports from React, React Native, or Expo

import { CONFIG } from './config';
import {
  cosineDistance,
  computeCentroid,
  blobToEmbedding,
} from './clustering';

export interface PersonNameValidationResult {
  valid: boolean;
  error?: string;
  trimmedName: string;
}

/**
 * Validates a person's display name per AppFlow §3.6 and Schema §1:
 * - Trimmed length must be 1 to 40 characters.
 * - Cannot contain invalid path/filesystem characters: /, \, :
 * - Cannot duplicate an existing name within the same trip (case-insensitive).
 */
export function validatePersonName(
  name: string,
  existingNames: (string | null | undefined)[] = []
): PersonNameValidationResult {
  const trimmed = name.trim();

  if (trimmed.length === 0) {
    return {
      valid: false,
      error: 'Name cannot be empty',
      trimmedName: '',
    };
  }

  if (trimmed.length > 40) {
    return {
      valid: false,
      error: 'Name must be 40 characters or fewer',
      trimmedName: trimmed,
    };
  }

  // Illegal filesystem characters: /, \, :
  if (/[/\\:]/.test(trimmed)) {
    return {
      valid: false,
      error: 'Name cannot contain /, \\, or :',
      trimmedName: trimmed,
    };
  }

  const normalizedLower = trimmed.toLowerCase();
  for (const existing of existingNames) {
    if (existing && existing.trim().toLowerCase() === normalizedLower) {
      return {
        valid: false,
        error: 'Name already used in this trip',
        trimmedName: trimmed,
      };
    }
  }

  return {
    valid: true,
    trimmedName: trimmed,
  };
}

export interface FaceForCentroid {
  id?: string;
  quality_ok: number;
  embedding: Float32Array | Uint8Array;
}

/**
 * Computes an L2-normalized centroid from a person's quality_ok = 1 faces (TRD §4).
 * Low-quality faces (quality_ok = 0) are excluded and never form or move a centroid.
 * Returns null if there are no quality_ok = 1 faces.
 */
export function computeQualityCentroid(
  faces: FaceForCentroid[]
): Float32Array | null {
  const qualityEmbeddings: Float32Array[] = [];

  for (const face of faces) {
    if (face.quality_ok === 1) {
      const emb =
        face.embedding instanceof Float32Array
          ? face.embedding
          : blobToEmbedding(face.embedding);
      if (emb.length > 0) {
        qualityEmbeddings.push(emb);
      }
    }
  }

  if (qualityEmbeddings.length === 0) {
    return null;
  }

  return computeCentroid(qualityEmbeddings);
}

export interface PersonCentroidTarget {
  id: string;
  name?: string | null;
  centroid: Float32Array | Uint8Array;
}

export interface FaceForAssignment {
  id: string;
  photo_id: string;
  person_id: string | null;
  assignment: 'auto' | 'manual';
  quality_ok: number;
  embedding: Float32Array | Uint8Array;
}

export interface AssignmentDecision {
  faceId: string;
  photoId: string;
  previousPersonId: string | null;
  newPersonId: string | null;
  distance: number;
  changed: boolean;
}

export interface AssignmentPlan {
  decisions: AssignmentDecision[];
  addedCountsByPersonId: Record<string, number>;
  totalReassigned: number;
  skippedManualCount: number;
}

export interface AssignFacesOptions {
  assignDistance?: number;
  othersPersonId?: string | null;
}

/**
 * Evaluates candidate faces against all named/confirmed person centroids in a trip.
 *
 * Rules (TRD §4):
 * - `assignment='manual'` (pinned) faces are never changed.
 * - `quality_ok=0` faces can be assigned to nearest centroid, but never form/move centroids.
 * - Candidate `assignment='auto'` faces are matched to the nearest centroid if distance < ASSIGN_DISTANCE.
 * - Same-photo constraint: a person cannot have multiple faces assigned from the exact same photo.
 *   If multiple faces in a photo are near the same person, only the closest face is assigned.
 * - Faces exceeding ASSIGN_DISTANCE are routed to Others (othersPersonId).
 */
export function planFaceAssignments(
  faces: FaceForAssignment[],
  peopleCentroids: PersonCentroidTarget[],
  options: AssignFacesOptions = {}
): AssignmentPlan {
  const assignDistance = options.assignDistance ?? CONFIG.ASSIGN_DISTANCE;
  const othersPersonId = options.othersPersonId ?? null;

  const decisions: AssignmentDecision[] = [];
  const addedCountsByPersonId: Record<string, number> = {};
  let totalReassigned = 0;
  let skippedManualCount = 0;

  // Prepare normalized Float32Array centroids
  const activeTargets = peopleCentroids
    .map((p) => ({
      id: p.id,
      name: p.name,
      centroid:
        p.centroid instanceof Float32Array
          ? p.centroid
          : blobToEmbedding(p.centroid),
    }))
    .filter((p) => p.centroid.length > 0);

  // If there are no person centroids to assign to, all auto faces route to Others
  if (activeTargets.length === 0) {
    for (const face of faces) {
      if (face.assignment === 'manual') {
        skippedManualCount++;
        decisions.push({
          faceId: face.id,
          photoId: face.photo_id,
          previousPersonId: face.person_id,
          newPersonId: face.person_id,
          distance: Infinity,
          changed: false,
        });
      } else {
        const changed = face.person_id !== othersPersonId;
        if (changed) totalReassigned++;
        decisions.push({
          faceId: face.id,
          photoId: face.photo_id,
          previousPersonId: face.person_id,
          newPersonId: othersPersonId,
          distance: Infinity,
          changed,
        });
      }
    }

    return {
      decisions,
      addedCountsByPersonId,
      totalReassigned,
      skippedManualCount,
    };
  }

  // 1. Separate pinned manual faces from auto candidates
  const candidateFaces: {
    face: FaceForAssignment;
    embedding: Float32Array;
  }[] = [];

  // Track already occupied (photo_id -> person_id) by manual faces to respect cannot-link
  const photoOccupiedPersons = new Set<string>();

  for (const face of faces) {
    if (face.assignment === 'manual') {
      skippedManualCount++;
      if (face.person_id) {
        photoOccupiedPersons.add(`${face.photo_id}:${face.person_id}`);
      }
      decisions.push({
        faceId: face.id,
        photoId: face.photo_id,
        previousPersonId: face.person_id,
        newPersonId: face.person_id,
        distance: Infinity,
        changed: false,
      });
    } else {
      const embedding =
        face.embedding instanceof Float32Array
          ? face.embedding
          : blobToEmbedding(face.embedding);
      candidateFaces.push({ face, embedding });
    }
  }

  // 2. Generate all candidate matches (face, person) where distance < assignDistance
  interface MatchCandidate {
    faceIndex: number;
    personId: string;
    photoId: string;
    distance: number;
  }

  const candidates: MatchCandidate[] = [];

  for (let fIdx = 0; fIdx < candidateFaces.length; fIdx++) {
    const { face, embedding } = candidateFaces[fIdx];
    for (const target of activeTargets) {
      const d = cosineDistance(embedding, target.centroid);
      if (d < assignDistance) {
        candidates.push({
          faceIndex: fIdx,
          personId: target.id,
          photoId: face.photo_id,
          distance: d,
        });
      }
    }
  }

  // 3. Sort candidates greedily by ascending distance
  candidates.sort((a, b) => a.distance - b.distance);

  const assignedFaceIndices = new Set<number>();
  const faceDecisionsByIndex = new Map<number, { personId: string; distance: number }>();

  for (const cand of candidates) {
    if (assignedFaceIndices.has(cand.faceIndex)) {
      continue;
    }

    const photoPersonKey = `${cand.photoId}:${cand.personId}`;
    if (photoOccupiedPersons.has(photoPersonKey)) {
      // Cannot-link constraint: person already has a face in this photo
      continue;
    }

    // Assign face to this person
    assignedFaceIndices.add(cand.faceIndex);
    photoOccupiedPersons.add(photoPersonKey);
    faceDecisionsByIndex.set(cand.faceIndex, {
      personId: cand.personId,
      distance: cand.distance,
    });
  }

  // 4. Record decisions for all candidate faces
  for (let fIdx = 0; fIdx < candidateFaces.length; fIdx++) {
    const { face } = candidateFaces[fIdx];
    const match = faceDecisionsByIndex.get(fIdx);

    const newPersonId = match ? match.personId : othersPersonId;
    const distance = match ? match.distance : Infinity;
    const changed = face.person_id !== newPersonId;

    if (changed) {
      totalReassigned++;
      if (newPersonId && newPersonId !== othersPersonId) {
        addedCountsByPersonId[newPersonId] =
          (addedCountsByPersonId[newPersonId] || 0) + 1;
      }
    }

    decisions.push({
      faceId: face.id,
      photoId: face.photo_id,
      previousPersonId: face.person_id,
      newPersonId,
      distance,
      changed,
    });
  }

  return {
    decisions,
    addedCountsByPersonId,
    totalReassigned,
    skippedManualCount,
  };
}
