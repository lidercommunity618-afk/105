import { describe, it, expect } from 'vitest';
import { resample } from './resampler';
import { computeMetrics } from './metrics';
import type { SimulatedTrade } from './simulator';
import type { Candle, Signal } from '@/types/domain';

function makeCandle(time: number, close: number): Candle {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 100 };
}

function makeSignal(time: number, prob: number): Signal {
  return {
    id: `test:${time}`,
    symbolId: 'BTCUSDT',
    direction: 'buy',
    strength: 'moderate',
    score: 3,
    calibratedProbability: prob,
    entryPrice: 100,
    reason: 'test',
    indicators: {
      rsi: 50,
      emaFast: 100,
      emaSlow: 99,
      macd: 0.5,
      macdSignal: 0.3,
      macdHistogram: 0.2,
      atr: 2,
      bollingerUpper: 105,
      bollingerMiddle: 100,
      bollingerLower: 95,
      vwap: 100,
      vwapIsProxyVolume: false,
      volumeProfilePoc: 100,
      volumeProfilePocIsProxyVolume: false,
      meanReversionRsi: null,
      impulseVelocity: null,
      adx: null,
    },
    pattern: null,
    time,
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
    featureVector: [0.5, 0.01, 0.2, 0.1, 2, 100, 0, 1, 0, 1, 0, 0],
    factors: [],
    rejectedPatterns: [],
    engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
    chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
    marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
  };
}

function makeTrade(
  time: number,
  prob: number,
  outcome: 'win' | 'loss' | 'timeout',
): SimulatedTrade {
  return {
    signal: makeSignal(time, prob),
    outcome,
    rawOutcome: outcome,
    entryTime: time,
    candleIndex: 0,
    spreadCostR: 0,
    inSample: true,
  };
}

describe('resampler', () => {
  it('returns 1m candles unchanged', () => {
    const candles = [makeCandle(0, 100), makeCandle(60, 101), makeCandle(120, 102)];
    const result = resample(candles, '1m');
    expect(result).toHaveLength(3);
    expect(result[0].close).toBe(100);
  });

  it('resamples 1m to 5m correctly', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 10; i++) {
      candles.push({
        time: i * 60,
        open: 100 + i,
        high: 101 + i,
        low: 99 + i,
        close: 100 + i,
        volume: 10,
      });
    }
    const result = resample(candles, '5m');
    expect(result).toHaveLength(2);
    expect(result[0].time).toBe(0);
    expect(result[0].open).toBe(100);
    expect(result[0].high).toBe(105);
    expect(result[0].low).toBe(99);
    expect(result[0].close).toBe(104);
    expect(result[0].volume).toBe(50);
  });

  it('handles partial bucket at end', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 7; i++) {
      candles.push({ time: i * 60, open: 100, high: 101, low: 99, close: 100, volume: 10 });
    }
    const result = resample(candles, '5m');
    expect(result).toHaveLength(2);
    expect(result[1].volume).toBe(20);
  });
});

