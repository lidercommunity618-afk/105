/**
 * Partitioning logic for horizon-audit — extracted so it can be
 * unit-tested without running the full CLI (which needs network
 * access and heavy computation).
 *
 * These functions operate on Occurrence-like objects with just
 * `time`, `partition`, and `fold` fields — the minimal interface
 * needed for partitioning.
 */

export interface Partitionable {
  time: number;
  partition: 'train' | 'validation' | 'test';
  fold: number;
}

/**
 * Holdout partitioning by global timestamp across all pooled symbols.
 * Uses min/max timestamps across ALL occurrences to define
 * chronological boundaries, so symbols with different date ranges
 * are split consistently by wall-clock time.
 */
export function assignHoldoutPartitions<T extends Partitionable>(occurrences: T[]): void {
  if (occurrences.length === 0) return;
  let minTime = Infinity;
  let maxTime = -Infinity;
  for (const o of occurrences) {
    if (o.time < minTime) minTime = o.time;
    if (o.time > maxTime) maxTime = o.time;
  }
  const span = maxTime - minTime;
  if (span <= 0) return;
  const trainEnd = minTime + span * 0.6;
  const valEnd = minTime + span * 0.8;
  for (const o of occurrences) {
    if (o.time < trainEnd) o.partition = 'train';
    else if (o.time < valEnd) o.partition = 'validation';
    else o.partition = 'test';
  }
}

/**
 * Walk-forward partitioning: splits occurrences into N folds by
 * chronological timestamp. Each fold's test window is the last
 * segment of that fold's time span. A purge gap (purgeSeconds) is
 * removed between train+validation and test to prevent information
 * leakage from overlapping expiry outcomes.
 *
 * For each fold:
 *   train = all data before (foldStart + foldSize - purgeSeconds)
 *   test = data within [foldStart + foldSize - purgeSeconds, foldEnd)
 *
 * Actually: each fold gets a test window of size (foldSize - purgeSeconds)
 * at the end of the fold, with train being everything before the purge.
 * But to maximize test data, we use:
 *   test = [foldStart, foldEnd)  (the entire fold)
 *   train = everything before (foldStart - purgeSeconds)
 * This way every observation is in exactly one fold's test set, and
 * the purge gap prevents train data from leaking into test via
 * expiry outcomes that cross the boundary.
 */
export function assignWalkForwardPartitions<T extends Partitionable>(
  occurrences: T[],
  folds: number,
  purgeSeconds: number,
): void {
  if (occurrences.length === 0) return;
  let minTime = Infinity;
  let maxTime = -Infinity;
  for (const o of occurrences) {
    if (o.time < minTime) minTime = o.time;
    if (o.time > maxTime) maxTime = o.time;
  }
  const span = maxTime - minTime;
  if (span <= 0) return;

  const foldSize = span / folds;
  for (const o of occurrences) {
    const offset = o.time - minTime;
    const foldIdx = Math.min(Math.floor(offset / foldSize), folds - 1);
    o.fold = foldIdx;

    const foldStart = minTime + foldIdx * foldSize;
    const foldEnd = foldStart + foldSize;
    const testStart = foldStart + purgeSeconds;
    const testEnd = foldEnd;

    if (o.time >= testStart && o.time < testEnd) {
      o.partition = 'test';
    } else if (o.time < testStart) {
      o.partition = 'train';
    } else {
      o.partition = 'train';
    }
  }
}

/**
 * Computes the Wilson lower bound for a binomial proportion.
 * Re-exported from the shared module for convenience in backtest code.
 */
export { wilsonLowerBound } from '@/lib/wilson';
