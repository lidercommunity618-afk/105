import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getActiveFeatures, notifySignal } from './shared';
import { sigmoidFallback } from '@/decision/signal-builder';
import type { Signal } from '@/types/domain';

vi.mock('@/lib/audio', () => ({
  playSignalAlert: vi.fn(),
  playPriorityAlert: vi.fn(),
}));

vi.mock('@/lib/sentry', () => ({
  captureError: vi.fn(),
}));

import { playSignalAlert, playPriorityAlert } from '@/lib/audio';
import { captureError } from '@/lib/sentry';

function makeSignal(overrides?: Partial<Signal>): Signal {
  return {
    id: 'sig-1',
    symbolId: 'BTCUSDT',
    direction: 'buy',
    strength: 'moderate',
    score: 3,
    calibratedProbability: 0.6,
    entryPrice: 100,
    reason: 'test',
    indicators: {} as Signal['indicators'],
    pattern: null,
    time: 1000,
    timeframe: '15m',
    outcome: 'pending',
    frozenAt: null,
    isRevised: false,
    isPreClose: false,
    revisionNote: null,
    barsToResolve: 5,
    spread: null,
    spreadSource: null,
    recommendedExpiry: 900,
    featureVector: [],
    factors: [], rejectedPatterns: [], engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
    chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
    marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
    ...overrides,
  };
}

describe('getActiveFeatures', () => {
  it('combines active patterns and indicators', () => {
    const settings = {
      activePatterns: ['hammer', 'doji'],
      activeIndicators: ['rsi', 'ema'],
    };
    const features = getActiveFeatures(settings);
    expect(features).toHaveLength(4);
    expect(features).toContain('hammer');
    expect(features).toContain('rsi');
  });

  it('returns empty array when both are empty', () => {
    const features = getActiveFeatures({ activePatterns: [], activeIndicators: [] });
    expect(features).toHaveLength(0);
  });

  it('returns only patterns when indicators are empty', () => {
    const features = getActiveFeatures({ activePatterns: ['hammer'], activeIndicators: [] });
    expect(features).toEqual(['hammer']);
  });
});

