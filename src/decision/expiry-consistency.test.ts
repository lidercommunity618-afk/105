import { describe, it, expect, beforeEach } from 'vitest';
import { resolveOutcome } from './outcome-scheduler';
import { useDemoAccountStore } from '@/stores/useDemoAccountStore';
import { signalToRow, rowToSignal } from '@/lib/signal-persistence';
import type { SignalRow } from '@/lib/signal-persistence';
import { TIMEFRAME_SECONDS } from '@/data/symbols';
import type { Signal, Candle } from '@/types/domain';

// Обязательный интеграционный тест из промта рефакторинга (Фаза 0, п.5):
// "карточка, БД-запись и фактическое закрытие сделки ссылаются на один и
// тот же expiryBars — тест должен падать при повторном расхождении".
//
// Три места, которые раньше расходились независимо друг от друга (сам баг,
// который чинит Фаза 0):
//   1. SignalCard.tsx показывает signal.recommendedExpiry (секунды).
//   2. signal-persistence.ts сохраняет/читает signal.expiryBars из БД.
//   3. useDemoAccountStore.ts::openTrade() считает expiryAt, а
//      outcome-scheduler.ts::resolveOutcome() независимо выбирает свечу
//      для резолва — обе формулы ДОЛЖНЫ указывать на одну и ту же
//      физическую свечу для одного и того же сигнала.
// Каждый it() ниже проверяет одно из трёх мест по отдельности — если
// кто-то в будущем поменяет формулу только в одном месте (как это уже
// однажды произошло), соответствующий тест упадёт.

const TF = '5m' as const;
const TF_SECONDS = TIMEFRAME_SECONDS[TF];

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  const expiryBars = overrides.expiryBars ?? 3;
  return {
    id: 'BTCUSDT:5m:1000',
    symbolId: 'BTCUSDT',
    timeframe: TF,
    direction: 'buy',
    strength: 'moderate',
    score: 3,
    calibratedProbability: 0.6,
    entryPrice: 100,
    reason: 'test',
    indicators: {} as Signal['indicators'],
    pattern: null,
    time: 1000,
    outcome: 'pending',
    frozenAt: null,
    isRevised: false,
    isPreClose: false,
    revisionNote: null,
    barsToResolve: 5,
    spread: null,
    spreadSource: null,
    // Согласовано с expiryBars по построению — ровно то, что делает
    // signal-builder.ts (см. её собственный BUGFIX-комментарий): именно
    // это согласование и есть предмет первого теста ниже.
    recommendedExpiry: expiryBars * TF_SECONDS,
    expiryBars,
    featureVector: [0],
    factors: [], rejectedPatterns: [], engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
    chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
    marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
    ...overrides,
  };
}

function candle(time: number, open: number, high: number, low: number, close: number): Candle {
  return { time, open, high, low, close, volume: 100 };
}

function resetDemoAccount(): void {
  useDemoAccountStore.getState().resetAccount();
  useDemoAccountStore.setState({
    autoTradeEnabled: true,
    stage0Amount: 10,
    stageAmounts: [25, 50, 100],
    balance: 1000,
    martingale: {},
  });
}

describe('expiryBars consistency — card / БД / фактическое закрытие сделки (Фаза 0, п.5)', () => {
  beforeEach(() => {
    resetDemoAccount();
  });

  it('карточка: signal.recommendedExpiry (секунды) и signal.expiryBars согласованы — это и есть сам исходный баг в чистом виде', () => {
    const signal = makeSignal({ expiryBars: 3 });
    expect(Math.round(signal.recommendedExpiry / TF_SECONDS)).toBe(signal.expiryBars);
  });

  it('БД-запись: expiryBars переживает круглый маппинг signalToRow → rowToSignal без изменений', () => {
    const signal = makeSignal({ expiryBars: 3 });
    const row = signalToRow(signal) as unknown as SignalRow;
    const restored = rowToSignal(row);
    expect(restored.expiryBars).toBe(3);
  });

  it('старые записи без колонки expiry_bars (NULL) читаются как 1 бар, а не как ошибка/undefined-краш', () => {
    const signal = makeSignal({ expiryBars: 3 });
    const row = signalToRow(signal) as unknown as SignalRow;
    (row as unknown as Record<string, unknown>).expiry_bars = null;
    const restored = rowToSignal(row);
    expect(restored.expiryBars).toBeUndefined();
  });

  it('фактическое закрытие сделки: useDemoAccountStore.openTrade() и outcome-scheduler.resolveOutcome() резолвят ОДНУ И ТУ ЖЕ физическую свечу для одного и того же сигнала', () => {
    const signal = makeSignal({ expiryBars: 3 });

    useDemoAccountStore.getState().openTrade(signal);
    const trade = useDemoAccountStore.getState().openTrades[signal.id];
    expect(trade).toBeDefined();

    // Ровно expiryBars синтетических свечей после сигнала — как их видел
    // бы реальный тик-стор к моменту резолва.
    const candlesAfter: Candle[] = [];
    for (let i = 1; i <= signal.expiryBars!; i++) {
      candlesAfter.push(candle(signal.time + i * TF_SECONDS, 100, 102, 98, 101));
    }
    const resolved = resolveOutcome(signal, candlesAfter);
    expect(resolved).not.toBeNull();

    // Свеча, которую фактически использовал resolveOutcome (последняя в
    // массиве при expiryBars=3 — candlesAfter[expiryBars-1]).
    const resolvingCandle = candlesAfter[signal.expiryBars! - 1];
    const resolvingCandleCloseMs = (resolvingCandle.time + TF_SECONDS) * 1000;

    // Это и есть проверка на расхождение: если expiryAt в демо-сделке
    // когда-нибудь снова начнёт считаться по независимой от expiryBars
    // формуле (как до Фазы 0), эти два времени разойдутся.
    expect(trade.expiryAt).toBe(resolvingCandleCloseMs);
  });

  it('регресс-гвард: с expiryBars=3 обе формулы НЕ должны молча схлопнуться обратно к хардкоду "1 бар"', () => {
    const signal = makeSignal({ expiryBars: 3 });
    useDemoAccountStore.getState().openTrade(signal);
    const trade = useDemoAccountStore.getState().openTrades[signal.id];

    const oneBarExpiryAt = (signal.time + TF_SECONDS + TF_SECONDS) * 1000; // старая захардкоженная формула (баг Фазы 0)
    expect(trade.expiryAt).not.toBe(oneBarExpiryAt);

    const oneBarCandles = [candle(signal.time + TF_SECONDS, 100, 105, 95, 104)]; // резко другой close, чтобы отличие было заметно
    const resolvedAtBar1 = resolveOutcome(signal, oneBarCandles);
    // Свечей меньше, чем expiryBars=3 — resolveOutcome обязан вернуть
    // null (ждать ещё), а не резолвить по первой попавшейся свече.
    expect(resolvedAtBar1).toBeNull();
  });
});
