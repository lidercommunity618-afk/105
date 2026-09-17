import { describe, it, expect } from 'vitest';
import { FEATURE_NAMES, HEURISTIC_FEATURE_COUNT, DEFAULT_WEIGHTS } from './featureCalibration';

describe('FEATURE_NAMES', () => {
  it('has 8 features', () => {
    expect(FEATURE_NAMES).toHaveLength(8);
  });

  it('includes all expected feature names', () => {
    expect(FEATURE_NAMES).toContain('structure');
    expect(FEATURE_NAMES).toContain('zones');
    expect(FEATURE_NAMES).toContain('liquidity');
    expect(FEATURE_NAMES).toContain('trigger');
    expect(FEATURE_NAMES).toContain('indicator');
    expect(FEATURE_NAMES).toContain('bos');
    expect(FEATURE_NAMES).toContain('macd');
    expect(FEATURE_NAMES).toContain('meanReversion');
  });

  it('has no duplicates', () => {
    expect(new Set(FEATURE_NAMES).size).toBe(FEATURE_NAMES.length);
  });
});

describe('HEURISTIC_FEATURE_COUNT', () => {
  it('matches FEATURE_NAMES length', () => {
    expect(HEURISTIC_FEATURE_COUNT).toBe(FEATURE_NAMES.length);
  });
});

describe('DEFAULT_WEIGHTS', () => {
  it('has a weight for every feature name', () => {
    for (const name of FEATURE_NAMES) {
      expect(DEFAULT_WEIGHTS[name]).toBeDefined();
      expect(typeof DEFAULT_WEIGHTS[name]).toBe('number');
    }
  });

  it('has no extra keys beyond FEATURE_NAMES', () => {
    const weightKeys = Object.keys(DEFAULT_WEIGHTS);
    expect(weightKeys.length).toBe(FEATURE_NAMES.length);
    for (const key of weightKeys) {
      expect(FEATURE_NAMES).toContain(key);
    }
  });

  it('assigns higher weights to structure and bos (primary signals)', () => {
    expect(DEFAULT_WEIGHTS.structure).toBe(2.0);
    expect(DEFAULT_WEIGHTS.bos).toBe(2.0);
  });

  it('assigns positive weights to all features', () => {
    for (const name of FEATURE_NAMES) {
      expect(DEFAULT_WEIGHTS[name]).toBeGreaterThan(0);
    }
  });
});
