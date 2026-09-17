import { describe, it, expect } from 'vitest';
import { patternResultSchema, type PatternResult } from './domain';

// Regression test for the "Реакция на снятие ликвидности" quality review
// (2026-09-01): patternResultSchema had drifted out of sync with the actual
// PatternResult interface — several optional fields (breakoutLow/High,
// sweepLow/High, oppositeZonePrice, setupType) were missing from the schema.
// Nothing calls patternResultSchema.parse() in the live pipeline today (the
// worker boundary uses postMessage's structured clone, not zod), so this
// was harmless in practice — but zod strips unknown keys by default, so the
// moment anyone adds runtime validation at that boundary, an out-of-sync
// schema would silently drop these fields, breaking the structural SL/TP
// inputs they carry without any visible error. This test parses a
// PatternResult with every optional field populated and asserts nothing is
// lost, so a future field added to the interface but not the schema fails
// loudly here instead of silently in production.
describe('patternResultSchema', () => {
  it('round-trips every optional PatternResult field without stripping any', () => {
    const full: PatternResult = {
      name: 'liquidity-sweep-reaction',
      direction: 'buy',
      confidence: 0.8,
      strength: 'strong',
      time: 12345,
      volumeConfirmed: false,
      confirmedByNextCandle: true,
      confluenceFactors: ['ob'],
      breakoutLow: 1.1,
      breakoutHigh: 1.2,
      sweepLow: 1.05,
      sweepHigh: 1.15,
      oppositeZonePrice: 1.3,
      setupType: 'reversal-at-key-level',
      targetZone: 1.25,
      harmonicType: 'gartley',
      przLow: 1.18,
      przHigh: 1.22,
      harmonicStop: 1.12,
      harmonicTarget: 1.28,
    };

    const parsed = patternResultSchema.parse(full);
    expect(parsed).toEqual(full);
  });

  it('accepts a null oppositeZonePrice (no opposite zone found)', () => {
    const result = patternResultSchema.safeParse({
      name: 'liquidity-sweep-reaction',
      direction: 'sell',
      confidence: 0.75,
      strength: 'moderate',
      time: 1,
      oppositeZonePrice: null,
    });
    expect(result.success).toBe(true);
  });
});
