export const FEATURE_NAMES = [
  'structure',
  'zones',
  'liquidity',
  'trigger',
  'indicator',
  'bos',
  'macd',
  'meanReversion',
] as const;

export type FeatureCalibrationName = (typeof FEATURE_NAMES)[number];

// Namesake of the unrelated `FEATURE_COUNT` in signal-builder.ts (the
// actual ML calibration model's feature count, 12 features) — renamed to
// avoid confusion. This one only sizes the heuristic scoring weights
// below (8 features) and is not used by CalibrationModel/useTickStore.ts.
export const HEURISTIC_FEATURE_COUNT = FEATURE_NAMES.length;

export const DEFAULT_WEIGHTS: Record<FeatureCalibrationName, number> = {
  structure: 2.0,
  zones: 1.5,
  liquidity: 1.2,
  trigger: 1.5,
  indicator: 0.8, // BUGFIX (факторный анализ): ema — 53% винрейт, N=66 —
                  // статистически на уровне монеты; вес снижен, не обнулён
  bos: 2.0,
  macd: 1.0,
  meanReversion: 1.0,
};
