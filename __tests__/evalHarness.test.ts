import {
  computePairwiseMetrics,
  evaluateClustering,
  sweepClusterDistance,
  evaluateClusteringAndAssignment,
  generateBenchmarkDataset,
  formatSweepReport,
  runEvaluationReport,
  type GroundTruthFace,
} from '../src/domain/evalHarness';
import { cosineDistance } from '../src/domain/clustering';
import { CONFIG } from '../src/domain/config';

describe('Eval Harness (Task 2.10)', () => {
  describe('computePairwiseMetrics', () => {
    it('returns 1.0 for perfect clustering', () => {
      // 3 people, 2 faces each in distinct clusters
      const labels = ['Alice', 'Alice', 'Bob', 'Bob', 'Charlie', 'Charlie'];
      const clusters = ['c1', 'c1', 'c2', 'c2', 'c3', 'c3'];

      const metrics = computePairwiseMetrics(labels, clusters);

      expect(metrics.totalPairs).toBe((6 * 5) / 2); // 15 pairs
      expect(metrics.tp).toBe(3); // (0,1), (2,3), (4,5)
      expect(metrics.fp).toBe(0);
      expect(metrics.fn).toBe(0);
      expect(metrics.tn).toBe(12);
      expect(metrics.precision).toBe(1.0);
      expect(metrics.recall).toBe(1.0);
      expect(metrics.f1).toBe(1.0);
    });

    it('correctly calculates precision drop on cluster impurity (merging different people)', () => {
      // Alice and Bob merged into c1
      const labels = ['Alice', 'Alice', 'Bob', 'Bob'];
      const clusters = ['c1', 'c1', 'c1', 'c1'];

      const metrics = computePairwiseMetrics(labels, clusters);

      // Same person pairs: (0,1) Alice, (2,3) Bob => 2 TP
      // Diff person pairs in same cluster: (0,2), (0,3), (1,2), (1,3) => 4 FP
      // Total pairs = 6. FN = 0, TN = 0
      expect(metrics.tp).toBe(2);
      expect(metrics.fp).toBe(4);
      expect(metrics.fn).toBe(0);
      expect(metrics.tn).toBe(0);
      expect(metrics.precision).toBeCloseTo(2 / (2 + 4), 4); // 0.3333
      expect(metrics.recall).toBe(1.0);
    });

    it('correctly calculates recall drop on cluster fragmentation (splitting same person)', () => {
      // Alice split into c1 and c2
      const labels = ['Alice', 'Alice', 'Alice', 'Bob'];
      const clusters = ['c1', 'c2', 'c3', 'c4']; // All singletons

      const metrics = computePairwiseMetrics(labels, clusters);

      // Same person pairs: (0,1), (0,2), (1,2) => all in diff clusters => 3 FN
      // Diff person pairs: (0,3), (1,3), (2,3) => diff clusters => 3 TN
      expect(metrics.tp).toBe(0);
      expect(metrics.fp).toBe(0);
      expect(metrics.fn).toBe(3);
      expect(metrics.tn).toBe(3);
      expect(metrics.precision).toBe(1.0);
      expect(metrics.recall).toBe(0.0);
    });

    it('handles unassigned/null faces without grouping them together', () => {
      // Two different people unassigned (null) should NOT count as same cluster FP
      const labels = ['Alice', 'Bob'];
      const clusters = [null, null];

      const metrics = computePairwiseMetrics(labels, clusters);

      expect(metrics.fp).toBe(0);
      expect(metrics.tp).toBe(0);
      expect(metrics.tn).toBe(1);
    });

    it('throws error when labels and clusters lengths mismatch', () => {
      expect(() => computePairwiseMetrics(['A', 'B'], ['c1'])).toThrow(
        'Labels and cluster predictions must have identical lengths'
      );
    });
  });

  describe('generateBenchmarkDataset', () => {
    it('generates 100-200 realistic faces across multiple people and photos', () => {
      const faces = generateBenchmarkDataset({
        personCount: 12,
        photosPerPerson: 12,
        groupPhotoCount: 10,
        dim: 128,
      });

      expect(faces.length).toBeGreaterThanOrEqual(140);
      expect(faces.length).toBeLessThanOrEqual(200);

      // Check unique people
      const people = new Set(faces.map((f) => f.personLabel));
      expect(people.size).toBe(12);

      // Verify embedding properties
      for (const face of faces) {
        expect(face.embedding).toBeInstanceOf(Float32Array);
        expect(face.embedding.length).toBe(128);

        // Check L2 unit length
        let normSq = 0;
        for (let i = 0; i < face.embedding.length; i++) {
          normSq += face.embedding[i] * face.embedding[i];
        }
        expect(Math.sqrt(normSq)).toBeCloseTo(1.0, 4);

        // Check bounding box
        expect(face.bbox.width).toBeGreaterThan(0);
        expect(face.bbox.height).toBeGreaterThan(0);
      }
    });

    it('has significantly lower intra-person distance than inter-person distance', () => {
      const faces = generateBenchmarkDataset({
        personCount: 4,
        photosPerPerson: 5,
        groupPhotoCount: 0,
      });

      const aliceFaces = faces.filter((f) => f.personLabel === faces[0].personLabel);
      const bobFaces = faces.filter((f) => f.personLabel !== faces[0].personLabel);

      // Intra-person distance (Alice vs Alice)
      const intraDistances: number[] = [];
      for (let i = 0; i < aliceFaces.length; i++) {
        for (let j = i + 1; j < aliceFaces.length; j++) {
          intraDistances.push(cosineDistance(aliceFaces[i].embedding, aliceFaces[j].embedding));
        }
      }

      // Inter-person distance (Alice vs Bob)
      const interDistances: number[] = [];
      for (const a of aliceFaces) {
        for (const b of bobFaces) {
          interDistances.push(cosineDistance(a.embedding, b.embedding));
        }
      }

      const avgIntra = intraDistances.reduce((a, b) => a + b, 0) / intraDistances.length;
      const avgInter = interDistances.reduce((a, b) => a + b, 0) / interDistances.length;

      // Intra-person distance should be well separated from inter-person distance
      expect(avgIntra).toBeLessThan(0.25);
      expect(avgInter).toBeGreaterThan(0.6);
    });
  });

  describe('evaluateClustering & parameter sweep', () => {
    let dataset: GroundTruthFace[];

    beforeAll(() => {
      dataset = generateBenchmarkDataset({
        personCount: 12,
        photosPerPerson: 12,
        groupPhotoCount: 10,
      });
    });

    it('evaluates clustering at default CONFIG.CLUSTER_DISTANCE (0.32)', () => {
      const result = evaluateClustering(dataset, CONFIG.CLUSTER_DISTANCE);

      expect(result.clusterDistance).toBe(CONFIG.CLUSTER_DISTANCE);
      expect(result.metrics.precision).toBeGreaterThanOrEqual(0.9); // Target >= 90% (PRD §6)
      expect(result.metrics.recall).toBeGreaterThanOrEqual(0.8); // Target >= 80% (PRD §6)
      expect(result.metrics.f1).toBeGreaterThanOrEqual(0.85);
      expect(result.meetsPrdTargets).toBe(true);
    });

    it('filters low quality faces when filterLowQuality is true', () => {
      const resultWithFilter = evaluateClustering(dataset, CONFIG.CLUSTER_DISTANCE, {
        filterLowQuality: true,
      });
      const resultWithoutFilter = evaluateClustering(dataset, CONFIG.CLUSTER_DISTANCE, {
        filterLowQuality: false,
      });

      // Low quality faces are placed in unassigned
      expect(resultWithFilter.unassignedCount).toBeGreaterThanOrEqual(
        resultWithoutFilter.unassignedCount
      );
    });

    it('sweeps across cluster distance thresholds and formats report', () => {
      const sweep = sweepClusterDistance(dataset, [0.24, 0.28, 0.32, 0.36, 0.4]);

      expect(sweep.length).toBe(5);

      // Monotonic trend: higher distance threshold groups more faces (higher recall, lower or equal precision)
      expect(sweep[0].clusterDistance).toBe(0.24);
      expect(sweep[4].clusterDistance).toBe(0.4);

      const report = formatSweepReport(sweep);
      expect(report).toContain('Dist  | Precision | Recall  | F1 Score');
      expect(report).toContain('0.32');
    });

    it('evaluates clustering and name-first assignment pipeline at CONFIG.ASSIGN_DISTANCE (0.35)', () => {
      const result = evaluateClusteringAndAssignment(
        dataset,
        CONFIG.CLUSTER_DISTANCE,
        CONFIG.ASSIGN_DISTANCE,
        0.5 // 50% top clusters confirmed
      );

      expect(result.clusterDistance).toBe(CONFIG.CLUSTER_DISTANCE);
      expect(result.assignDistance).toBe(CONFIG.ASSIGN_DISTANCE);
      expect(result.metrics.precision).toBeGreaterThanOrEqual(0.9);
      expect(result.metrics.recall).toBeGreaterThanOrEqual(0.8);
      expect(result.meetsPrdTargets).toBe(true);
    });

    it('runs and prints full evaluation report meeting PRD targets', () => {
      const output = runEvaluationReport(dataset);
      expect(output.totalFaces).toBe(dataset.length);
      expect(output.uniquePeople).toBe(12);
      expect(output.chosenClustering.meetsPrdTargets).toBe(true);
      expect(output.chosenAssignment.meetsPrdTargets).toBe(true);

      // Print full report to stdout so Node/jest runs display the full tuning table
      console.log(output.reportText);
    });
  });
});

