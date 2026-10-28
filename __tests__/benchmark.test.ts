import {
  run300PhotoBenchmark,
  formatBenchmarkReport,
  getCurrentMemoryUsageMb,
} from '../src/services/tripBenchmark';

describe('Task 2.11 — 300-Photo Trip Benchmark', () => {
  it('returns valid memory usage in current environment', () => {
    const mem = getCurrentMemoryUsageMb();
    expect(typeof mem).toBe('number');
    expect(mem).toBeGreaterThan(0);
  });

  it('runs a 50-photo smoke benchmark quickly with valid metrics', async () => {
    const result = await run300PhotoBenchmark({
      photoCount: 50,
      personCount: 8,
    });

    expect(result.photoCount).toBe(50);
    expect(result.facesFound).toBeGreaterThan(0);
    expect(result.qualityOkFaces).toBeGreaterThan(0);
    expect(result.clustersCount).toBeGreaterThan(0);
    expect(result.peakMemoryMb).toBeLessThan(400); // PRD target: < 400 MB
    expect(result.peakMemoryPassed).toBe(true);
    expect(result.totalTimePassed).toBe(true);
    expect(result.meetsAllTargets).toBe(true);
  });

  it('benchmarks full 300-photo trip: measures scan time, throughput, and peak memory', async () => {
    const result = await run300PhotoBenchmark({
      photoCount: 300,
      personCount: 15,
      concurrency: 2,
    });

    const report = formatBenchmarkReport(result);
    // Print report to test output for documentation
    console.log(report);

    // Assertions against 01_PRD §6 Success Metrics:
    // 1. Photo count is 300
    expect(result.photoCount).toBe(300);

    // 2. Realistic face count (~400-500 faces across 300 photos with solo and group shots)
    expect(result.facesFound).toBeGreaterThan(250);
    expect(result.qualityOkFaces).toBeGreaterThan(200);

    // 3. Peak memory is under 400 MB (PRD §6 target)
    expect(result.peakMemoryMb).toBeLessThan(400);
    expect(result.peakMemoryPassed).toBe(true);

    // 4. Total duration is under 3 min (180,000 ms)
    expect(result.totalDurationMs).toBeLessThan(180000);
    expect(result.totalTimePassed).toBe(true);

    // 5. Overall targets met
    expect(result.meetsAllTargets).toBe(true);

    // 6. Memory stability: memory delta is bounded
    expect(result.memoryDeltaMb).toBeLessThan(150);
  });
});
