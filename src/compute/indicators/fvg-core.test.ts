import { describe, it, expect } from 'vitest';
import { fvgRenderCutoff } from '@/compute/indicators/fvg-core';

describe('fvgRenderCutoff', () => {
  it('does not cut the box off when the zone was touched (CE wick) but not invalidated', () => {
    // Regression test for the ChartPanel.tsx bug where the box's right edge
    // was cut at touchedTime, making a still-live/tradeable zone (per
    // pickFreshUnbrokenFvgs in fvg-strategies-shared.ts, which filters only
    // on !broken) look "finished" on the chart.
    const zone = { broken: false, endTime: null };
    expect(fvgRenderCutoff(zone)).toBeNull();
  });

  it('still returns null for an unbroken zone even if it has a touchedTime field set elsewhere', () => {
    // fvgRenderCutoff intentionally takes no touchedTime parameter at all —
    // touched state must never influence the cutoff.
    const zone = { broken: false, endTime: null };
    expect(fvgRenderCutoff(zone)).toBeNull();
  });

  it('cuts the box off at endTime once the zone is fully invalidated (close through the far boundary)', () => {
    const zone = { broken: true, endTime: 1700003600 };
    expect(fvgRenderCutoff(zone)).toBe(1700003600);
  });

  it('returns null for a broken zone with no recorded endTime (defensive fallback)', () => {
    const zone = { broken: true, endTime: null };
    expect(fvgRenderCutoff(zone)).toBeNull();
  });
});