// Контракт (см. shared.ts): к моменту вызова notifySignal() 'model'-сигнал
// уже ОБЯЗАН был пройти фильтр priorityThreshold внутри buildSignal() —
// сигналов ниже порога с calibrationSource === 'model' в приложении не
// существует физически. Для calibrationSource === 'fallback' это не так
// (см. BUGFIX 2026-09-05, п.2, в signal-builder.ts) — такие сигналы могут
// быть ниже порога легитимно. В обоих случаях notifySignal() не решает
// "показывать баннер или нет", а безусловно показывает баннер и проигрывает
// звук для любого дошедшего до неё сигнала. Ниже — это поведение, плюс
// defense-in-depth тесты на случай, если контракт для 'model' всё же будет
// нарушен будущим рефакторингом.
describe('notifySignal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets prioritySignal and plays priority alert for strong signal above threshold', () => {
    const signal = makeSignal({ strength: 'strong', calibratedProbability: 0.8 });
    const settings = { priorityThreshold: 0.7 };
    const set = vi.fn();

    notifySignal(signal, settings, set);

    expect(set).toHaveBeenCalledWith({ prioritySignal: signal });
    expect(playPriorityAlert).toHaveBeenCalledWith('buy');
    expect(playSignalAlert).not.toHaveBeenCalled();
    expect(captureError).not.toHaveBeenCalled();
  });

  it('notifies for moderate strength above threshold (priority depends only on the threshold, not strength)', () => {
    const signal = makeSignal({ strength: 'moderate', calibratedProbability: 0.9 });
    const settings = { priorityThreshold: 0.7 };
    const set = vi.fn();

    notifySignal(signal, settings, set);

    expect(set).toHaveBeenCalledWith({ prioritySignal: signal });
    expect(playPriorityAlert).toHaveBeenCalledWith('buy');
    expect(playSignalAlert).not.toHaveBeenCalled();
  });

  it('notifies for weak strength above threshold (priority depends only on the threshold, not strength)', () => {
    const signal = makeSignal({ strength: 'weak', calibratedProbability: 0.95 });
    const settings = { priorityThreshold: 0.7 };
    const set = vi.fn();

    notifySignal(signal, settings, set);

    expect(set).toHaveBeenCalledWith({ prioritySignal: signal });
    expect(playPriorityAlert).toHaveBeenCalledWith('buy');
  });

  it('notifies when calibratedProbability exactly equals the threshold (>=, not >)', () => {
    const signal = makeSignal({ calibratedProbability: 0.7 });
    const settings = { priorityThreshold: 0.7 };
    const set = vi.fn();

    notifySignal(signal, settings, set);

    expect(set).toHaveBeenCalledWith({ prioritySignal: signal });
    expect(playPriorityAlert).toHaveBeenCalledWith('buy');
    expect(captureError).not.toHaveBeenCalled();
  });

  it('uses sigmoidFallback(score) as probability when calibratedProbability is null, matching signal-builder', () => {
    const signal = makeSignal({ strength: 'strong', calibratedProbability: null, score: 8 });
    // BUGFIX (аудит 2026-09-05): sigmoidFallback теперь зажат в [0.35, 0.65]
    // (см. signal-builder.ts), поэтому порог здесь снижен с 0.7 до 0.6 —
    // раньше raw sigmoid(8) ≈ 0.832 проходил порог 0.7, теперь clamped
    // sigmoidFallback(8) = 0.65 проходит порог 0.6. Смысл теста (нет
    // invariant violation) не меняется.
    expect(sigmoidFallback(8)).toBeGreaterThanOrEqual(0.6);
    const settings = { priorityThreshold: 0.6 };
    const set = vi.fn();

    notifySignal(signal, settings, set);

    expect(set).toHaveBeenCalledWith({ prioritySignal: signal });
    expect(playPriorityAlert).toHaveBeenCalled();
    expect(captureError).not.toHaveBeenCalled();
  });

  it('passes the correct direction to playPriorityAlert', () => {
    const signal = makeSignal({ direction: 'sell', strength: 'strong', calibratedProbability: 0.9 });
    const settings = { priorityThreshold: 0.7 };
    const set = vi.fn();

    notifySignal(signal, settings, set);

    expect(playPriorityAlert).toHaveBeenCalledWith('sell');
  });

  it('never calls the non-priority alert sound (single-tier notification system)', () => {
    const signal = makeSignal({ calibratedProbability: 0.99 });
    const settings = { priorityThreshold: 0.5 };
    const set = vi.fn();

    notifySignal(signal, settings, set);

    expect(playSignalAlert).not.toHaveBeenCalled();
  });

  describe('invariant violation (defense-in-depth): a signal below priorityThreshold reaching notifySignal', () => {
    // These cases simulate a hypothetical bug where buildSignal()'s own gate
    // was somehow bypassed. Per the "исключить сигнал без баннера и звука"
    // requirement, the banner and sound must still fire — the deviation is
    // only ever surfaced via captureError, never by silently dropping a
    // signal the user would otherwise expect to see.

    it('still shows the banner and plays sound, but reports the anomaly via captureError', () => {
      const signal = makeSignal({ strength: 'strong', calibratedProbability: 0.6 });
      const settings = { priorityThreshold: 0.7 };
      const set = vi.fn();

      notifySignal(signal, settings, set);

      expect(set).toHaveBeenCalledWith({ prioritySignal: signal });
      expect(playPriorityAlert).toHaveBeenCalledWith('buy');
      expect(playSignalAlert).not.toHaveBeenCalled();
      expect(captureError).toHaveBeenCalledTimes(1);
      const [, context] = vi.mocked(captureError).mock.calls[0];
      expect(context).toMatchObject({
        context: 'notifySignal.invariant',
        signalId: signal.id,
        priorityThreshold: 0.7,
      });
    });

    it('reports the anomaly using the sigmoidFallback probability when calibratedProbability is null', () => {
      // score 2 → sigmoidFallback(2) ≈ 0.599, below a 0.7 threshold.
      const signal = makeSignal({ strength: 'weak', calibratedProbability: null, score: 2 });
      const settings = { priorityThreshold: 0.7 };
      const set = vi.fn();

      notifySignal(signal, settings, set);

      expect(sigmoidFallback(2)).toBeLessThan(0.7);
      expect(set).toHaveBeenCalledWith({ prioritySignal: signal });
      expect(playPriorityAlert).toHaveBeenCalled();
      expect(captureError).toHaveBeenCalledTimes(1);
    });
  });

  // BUGFIX (аудит 2026-09-05, п.2): calibrationSource === 'fallback' сигналы
  // ниже порога — ожидаемое, не аномальное поведение (см. signal-builder.ts,
  // priorityThreshold-гейт теперь применяется только к 'model'). Баннер и
  // звук всё равно показываются (контракт "никогда не скрывать реальный
  // сигнал" не меняется), но captureError НЕ должен вызываться — иначе
  // каждый bootstrap-сигнал до накопления 100 исходов ложно спамил бы Sentry.
  describe('fallback-sourced signal below threshold (expected during calibration bootstrap)', () => {
    it('shows the banner and sound but does NOT report an invariant violation', () => {
      const signal = makeSignal({ calibratedProbability: 0.5, calibrationSource: 'fallback' });
      const settings = { priorityThreshold: 0.75 };
      const set = vi.fn();

      notifySignal(signal, settings, set);

      expect(set).toHaveBeenCalledWith({ prioritySignal: signal });
      expect(playPriorityAlert).toHaveBeenCalledWith('buy');
      expect(captureError).not.toHaveBeenCalled();
    });

    it('still reports the invariant for a model-sourced signal below threshold', () => {
      const signal = makeSignal({ calibratedProbability: 0.5, calibrationSource: 'model' });
      const settings = { priorityThreshold: 0.75 };
      const set = vi.fn();

      notifySignal(signal, settings, set);

      expect(captureError).toHaveBeenCalledTimes(1);
    });
  });
});