describe('metrics', () => {
  it('handles zero trades', () => {
    const m = computeMetrics([], 80);
    expect(m.totalTrades).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.brierScore).toBe(0);
    expect(m.directionAccuracy).toBe(0);
  });

  // Фаза 3 ("экономика выплаты и accuracy направления"): directionAccuracy
  // — отдельная метрика от winRate, считается по rawOutcome (ДО
  // применения applySpreadToOutcome), не зависит ни от спреда, ни от
  // profitPercent. Здесь rawOutcome и outcome специально расходятся: сделка
  // #3 была направленно верной (rawOutcome='win'), но её сдвинуло в
  // 'timeout' спред-поправкой (сценарий "движение <= спред", см.
  // decision/apply-spread.ts) — то, что реально видит пользователь.
  it('computes directionAccuracy independently of the spread-adjusted outcome/winRate', () => {
    const trades: SimulatedTrade[] = [
      { ...makeTrade(0, 0.6, 'win'), rawOutcome: 'win' },
      { ...makeTrade(60, 0.6, 'loss'), rawOutcome: 'loss' },
      { ...makeTrade(120, 0.6, 'timeout'), rawOutcome: 'win' },
    ];
    const m = computeMetrics(trades, 80);

    // winRate: decided = win(1) + loss(1) = 2, wins = 1 → 50%.
    expect(m.winRate).toBeCloseTo(0.5, 5);
    // directionAccuracy: rawDecided = win(2) + loss(1) = 3, rawWins = 2 → 66.7%.
    expect(m.directionAccuracy).toBeCloseTo(2 / 3, 5);
    expect(m.directionAccuracy).not.toBeCloseTo(m.winRate, 5);
  });

  it('computes win rate correctly (excludes timeouts from the denominator)', () => {
    const trades = [
      makeTrade(0, 0.6, 'win'),
      makeTrade(60, 0.6, 'loss'),
      makeTrade(120, 0.6, 'win'),
      makeTrade(180, 0.6, 'timeout'),
    ];
    const m = computeMetrics(trades, 80);
    expect(m.totalTrades).toBe(4);
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(1);
    expect(m.timeouts).toBe(1);
    // BUGFIX (аудит 2026-09-13): раньше было wins/total = 2/4 = 0.5 —
    // единственное место в проекте, включавшее timeout в знаменатель
    // винрейта. Теперь как везде (useAnalyticsStore, forward-test
    // вердикт): wins/(wins+losses) = 2/3, timeout — не выигрыш и не
    // проигрыш, ставка просто возвращается.
    expect(m.winRate).toBeCloseTo(2 / 3, 5);
  });

  it('computes average return using the configured payout, not a fixed 2:1 R-multiple', () => {
    // BUGFIX (аудит 2026-09-13, "R-модель бэктеста не совпадала с реальной
    // экономикой демо-счёта"): раньше WIN_R=2/LOSS_R=-1 были захардкожены
    // независимо от payout. Теперь win = +profitPercent/100, loss = -1 —
    // те же единицы, что и pnl на реальном демо-счёте.
    const trades = [makeTrade(0, 0.6, 'win'), makeTrade(60, 0.6, 'loss')];
    const m = computeMetrics(trades, 80);
    // (0.8 + (-1)) / 2 = -0.1
    expect(m.averageR).toBeCloseTo(-0.1, 5);
  });

  it('a higher payout increases average return for the same win/loss sequence', () => {
    const trades = [makeTrade(0, 0.6, 'win'), makeTrade(60, 0.6, 'loss')];
    const at80 = computeMetrics(trades, 80);
    const at100 = computeMetrics(trades, 100);
    expect(at100.averageR).toBeGreaterThan(at80.averageR);
    expect(at100.averageR).toBeCloseTo(0, 5); // (1 + (-1)) / 2 = 0
  });

  it('computes Brier score', () => {
    const trades = [
      makeTrade(0, 0.8, 'win'),
      makeTrade(60, 0.3, 'loss'),
    ];
    const m = computeMetrics(trades, 80);
    expect(m.brierScore).toBeCloseTo(0.065, 5);
  });

  it('computes max drawdown', () => {
    const trades = [
      makeTrade(0, 0.6, 'win'),
      makeTrade(60, 0.6, 'loss'),
      makeTrade(120, 0.6, 'loss'),
      makeTrade(180, 0.6, 'win'),
    ];
    const m = computeMetrics(trades, 80);
    // Два подряд убытка (-1 каждый) от пика 0.8 дают просадку 2.0 — не
    // зависит от payout в этом конкретном сценарии, так как максимум
    // просадки достигается ДО следующего выигрыша.
    expect(m.maxDrawdownR).toBe(2);
  });

  it('computes profit factor from payout-based returns', () => {
    const trades = [
      makeTrade(0, 0.6, 'win'),
      makeTrade(60, 0.6, 'win'),
      makeTrade(120, 0.6, 'loss'),
    ];
    const m = computeMetrics(trades, 80);
    // grossProfit = 0.8 + 0.8 = 1.6, grossLoss = 1 -> 1.6
    expect(m.profitFactor).toBeCloseTo(1.6, 5);
  });

  it('builds reliability bins', () => {
    const trades = [
      makeTrade(0, 0.05, 'loss'),
      makeTrade(60, 0.15, 'loss'),
      makeTrade(120, 0.85, 'win'),
      makeTrade(180, 0.95, 'win'),
    ];
    const m = computeMetrics(trades, 80);
    expect(m.reliabilityBins).toHaveLength(10);
    expect(m.reliabilityBins[0].count).toBe(1);
    expect(m.reliabilityBins[0].avgActual).toBe(0);
    expect(m.reliabilityBins[9].count).toBe(1);
    expect(m.reliabilityBins[9].avgActual).toBe(1);
  });

  // АУДИТ 2026-09-13 ("не допустить 3 убыточные сделки подряд"): до этой
  // правки в бэктесте не было вообще никакой метрики серийности —
  // winRate/profitFactor усредняют по выборке и не видят порядок сделок.
  describe('maxConsecutiveLosses', () => {
    it('is 0 when there are no trades', () => {
      expect(computeMetrics([], 80).maxConsecutiveLosses).toBe(0);
    });

    it('is 0 when there are no losses at all', () => {
      const trades = [makeTrade(0, 0.6, 'win'), makeTrade(60, 0.6, 'win')];
      expect(computeMetrics(trades, 80).maxConsecutiveLosses).toBe(0);
    });

    it('counts a run of consecutive losses, reusing the same "computes max drawdown" fixture above', () => {
      const trades = [
        makeTrade(0, 0.6, 'win'),
        makeTrade(60, 0.6, 'loss'),
        makeTrade(120, 0.6, 'loss'),
        makeTrade(180, 0.6, 'win'),
      ];
      expect(computeMetrics(trades, 80).maxConsecutiveLosses).toBe(2);
    });

    it('finds the longest streak, not just the most recent one', () => {
      const trades = [
        makeTrade(0, 0.6, 'loss'),
        makeTrade(60, 0.6, 'loss'),
        makeTrade(120, 0.6, 'loss'),
        makeTrade(180, 0.6, 'win'),
        makeTrade(240, 0.6, 'loss'),
        makeTrade(300, 0.6, 'win'),
      ];
      expect(computeMetrics(trades, 80).maxConsecutiveLosses).toBe(3);
    });

    it('a timeout in the middle of a losing run neither extends nor breaks the streak', () => {
      const trades = [
        makeTrade(0, 0.6, 'loss'),
        makeTrade(60, 0.6, 'timeout'),
        makeTrade(120, 0.6, 'loss'),
      ];
      // The timeout is skipped entirely (same convention as winRate's
      // decided-only denominator above) — the two real losses on either
      // side of it still count as one continuous streak of 2, not two
      // separate streaks of 1.
      expect(computeMetrics(trades, 80).maxConsecutiveLosses).toBe(2);
    });

    it('a win resets the streak even when it is immediately followed by more losses', () => {
      const trades = [
        makeTrade(0, 0.6, 'loss'),
        makeTrade(60, 0.6, 'loss'),
        makeTrade(120, 0.6, 'win'),
        makeTrade(180, 0.6, 'loss'),
      ];
      expect(computeMetrics(trades, 80).maxConsecutiveLosses).toBe(2);
    });
  });
});
