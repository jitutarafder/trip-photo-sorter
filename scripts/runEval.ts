import * as fs from 'fs';
import * as path from 'path';
import {
  evaluateClustering,
  evaluateClusteringAndAssignment,
  generateBenchmarkDataset,
  formatSweepReport,
  type GroundTruthFace,
  type ThresholdSweepResult,
} from '../src/domain/evalHarness';
import { CONFIG } from '../src/domain/config';

function loadOrGenerateDataset(): { faces: GroundTruthFace[]; source: string } {
  const localEvalPath = path.resolve(__dirname, '../eval/dataset.json');

  if (fs.existsSync(localEvalPath)) {
    try {
      const raw = fs.readFileSync(localEvalPath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Reconstitute Float32Array embeddings
      const faces: GroundTruthFace[] = parsed.map((item: any) => ({
        ...item,
        embedding: new Float32Array(item.embedding),
      }));
      return { faces, source: `Local ground-truth file (${localEvalPath})` };
    } catch (err) {
      console.warn(`Failed to parse ${localEvalPath}, falling back to benchmark generator:`, err);
    }
  }

  // Generate reproducible 100-200 photo benchmark dataset (172 faces)
  const faces = generateBenchmarkDataset({
    personCount: 12,
    photosPerPerson: 12,
    groupPhotoCount: 10,
    dim: 128,
  });
  return {
    faces,
    source: 'Reproducible 172-face benchmark dataset (12 people, 144 solo + 28 group faces)',
  };
}

export function runFullEvaluation() {
  console.log('========================================================================');
  console.log('           TRIP PHOTO SORTER — EVALUATION & TUNING HARNESS              ');
  console.log('   PRD Targets (01_PRD §6): Precision >= 90%, Recall >= 80%             ');
  console.log('========================================================================\n');

  const { faces, source } = loadOrGenerateDataset();
  console.log(`Dataset: ${source}`);
  console.log(`Total Faces: ${faces.length}`);
  const uniquePeople = new Set(faces.map((f) => f.personLabel));
  console.log(`Unique People: ${uniquePeople.size} (${Array.from(uniquePeople).join(', ')})\n`);

  // 1. Sweep CLUSTER_DISTANCE
  console.log('--- 1. CLUSTER_DISTANCE SWEEP (Clustering Only) ---');
  const clusterDistances = [0.24, 0.26, 0.28, 0.30, 0.32, 0.34, 0.36, 0.38, 0.40];
  const clusterResults: ThresholdSweepResult[] = clusterDistances.map((dist) =>
    evaluateClustering(faces, dist)
  );
  console.log(formatSweepReport(clusterResults));
  console.log('');

  // 2. Sweep ASSIGN_DISTANCE
  console.log('--- 2. ASSIGN_DISTANCE SWEEP (Clustering + Name-First Assignment) ---');
  const assignDistances = [0.28, 0.30, 0.32, 0.35, 0.38, 0.40];
  const assignResults: ThresholdSweepResult[] = assignDistances.map((assignDist) =>
    evaluateClusteringAndAssignment(faces, CONFIG.CLUSTER_DISTANCE, assignDist, 0.5)
  );

  console.log(
    'AssignDist | Precision | Recall  | F1 Score | Clusters | Unassigned | Meets PRD (P>=90%, R>=80%)'
  );
  console.log(
    '-----------+-----------+---------+----------+----------+------------+---------------------------'
  );
  for (const r of assignResults) {
    const distStr = (r.assignDistance ?? 0).toFixed(2).padEnd(10);
    const precStr = (r.metrics.precision * 100).toFixed(1) + '%';
    const recStr = (r.metrics.recall * 100).toFixed(1) + '%';
    const f1Str = (r.metrics.f1 * 100).toFixed(1) + '%';
    const clusStr = String(r.clusterCount).padEnd(8);
    const unassStr = String(r.unassignedCount).padEnd(10);
    const status = r.meetsPrdTargets ? '✓ PASS' : '✗ FAIL';
    console.log(
      `${distStr} | ${precStr.padEnd(9)} | ${recStr.padEnd(7)} | ${f1Str.padEnd(8)} | ${clusStr} | ${unassStr} | ${status}`
    );
  }
  console.log('');

  // 3. Quality Filter (Blur threshold impact)
  console.log('--- 3. QUALITY FILTER / BLUR THRESHOLD ABLATION ---');
  const blurThresholds = [0, 20, 35, 50];
  console.log('Blur Min | Precision | Recall  | F1 Score | Excluded Low-Quality Faces');
  console.log('---------+-----------+---------+----------+---------------------------');
  for (const blurMin of blurThresholds) {
    const res = evaluateClustering(faces, CONFIG.CLUSTER_DISTANCE, {
      filterLowQuality: blurMin > 0,
      blurMin,
    });
    const blurStr = String(blurMin).padEnd(8);
    const precStr = (res.metrics.precision * 100).toFixed(1) + '%';
    const recStr = (res.metrics.recall * 100).toFixed(1) + '%';
    const f1Str = (res.metrics.f1 * 100).toFixed(1) + '%';
    const excluded = res.unassignedCount;
    console.log(
      `${blurStr} | ${precStr.padEnd(9)} | ${recStr.padEnd(7)} | ${f1Str.padEnd(8)} | ${excluded}`
    );
  }
  console.log('');

  // 4. Chosen Configuration Summary
  const chosenClustering = evaluateClustering(faces, CONFIG.CLUSTER_DISTANCE);
  const chosenAssignment = evaluateClusteringAndAssignment(
    faces,
    CONFIG.CLUSTER_DISTANCE,
    CONFIG.ASSIGN_DISTANCE,
    0.5
  );

  console.log('========================================================================');
  console.log('                       CHOSEN PARAMETERS SUMMARY                        ');
  console.log('========================================================================');
  console.log(`• CLUSTER_DISTANCE: ${CONFIG.CLUSTER_DISTANCE}`);
  console.log(
    `  - Pairwise Precision: ${(chosenClustering.metrics.precision * 100).toFixed(1)}% (Target >= 90%)`
  );
  console.log(
    `  - Pairwise Recall:    ${(chosenClustering.metrics.recall * 100).toFixed(1)}% (Target >= 80%)`
  );
  console.log(
    `  - Pairwise F1 Score:  ${(chosenClustering.metrics.f1 * 100).toFixed(1)}%`
  );
  console.log(`• ASSIGN_DISTANCE:  ${CONFIG.ASSIGN_DISTANCE}`);
  console.log(
    `  - Pairwise Precision: ${(chosenAssignment.metrics.precision * 100).toFixed(1)}% (Target >= 90%)`
  );
  console.log(
    `  - Pairwise Recall:    ${(chosenAssignment.metrics.recall * 100).toFixed(1)}% (Target >= 80%)`
  );
  console.log(
    `  - Pairwise F1 Score:  ${(chosenAssignment.metrics.f1 * 100).toFixed(1)}%`
  );
  console.log(`• BLUR_MIN:         ${CONFIG.BLUR_MIN}`);
  console.log('========================================================================\n');

  return {
    chosenClustering,
    chosenAssignment,
  };
}

if (require.main === module) {
  runFullEvaluation();
}
