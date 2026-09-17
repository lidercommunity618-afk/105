import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Signal } from '@/types/domain';

describe('signal-persistence fallback (Supabase not configured)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
  });

  it('saveSignal is a no-op when Supabase is not configured', async () => {
    const { saveSignal } = await import('@/lib/signal-persistence');
    const signal = {
      id: 'test-1',
      symbolId: 'BTCUSDT',
      timeframe: '1m' as const,
      direction: 'buy' as const,
      strength: 'moderate' as const,
      score: 3.75,
      calibratedProbability: null,
      entryPrice: 50000,
      reason: 'Test signal',
      indicators: {} as unknown as Signal['indicators'],
      pattern: null,
      time: Date.now() / 1000,
      outcome: 'pending' as const,
      frozenAt: null,
      isRevised: false,
      isPreClose: false,
      revisionNote: null,
      barsToResolve: 5,
      spread: null,
      spreadSource: null,
      recommendedExpiry: 300,
      featureVector: [1, 2, 3],
      factors: [], rejectedPatterns: [], engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
      chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
      marketContext: { regime: 'range' as const, structure: { trend: 'range' as const, bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' as const },
    };
    await expect(saveSignal(signal)).resolves.toBeUndefined();
  });

  it('loadRecentSignals returns empty array when Supabase is not configured', async () => {
    const { loadRecentSignals } = await import('@/lib/signal-persistence');
    const result = await loadRecentSignals('BTCUSDT', '1m', 100);
    expect(result).toEqual([]);
  });

  it('updateSignalOutcome is a no-op when Supabase is not configured', async () => {
    const { updateSignalOutcome } = await import('@/lib/signal-persistence');
    await expect(updateSignalOutcome('test-1', 'win')).resolves.toBeUndefined();
  });

  it('deleteAllSignals is a no-op when Supabase is not configured', async () => {
    const { deleteAllSignals } = await import('@/lib/signal-persistence');
    await expect(deleteAllSignals()).resolves.toBeUndefined();
  });

  it('saveCalibrationState is a no-op when Supabase is not configured', async () => {
    const { saveCalibrationState } = await import('@/lib/signal-persistence');
    await expect(
      saveCalibrationState(
        { weights: [0, 0, 0], bias: 0, sampleCount: 0 },
        [],
      ),
    ).resolves.toBeUndefined();
  });

  it('loadCalibrationStateFromDb returns null when Supabase is not configured', async () => {
    const { loadCalibrationStateFromDb } = await import('@/lib/signal-persistence');
    const result = await loadCalibrationStateFromDb();
    expect(result).toBeNull();
  });
});
