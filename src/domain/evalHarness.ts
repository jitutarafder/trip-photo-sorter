import {
  clusterEmbeddings,
  computeCentroid,
  l2Normalize,
  type FaceEmbeddingItem,
} from './clustering';
import {
  planFaceAssignments,
  type FaceForAssignment,
  type PersonCentroidTarget,
} from './assignment';
import { CONFIG } from './config';

export interface GroundTruthFace {
  id: string;
  photoId: string;
  personLabel: string;
  embedding: Float32Array;
  bbox: { x: number; y: number; width: number; height: number };
  quality?: number;
  qualityOk?: boolean;
  blur?: number;
  yaw?: number;
}

export interface PairwiseMetrics {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  totalPairs: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface ThresholdSweepResult {
  clusterDistance: number;
  assignDistance?: number;
  metrics: PairwiseMetrics;
  clusterCount: number;
  unassignedCount: number;
  meetsPrdTargets: boolean; // precision >= 0.90 && recall >= 0.80 (01_PRD §6)
}

/**
 * Computes pairwise precision, recall, and F1 score for clustering against ground truth.
 *
 * Definition (Standard face clustering benchmark metrics, 01_PRD §6):
 * - Pair: every distinct unordered pair of faces (i, j) with i < j.
 * - TP: Same ground truth person AND same cluster.
 * - FP: Different ground truth people AND same cluster (impurity error).
 * - FN: Same ground truth person AND different clusters (fragmentation error).
 * - TN: Different ground truth people AND different clusters.
 *
 * Precision = TP / (TP + FP) -> measures cluster purity (PRD target >= 90%).
 * Recall    = TP / (TP + FN) -> measures cluster completeness (PRD target >= 80%).
 * F1        = 2 * P * R / (P + R).
 */
export function computePairwiseMetrics(
  groundTruthLabels: string[],
  predictedClusterIds: (string | null)[]
): PairwiseMetrics {
  const n = groundTruthLabels.length;
  if (n !== predictedClusterIds.length) {
    throw new Error('Labels and cluster predictions must have identical lengths');
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;

  for (let i = 0; i < n; i++) {
    const labelI = groundTruthLabels[i];
    const clusterI = predictedClusterIds[i];

    for (let j = i + 1; j < n; j++) {
      const labelJ = groundTruthLabels[j];
      const clusterJ = predictedClusterIds[j];

      const sameLabel = labelI === labelJ;
      // Faces in null (unclustered/others) do not form clusters together unless explicitly grouped
      const sameCluster = clusterI !== null && clusterJ !== null && clusterI === clusterJ;

      if (sameLabel && sameCluster) {
        tp++;
      } else if (!sameLabel && sameCluster) {
        fp++;
      } else if (sameLabel && !sameCluster) {
        fn++;
      } else {
        tn++;
      }
    }
  }

  const totalPairs = (n * (n - 1)) / 2;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1.0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1.0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    tp,
    fp,
    fn,
    tn,
    totalPairs,
    precision,
    recall,
    f1,
  };
}

/**
 * Evaluates clustering on a labelled dataset for a specific CLUSTER_DISTANCE threshold.
 */
export function evaluateClustering(
  faces: GroundTruthFace[],
  clusterDistance: number,
  options: {
    minClusterSize?: number;
    filterLowQuality?: boolean;
    blurMin?: number;
  } = {}
): ThresholdSweepResult {
  const minClusterSize = options.minClusterSize ?? CONFIG.MIN_CLUSTER_SIZE;
  const filterQuality = options.filterLowQuality ?? true;
  const blurMin = options.blurMin ?? CONFIG.BLUR_MIN;

  // Filter eligible faces (TRD §4: quality filter before clustering)
  const eligibleFaces: GroundTruthFace[] = [];

  faces.forEach((f) => {
    if (filterQuality) {
      if (f.qualityOk === false) {
        return;
      }
      if (f.blur !== undefined && f.blur < blurMin) {
        return;
      }
    }
    eligibleFaces.push(f);
  });

  const candidates: FaceEmbeddingItem[] = eligibleFaces.map((f) => ({
    id: f.id,
    photoId: f.photoId,
    embedding: f.embedding,
  }));

  const clusteringResult = clusterEmbeddings(candidates, clusterDistance, minClusterSize);

  // Map face IDs to cluster ID
  const faceClusterMap = new Map<string, string>();
  clusteringResult.clusters.forEach((c) => {
    c.itemIds.forEach((id) => {
      faceClusterMap.set(id, c.id);
    });
  });

  // Build full predicted clusters array matching original faces order
  const predictedClusters: (string | null)[] = faces.map((f) => {
    return faceClusterMap.get(f.id) ?? null;
  });

  const groundTruthLabels = faces.map((f) => f.personLabel);
  const metrics = computePairwiseMetrics(groundTruthLabels, predictedClusters);

  const unassignedCount = predictedClusters.filter((c) => c === null).length;
  const meetsPrdTargets = metrics.precision >= 0.9 && metrics.recall >= 0.8;

  return {
    clusterDistance,
    metrics,
    clusterCount: clusteringResult.clusters.length,
    unassignedCount,
    meetsPrdTargets,
  };
}

/**
 * Runs parameter grid search across multiple CLUSTER_DISTANCE thresholds.
 */
export function sweepClusterDistance(
  faces: GroundTruthFace[],
  distances: number[] = [0.24, 0.26, 0.28, 0.3, 0.32, 0.34, 0.36, 0.38, 0.4, 0.42, 0.45],
  options?: { minClusterSize?: number; filterLowQuality?: boolean; blurMin?: number }
): ThresholdSweepResult[] {
  return distances.map((dist) => evaluateClustering(faces, dist, options));
}

/**
 * Evaluates the full pipeline: clustering + name-first assignment.
 * When ground-truth people are named, checks if remaining faces are assigned to the correct centroid.
 */
export function evaluateClusteringAndAssignment(
  faces: GroundTruthFace[],
  clusterDistance: number,
  assignDistance: number,
  namedPeopleRatio: number = 0.5 // proportion of discovered people confirmed and named
): ThresholdSweepResult {
  // Step 1: Initial clustering
  const eligibleFaces = faces.filter((f) => f.qualityOk !== false);
  const candidates: FaceEmbeddingItem[] = eligibleFaces.map((f) => ({
    id: f.id,
    photoId: f.photoId,
    embedding: f.embedding,
  }));

  const clusteringResult = clusterEmbeddings(
    candidates,
    clusterDistance,
    CONFIG.MIN_CLUSTER_SIZE
  );

  // Step 2: Confirmation / naming of top clusters
  const faceClusterMap = new Map<string, string>();
  const faceMap = new Map<string, GroundTruthFace>();
  faces.forEach((f) => faceMap.set(f.id, f));

  // Sort clusters by size
  const sortedClusters = [...clusteringResult.clusters].sort(
    (a, b) => b.itemIds.length - a.itemIds.length
  );
  const namedCount = Math.max(1, Math.round(sortedClusters.length * namedPeopleRatio));

  const personCentroids: PersonCentroidTarget[] = [];
  const assignedFaceIds = new Set<string>();

  for (let i = 0; i < sortedClusters.length; i++) {
    const cluster = sortedClusters[i];
    if (i < namedCount) {
      // Confirmed as a named person: calculate centroid
      const clusterEmbeddings = cluster.itemIds
        .map((id) => faceMap.get(id)?.embedding)
        .filter((emb): emb is Float32Array => Boolean(emb));

      const centroid = computeCentroid(clusterEmbeddings);
      const personId = `person_${cluster.id}`;
      personCentroids.push({
        id: personId,
        centroid,
        name: `Person_${i + 1}`,
      });

      cluster.itemIds.forEach((id) => {
        faceClusterMap.set(id, personId);
        assignedFaceIds.add(id);
      });
    } else {
      // Remaining clusters are unconfirmed
      cluster.itemIds.forEach((id) => {
        faceClusterMap.set(id, `cluster_${cluster.id}`);
      });
    }
  }

  // Step 3: Name-first assignment of remaining candidate faces
  const unassignedCandidates: FaceForAssignment[] = eligibleFaces
    .filter((f) => !assignedFaceIds.has(f.id))
    .map((f) => ({
      id: f.id,
      photo_id: f.photoId,
      person_id: null,
      assignment: 'auto',
      quality_ok: 1,
      embedding: f.embedding,
    }));

  if (personCentroids.length > 0 && unassignedCandidates.length > 0) {
    const assignmentPlan = planFaceAssignments(unassignedCandidates, personCentroids, {
      assignDistance,
    });
    for (const decision of assignmentPlan.decisions) {
      if (decision.newPersonId) {
        faceClusterMap.set(decision.faceId, decision.newPersonId);
      }
    }
  }

  const predictedClusters = faces.map((f) => faceClusterMap.get(f.id) ?? null);
  const groundTruthLabels = faces.map((f) => f.personLabel);
  const metrics = computePairwiseMetrics(groundTruthLabels, predictedClusters);
  const unassignedCount = predictedClusters.filter((c) => c === null).length;
  const meetsPrdTargets = metrics.precision >= 0.9 && metrics.recall >= 0.8;

  return {
    clusterDistance,
    assignDistance,
    metrics,
    clusterCount: clusteringResult.clusters.length,
    unassignedCount,
    meetsPrdTargets,
  };
}

/**
 * Generates a synthetic, reproducible benchmark dataset (100–200 faces).
 * Mimics MobileFaceNet 128-d embeddings:
 * - High intra-person cosine similarity (0.80–0.95 -> cosine distance 0.05–0.20)
 * - Low inter-person cosine similarity (0.00–0.40 -> cosine distance 0.60–1.00)
 * - Realistic photo distribution (single-person photos and group photos with cannot-link constraints)
 * - Quality attributes (confidence, blur, yaw)
 */
export function generateBenchmarkDataset(
  options: {
    personCount?: number;
    photosPerPerson?: number;
    groupPhotoCount?: number;
    dim?: number;
    noiseScale?: number;
  } = {}
): GroundTruthFace[] {
  const personCount = options.personCount ?? 12; // 12 distinct individuals
  const photosPerPerson = options.photosPerPerson ?? 12; // ~12 photos each -> ~144 solo faces
  const groupPhotoCount = options.groupPhotoCount ?? 10; // 10 group photos with 2-4 people
  const dim = options.dim ?? 128;
  const noiseScale = options.noiseScale ?? 0.5; // Yields intra-person cosine distance ~0.10 - 0.20

  // Simple pseudo-random linear congruential generator for reproducible datasets
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const randNorm = () => {
    const u = Math.max(1e-7, rand());
    const v = rand();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  };

  // Generate random unit vector on unit sphere
  const randomUnitVector = (): Float32Array => {
    const vec = new Float32Array(dim);
    for (let d = 0; d < dim; d++) {
      vec[d] = randNorm();
    }
    return l2Normalize(vec);
  };

  // Generate distinct base embeddings for each person
  const personBaseVectors: Float32Array[] = [];
  const personNames = [
    'Alice',
    'Bob',
    'Charlie',
    'David',
    'Emma',
    'Farhan',
    'Grace',
    'Hasan',
    'Isha',
    'Jamil',
    'Kamal',
    'Lina',
    'Maya',
    'Nabil',
    'Omar',
  ];

  for (let p = 0; p < personCount; p++) {
    personBaseVectors.push(randomUnitVector());
  }

  const faces: GroundTruthFace[] = [];
  let faceCounter = 1;
  let photoCounter = 1;

  // Helper to generate a face sample for person p in a given photo
  const createFace = (
    personIdx: number,
    photoId: string,
    isLowQuality = false
  ): GroundTruthFace => {
    const base = personBaseVectors[personIdx];
    const noiseVec = randomUnitVector();
    const perturbed = new Float32Array(dim);
    for (let d = 0; d < dim; d++) {
      perturbed[d] = base[d] + noiseVec[d] * noiseScale;
    }
    const embedding = l2Normalize(perturbed);

    const faceId = `face_${faceCounter++}`;
    const blur = isLowQuality ? 15 + rand() * 15 : 45 + rand() * 50;
    const quality = isLowQuality ? 0.35 + rand() * 0.12 : 0.85 + rand() * 0.14;

    return {
      id: faceId,
      photoId,
      personLabel: personNames[personIdx] ?? `Person_${personIdx}`,
      embedding,
      bbox: {
        x: 0.1 + rand() * 0.6,
        y: 0.1 + rand() * 0.6,
        width: 0.15 + rand() * 0.1,
        height: 0.15 + rand() * 0.1,
      },
      quality,
      qualityOk: !isLowQuality,
      blur,
      yaw: 0.1 + rand() * 0.3,
    };
  };

  // 1. Generate solo photos
  for (let p = 0; p < personCount; p++) {
    for (let s = 0; s < photosPerPerson; s++) {
      const photoId = `photo_solo_${photoCounter++}`;
      // 5% low quality faces (blurred/backlit)
      const isLowQuality = rand() < 0.05;
      faces.push(createFace(p, photoId, isLowQuality));
    }
  }

  // 2. Generate group photos (with cannot-link same-photo constraint)
  for (let g = 0; g < groupPhotoCount; g++) {
    const photoId = `photo_group_${photoCounter++}`;
    // Pick 2 to 4 distinct people for this group photo
    const attendees = new Set<number>();
    const groupSize = 2 + Math.floor(rand() * 3);
    while (attendees.size < Math.min(groupSize, personCount)) {
      attendees.add(Math.floor(rand() * personCount));
    }
    for (const attendee of attendees) {
      faces.push(createFace(attendee, photoId, false));
    }
  }

  return faces;
}

/**
 * Formats threshold sweep results into an evaluation summary table.
 */
export function formatSweepReport(results: ThresholdSweepResult[]): string {
  const lines: string[] = [];
  lines.push(
    'Dist  | Precision | Recall  | F1 Score | Clusters | Unassigned | Meets PRD (P>=90%, R>=80%)'
  );
  lines.push(
    '------+-----------+---------+----------+----------+------------+---------------------------'
  );

  for (const r of results) {
    const distStr = r.clusterDistance.toFixed(2).padEnd(5);
    const precStr = (r.metrics.precision * 100).toFixed(1) + '%';
    const recStr = (r.metrics.recall * 100).toFixed(1) + '%';
    const f1Str = (r.metrics.f1 * 100).toFixed(1) + '%';
    const clusStr = String(r.clusterCount).padEnd(8);
    const unassStr = String(r.unassignedCount).padEnd(10);
    const status = r.meetsPrdTargets ? '✓ PASS' : '✗ FAIL';

    lines.push(
      `${distStr} | ${precStr.padEnd(9)} | ${recStr.padEnd(7)} | ${f1Str.padEnd(8)} | ${clusStr} | ${unassStr} | ${status}`
    );
  }

  return lines.join('\n');
}

export interface FullEvaluationOutput {
  datasetSource: string;
  totalFaces: number;
  uniquePeople: number;
  clusterSweep: ThresholdSweepResult[];
  assignSweep: ThresholdSweepResult[];
  chosenClustering: ThresholdSweepResult;
  chosenAssignment: ThresholdSweepResult;
  reportText: string;
}

/**
 * Runs the complete evaluation and threshold tuning sweep.
 */
export function runEvaluationReport(customFaces?: GroundTruthFace[]): FullEvaluationOutput {
  const faces =
    customFaces && customFaces.length > 0
      ? customFaces
      : generateBenchmarkDataset({
          personCount: 12,
          photosPerPerson: 12,
          groupPhotoCount: 10,
          dim: 128,
        });

  const datasetSource =
    customFaces && customFaces.length > 0
      ? 'Custom / Local Dataset'
      : 'Benchmark Dataset (12 people, 172 faces, 144 solo + 28 group)';

  const uniquePeople = new Set(faces.map((f) => f.personLabel)).size;

  // 1. Cluster Distance Sweep
  const clusterDistances = [0.24, 0.26, 0.28, 0.30, 0.32, 0.34, 0.36, 0.38, 0.40];
  const clusterSweep = clusterDistances.map((dist) => evaluateClustering(faces, dist));

  // 2. Assign Distance Sweep
  const assignDistances = [0.28, 0.30, 0.32, 0.35, 0.38, 0.40];
  const assignSweep = assignDistances.map((assignDist) =>
    evaluateClusteringAndAssignment(faces, CONFIG.CLUSTER_DISTANCE, assignDist, 0.5)
  );

  // 3. Chosen Configuration
  const chosenClustering = evaluateClustering(faces, CONFIG.CLUSTER_DISTANCE);
  const chosenAssignment = evaluateClusteringAndAssignment(
    faces,
    CONFIG.CLUSTER_DISTANCE,
    CONFIG.ASSIGN_DISTANCE,
    0.5
  );

  const reportLines: string[] = [];
  reportLines.push('========================================================================');
  reportLines.push('           TRIP PHOTO SORTER — EVALUATION & TUNING HARNESS              ');
  reportLines.push('   PRD Targets (01_PRD §6): Precision >= 90%, Recall >= 80%             ');
  reportLines.push('========================================================================');
  reportLines.push(`Dataset: ${datasetSource}`);
  reportLines.push(`Total Faces: ${faces.length}`);
  reportLines.push(`Unique People: ${uniquePeople}\n`);

  reportLines.push('--- 1. CLUSTER_DISTANCE SWEEP (Clustering Only) ---');
  reportLines.push(formatSweepReport(clusterSweep));
  reportLines.push('');

  reportLines.push('--- 2. ASSIGN_DISTANCE SWEEP (Clustering + Name-First Assignment) ---');
  reportLines.push(
    'AssignDist | Precision | Recall  | F1 Score | Clusters | Unassigned | Meets PRD (P>=90%, R>=80%)'
  );
  reportLines.push(
    '-----------+-----------+---------+----------+----------+------------+---------------------------'
  );
  for (const r of assignSweep) {
    const distStr = (r.assignDistance ?? 0).toFixed(2).padEnd(10);
    const precStr = (r.metrics.precision * 100).toFixed(1) + '%';
    const recStr = (r.metrics.recall * 100).toFixed(1) + '%';
    const f1Str = (r.metrics.f1 * 100).toFixed(1) + '%';
    const clusStr = String(r.clusterCount).padEnd(8);
    const unassStr = String(r.unassignedCount).padEnd(10);
    const status = r.meetsPrdTargets ? '✓ PASS' : '✗ FAIL';
    reportLines.push(
      `${distStr} | ${precStr.padEnd(9)} | ${recStr.padEnd(7)} | ${f1Str.padEnd(8)} | ${clusStr} | ${unassStr} | ${status}`
    );
  }
  reportLines.push('');

  reportLines.push('========================================================================');
  reportLines.push('                       CHOSEN PARAMETERS SUMMARY                        ');
  reportLines.push('========================================================================');
  reportLines.push(`• CLUSTER_DISTANCE: ${CONFIG.CLUSTER_DISTANCE}`);
  reportLines.push(
    `  - Pairwise Precision: ${(chosenClustering.metrics.precision * 100).toFixed(1)}% (Target >= 90%)`
  );
  reportLines.push(
    `  - Pairwise Recall:    ${(chosenClustering.metrics.recall * 100).toFixed(1)}% (Target >= 80%)`
  );
  reportLines.push(
    `  - Pairwise F1 Score:  ${(chosenClustering.metrics.f1 * 100).toFixed(1)}%`
  );
  reportLines.push(`• ASSIGN_DISTANCE:  ${CONFIG.ASSIGN_DISTANCE}`);
  reportLines.push(
    `  - Pairwise Precision: ${(chosenAssignment.metrics.precision * 100).toFixed(1)}% (Target >= 90%)`
  );
  reportLines.push(
    `  - Pairwise Recall:    ${(chosenAssignment.metrics.recall * 100).toFixed(1)}% (Target >= 80%)`
  );
  reportLines.push(
    `  - Pairwise F1 Score:  ${(chosenAssignment.metrics.f1 * 100).toFixed(1)}%`
  );
  reportLines.push(`• BLUR_MIN:         ${CONFIG.BLUR_MIN}`);
  reportLines.push('========================================================================\n');

  return {
    datasetSource,
    totalFaces: faces.length,
    uniquePeople,
    clusterSweep,
    assignSweep,
    chosenClustering,
    chosenAssignment,
    reportText: reportLines.join('\n'),
  };
}

