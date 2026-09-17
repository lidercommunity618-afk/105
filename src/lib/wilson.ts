/**
 * Wilson score interval lower bound — shared between UI calibration
 * (pattern-reliability-calibration.ts) and backtest horizon-audit.
 * Extracted so the backtest can import it without pulling in UI
 * dependencies (factor-analytics, pattern-categories).
 */
export function wilsonLowerBound(wins: number, n: number, z: number = 1.96): number {
  if (n <= 0) return 0;
  const phat = wins / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denominator);
}
