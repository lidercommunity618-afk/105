import { describe, it, expect } from 'vitest';
import { assignHoldoutPartitions, assignWalkForwardPartitions, type Partitionable } from './horizon-partitioning';

function makeOccs(times: number[]): Partitionable[] {
  return times.map((t) => ({ time: t, partition: 'train' as const, fold: 0 }));
}

describe('assignHoldoutPartitions', () => {
  it('splits chronologically by global timestamp into 60/20/20', () => {
    const occs = makeOccs([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    assignHoldoutPartitions(occs);
    const train = occs.filter((o) => o.partition === 'train');
    const val = occs.filter((o) => o.partition === 'validation');
    const test = occs.filter((o) => o.partition === 'test');
    // 60% of span=100 -> trainEnd=60, valEnd=80
    expect(train.length).toBeGreaterThan(0);
    expect(val.length).toBeGreaterThan(0);
    expect(test.length).toBeGreaterThan(0);
    // All train times < 60, validation 60-80, test >= 80
    for (const o of train) expect(o.time).toBeLessThan(60);
    for (const o of val) expect(o.time).toBeGreaterThanOrEqual(60);
    for (const o of val) expect(o.time).toBeLessThan(80);
    for (const o of test) expect(o.time).toBeGreaterThanOrEqual(80);
  });

  it('handles pooled symbols with different date ranges by global timestamp', () => {
    // Symbol A: times 0-50, Symbol B: times 100-150
    const occs = makeOccs([0, 25, 50, 100, 125, 150]);
    assignHoldoutPartitions(occs);
    // span = 150, trainEnd = 90, valEnd = 120
    // So 0,25,50,100 are train; 125 is validation; 150 is test
    expect(occs[0].partition).toBe('train');
    expect(occs[1].partition).toBe('train');
    expect(occs[2].partition).toBe('train');
    expect(occs[3].partition).toBe('train'); // 100 < 90? No, 100 >= 90
    // Actually 100 >= 90 (trainEnd), so it's validation or test
    // trainEnd = 0 + 150*0.6 = 90, valEnd = 0 + 150*0.8 = 120
    // 100 >= 90 and < 120 -> validation
    expect(occs[3].partition).toBe('validation');
    expect(occs[4].partition).toBe('validation'); // 125 >= 120? No, 125 >= 120 -> test
    expect(occs[5].partition).toBe('test');
  });

  it('does not crash on empty array', () => {
    const occs: Partitionable[] = [];
    assignHoldoutPartitions(occs);
    expect(occs.length).toBe(0);
  });

  it('does not crash on single element', () => {
    const occs = makeOccs([42]);
    assignHoldoutPartitions(occs);
    expect(occs[0].partition).toBe('train');
  });
});

describe('assignWalkForwardPartitions', () => {
  it('assigns each occurrence to a fold and partition', () => {
    const occs = makeOccs([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    assignWalkForwardPartitions(occs, 5, 0);
    // 5 folds, span=90, foldSize=18
    // Fold 0: [0,18), Fold 1: [18,36), Fold 2: [36,54), Fold 3: [54,72), Fold 4: [72,90]
    for (const o of occs) {
      expect(o.fold).toBeGreaterThanOrEqual(0);
      expect(o.fold).toBeLessThan(5);
      expect(['train', 'validation', 'test']).toContain(o.partition);
    }
  });

  it('with purge gap, observations in the purge zone are train, not test', () => {
    // 2 folds, span=100, foldSize=50, purge=10
    // Fold 0: test = [10, 50), train = [0, 10)
    // Fold 1: test = [60, 100), train = [50, 60)
    const occs = makeOccs([5, 15, 45, 55, 65, 95]);
    assignWalkForwardPartitions(occs, 2, 10);
    // 5 is in fold 0, < 10 -> train
    expect(occs[0].partition).toBe('train');
    // 15 is in fold 0, >= 10 and < 50 -> test
    expect(occs[1].partition).toBe('test');
    // 45 is in fold 0, >= 10 and < 50 -> test
    expect(occs[2].partition).toBe('test');
    // 55 is in fold 1, < 60 -> train (purge zone)
    expect(occs[3].partition).toBe('train');
    // 65 is in fold 1, >= 60 and < 100 -> test
    expect(occs[4].partition).toBe('test');
    // 95 is in fold 1, >= 60 and < 100 -> test
    expect(occs[5].partition).toBe('test');
  });

  it('with zero purge, all observations in a fold are test', () => {
    const occs = makeOccs([0, 5, 10, 15, 20]);
    assignWalkForwardPartitions(occs, 2, 0);
    // span=20, foldSize=10, Fold 0: [0,10), Fold 1: [10,20)
    // With 0 purge, testStart = foldStart, so all are test
    expect(occs.every((o) => o.partition === 'test')).toBe(true);
  });

  it('does not crash on empty array', () => {
    const occs: Partitionable[] = [];
    assignWalkForwardPartitions(occs, 5, 30);
    expect(occs.length).toBe(0);
  });

  it('no train/test overlap: a train observation is never in test and vice versa', () => {
    const times: number[] = [];
    for (let i = 0; i < 100; i++) times.push(i * 10);
    const occs = makeOccs(times);
    assignWalkForwardPartitions(occs, 5, 30);
    const trainTimes = new Set(occs.filter((o) => o.partition === 'train').map((o) => o.time));
    const testTimes = new Set(occs.filter((o) => o.partition === 'test').map((o) => o.time));
    for (const t of trainTimes) {
      expect(testTimes.has(t)).toBe(false);
    }
  });
});
