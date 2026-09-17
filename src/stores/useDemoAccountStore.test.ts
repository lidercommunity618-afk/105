import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useDemoAccountStore, getStageStake, migrateDemoAccountState } from '@/stores/useDemoAccountStore';
import { useAnalyticsStore } from '@/stores/useAnalyticsStore';
import { TIMEFRAME_SECONDS } from '@/data/symbols';
import type { Candle, Signal, Timeframe } from '@/types/domain';

function candle(
  time: number,
  open: number,
  close: number,
  high: number,
  low: number,
  volume = 100,
): Candle {
  return { time, open, high, low, close, volume };
}

function makeSignal(
  id: string,
  symbolId: string,
  timeframe: Timeframe,
  time: number,
  direction: 'buy' | 'sell' = 'buy',
): Signal {
  return {
    id,
    symbolId,
    timeframe,
    direction,
    strength: 'moderate',
    score: 3,
    calibratedProbability: null,
    entryPrice: 100,
    reason: 'test',
    indicators: {} as Signal['indicators'],
    pattern: null,
    time,
    outcome: 'pending',
    frozenAt: null,
    isRevised: false,
    isPreClose: false,
    revisionNote: null,
    barsToResolve: 5,
    spread: null,
    spreadSource: null,
    recommendedExpiry: 300,
    featureVector: [0],
    factors: [], rejectedPatterns: [], engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
    chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
    marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
  };
}

function makeTrade(
  id: string,
  symbolId: string,
  timeframe: Timeframe,
  candleTime: number,
  stake: number,
  stage: 0 | 1 | 2 | 3,
  direction: 'buy' | 'sell' = 'buy',
  entryPrice: number = 100,
  spread: number | null = null,
) {
  const tfSeconds = TIMEFRAME_SECONDS[timeframe];
  return {
    signalId: id,
    stake,
    profitPercent: 80,
    direction,
    openedAt: candleTime * 1000,
    entryPrice,
    fallbackEntryPrice: 100,
    spread,
    expiryAt: (candleTime + tfSeconds) * 1000,
    symbolId,
    timeframe,
    candleTime,
    stage,
    stakeConfigAtOpen: { stage0Amount: 10, stageAmounts: [25, 50, 100] as [number, number, number] },
  };
}

const TF: Timeframe = '5m';
const TF_SECONDS = 300;

describe('useDemoAccountStore — getStageStake', () => {
  it('stage 0 returns stage0Amount literally', () => {
    expect(getStageStake(0, 10, [25, 50, 100])).toBe(10);
  });

  it('stages 1-3 return the configured absolute stage amount', () => {
    expect(getStageStake(1, 10, [25, 50, 100])).toBe(25);
    expect(getStageStake(2, 10, [25, 50, 100])).toBe(50);
    expect(getStageStake(3, 10, [25, 50, 100])).toBe(100);
  });

  it('stage 0 stake does not depend on balance', () => {
    expect(getStageStake(0, 10, [25, 50, 100])).toBe(10);
    expect(getStageStake(0, 10, [25, 50, 100])).toBe(10);
  });
});

describe('useDemoAccountStore — martingale stages', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    useDemoAccountStore.setState({
      autoTradeEnabled: true,
      stage0Amount: 10,
      stageAmounts: [25, 50, 100],
      balance: 1000,
      martingale: {},
    });
  });

  it('loss on stage 0 advances to stage 1 with correct stake', () => {
    const candleTime = 100000;
    useDemoAccountStore.setState({
      balance: 990,
      openTrades: { 'sig-1': makeTrade('sig-1', 'EURUSD', TF, candleTime, 10, 0) },
    });

    useDemoAccountStore.getState().checkExpiries(95, (candleTime + TF_SECONDS) * 1000, 'EURUSD', TF);

    const state = useDemoAccountStore.getState();
    expect(state.martingale['EURUSD:5m'].stage).toBe(1);
    expect(state.history[0].seriesReset).toBeNull();
  });

  it('win on any stage resets to stage 0', () => {
    const candleTime = 100000;
    useDemoAccountStore.setState({
      balance: 990,
      martingale: { 'EURUSD:5m': { stage: 2, halted: false } },
      openTrades: { 'sig-win': makeTrade('sig-win', 'EURUSD', TF, candleTime, 50, 2) },
    });

    useDemoAccountStore.getState().checkExpiries(105, (candleTime + TF_SECONDS) * 1000, 'EURUSD', TF);

    const state = useDemoAccountStore.getState();
    expect(state.martingale['EURUSD:5m'].stage).toBe(0);
    expect(state.history[0].seriesReset).toBe('win');
  });

  it('loss on stage 3 resets to stage 0 without attempting 5th trade', () => {
    const candleTime = 100000;
    useDemoAccountStore.setState({
      balance: 990,
      martingale: { 'EURUSD:5m': { stage: 3, halted: false } },
      openTrades: { 'sig-loss3': makeTrade('sig-loss3', 'EURUSD', TF, candleTime, 100, 3) },
    });

    useDemoAccountStore.getState().checkExpiries(95, (candleTime + TF_SECONDS) * 1000, 'EURUSD', TF);

    const state = useDemoAccountStore.getState();
    expect(state.martingale['EURUSD:5m'].stage).toBe(0);
    expect(state.history[0].seriesReset).toBe('loss_final_stage');
  });

  it('tie does not change martingale stage', () => {
    const candleTime = 100000;
    useDemoAccountStore.setState({
      balance: 990,
      martingale: { 'EURUSD:5m': { stage: 1, halted: false } },
      openTrades: { 'sig-tie': makeTrade('sig-tie', 'EURUSD', TF, candleTime, 25, 1) },
    });

    useDemoAccountStore.getState().checkExpiries(100, (candleTime + TF_SECONDS) * 1000, 'EURUSD', TF);

    const state = useDemoAccountStore.getState();
    expect(state.martingale['EURUSD:5m'].stage).toBe(1);
    expect(state.history[0].seriesReset).toBeNull();
  });
});

// BUGFIX (аудит 2026-09-13, "спред учтён в калибровке, но не в балансе"):
// decision/apply-spread.ts уже давно переразмечает пограничный 'win' (движение
// цены не превышает спред) в 'timeout' для калибровочной модели — но баланс
// демо-счёта раньше игнорировал спред полностью и засчитывал такой же
// пограничный win как полноценную победу с payout. Тесты ниже фиксируют
// исправленное поведение: resolveTrade() теперь применяет ту же спред-логику
// к самому балансу, а не только к обучающей метке калибровки.
describe('useDemoAccountStore — spread-aware settlement (balance/calibration parity fix)', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    useDemoAccountStore.setState({
      autoTradeEnabled: true,
      stage0Amount: 10,
      stageAmounts: [25, 50, 100],
      balance: 1000,
      martingale: {},
    });
  });

  it('a win whose move does not exceed the trade spread is settled as a push (tie), not a win', () => {
    const candleTime = 100000;
    // Вход 100, спред 2 — движение до 101 (buy) полностью в пределах спреда.
    useDemoAccountStore.setState({
      balance: 990,
      martingale: { 'EURUSD:5m': { stage: 1, halted: false } },
      openTrades: {
        'sig-spread-win': makeTrade('sig-spread-win', 'EURUSD', TF, candleTime, 25, 1, 'buy', 100, 2),
      },
    });

    useDemoAccountStore.getState().checkExpiries(101, (candleTime + TF_SECONDS) * 1000, 'EURUSD', TF);

    const state = useDemoAccountStore.getState();
    expect(state.history[0].outcome).toBe('tie');
    expect(state.history[0].pnl).toBe(0);
    // Ставка возвращена, payout не начислен.
    expect(state.balance).toBe(1015); // 990 + 25 (только ставка назад)
    // Серия мартингейла не двигается — как обычный тай.
    expect(state.martingale['EURUSD:5m'].stage).toBe(1);
    expect(state.history[0].seriesReset).toBeNull();
  });

  it('a win whose move clearly exceeds the trade spread still pays out normally', () => {
    const candleTime = 100000;
    // Вход 100, спред 2 — движение до 110 (buy) намного больше спреда.
    useDemoAccountStore.setState({
      balance: 990,
      martingale: { 'EURUSD:5m': { stage: 1, halted: false } },
      openTrades: {
        'sig-real-win': makeTrade('sig-real-win', 'EURUSD', TF, candleTime, 25, 1, 'buy', 100, 2),
      },
    });

    useDemoAccountStore.getState().checkExpiries(110, (candleTime + TF_SECONDS) * 1000, 'EURUSD', TF);

    const state = useDemoAccountStore.getState();
    expect(state.history[0].outcome).toBe('win');
    expect(state.history[0].pnl).toBe(20); // 25 * 0.8
    expect(state.balance).toBe(1035); // 990 + 25 stake back + 20 profit
    expect(state.martingale['EURUSD:5m'].stage).toBe(0);
    expect(state.history[0].seriesReset).toBe('win');
  });

  it('a loss is unaffected by spread — spread only demotes marginal wins, never softens losses', () => {
    const candleTime = 100000;
    // Вход 100, спред 2 — движение до 99 (buy = убыток) внутри "спреда", но
    // это направление против сделки: остаётся полноценным убытком.
    useDemoAccountStore.setState({
      balance: 990,
      martingale: { 'EURUSD:5m': { stage: 0, halted: false } },
      openTrades: {
        'sig-loss-within-spread': makeTrade('sig-loss-within-spread', 'EURUSD', TF, candleTime, 10, 0, 'buy', 100, 2),
      },
    });

    useDemoAccountStore.getState().checkExpiries(99, (candleTime + TF_SECONDS) * 1000, 'EURUSD', TF);

    const state = useDemoAccountStore.getState();
    expect(state.history[0].outcome).toBe('loss');
    expect(state.history[0].pnl).toBe(-10);
    expect(state.martingale['EURUSD:5m'].stage).toBe(1);
  });

  it('trades with no known spread (spread=null) keep the old behavior — any move is a full win', () => {
    const candleTime = 100000;
    useDemoAccountStore.setState({
      balance: 990,
      martingale: { 'EURUSD:5m': { stage: 0, halted: false } },
      openTrades: {
        'sig-no-spread': makeTrade('sig-no-spread', 'EURUSD', TF, candleTime, 10, 0, 'buy', 100, null),
      },
    });

    // Движение всего +0.5 — при известном спреде 2 это был бы 'tie', но
    // спред здесь не оценён (null), поэтому это полноценный win.
    useDemoAccountStore.getState().checkExpiries(100.5, (candleTime + TF_SECONDS) * 1000, 'EURUSD', TF);

    const state = useDemoAccountStore.getState();
    expect(state.history[0].outcome).toBe('win');
  });
});

describe('useDemoAccountStore — martingaleEnabled toggle (disabled)', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    useDemoAccountStore.setState({
      autoTradeEnabled: true,
      martingaleEnabled: false,
      stage0Amount: 10,
      stageAmounts: [25, 50, 100],
      balance: 1000,
      martingale: {},
    });
  });

  afterEach(() => {
    // resetAccount() intentionally preserves martingaleEnabled (same as
    // autoTradeEnabled) — restore the default explicitly so later
    // describe blocks in this file aren't affected by this suite's
    // martingaleEnabled: false setting.
    useDemoAccountStore.setState({ martingaleEnabled: true });
  });

  it('loss on stage 0 stays on stage 0 (stake unchanged) when martingale disabled', () => {
    const candleTime = 100000;
    useDemoAccountStore.setState({
      balance: 990,
      openTrades: { 'sig-1': makeTrade('sig-1', 'EURUSD', TF, candleTime, 10, 0) },
    });

    useDemoAccountStore.getState().checkExpiries(95, (candleTime + TF_SECONDS) * 1000, 'EURUSD', TF);

    const state = useDemoAccountStore.getState();
    expect(state.martingale['EURUSD:5m'].stage).toBe(0);
    expect(state.martingale['EURUSD:5m'].halted).toBe(false);
    expect(state.history[0].pnl).toBe(-10);
    expect(state.history[0].seriesReset).toBeNull();
    expect(getStageStake(state.martingale['EURUSD:5m'].stage, state.stage0Amount, state.stageAmounts)).toBe(10);
  });

  it('repeated losses never advance past stage 0 when martingale disabled', () => {
    const candleTime = 100000;
    useDemoAccountStore.setState({
      balance: 990,
      openTrades: { 'sig-1': makeTrade('sig-1', 'EURUSD', TF, candleTime, 10, 0) },
    });
    useDemoAccountStore.getState().checkExpiries(95, (candleTime + TF_SECONDS) * 1000, 'EURUSD', TF);
    expect(useDemoAccountStore.getState().martingale['EURUSD:5m'].stage).toBe(0);

    const candleTime2 = candleTime + TF_SECONDS;
    useDemoAccountStore.setState({
      openTrades: { 'sig-2': makeTrade('sig-2', 'EURUSD', TF, candleTime2, 10, 0) },
    });
    useDemoAccountStore.getState().checkExpiries(95, (candleTime2 + TF_SECONDS) * 1000, 'EURUSD', TF);

    const state = useDemoAccountStore.getState();
    expect(state.martingale['EURUSD:5m'].stage).toBe(0);
    expect(state.history[0].pnl).toBe(-10);
    expect(state.history[1].pnl).toBe(-10);
  });

  it('win still resets stage to 0 when martingale disabled', () => {
    const candleTime = 100000;
    useDemoAccountStore.setState({
      balance: 990,
      openTrades: { 'sig-win': makeTrade('sig-win', 'EURUSD', TF, candleTime, 10, 0) },
    });

    useDemoAccountStore.getState().checkExpiries(105, (candleTime + TF_SECONDS) * 1000, 'EURUSD', TF);

    const state = useDemoAccountStore.getState();
    expect(state.martingale['EURUSD:5m'].stage).toBe(0);
    expect(state.history[0].seriesReset).toBe('win');
  });
});

// Аудит (синхронизация с демо-счётом): checkExpiries()/resolveFromHistory()
// теперь синхронно прокидывают исход закрытой демо-сделки в
// useAnalyticsStore — это и есть фикс основного бага (рассинхронизация
// "Последние сделки" vs "ИСТОРИЯ СИГНАЛОВ"/винрейт).
describe('useDemoAccountStore — analytics sync (outcome sync fix)', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    useDemoAccountStore.setState({
      autoTradeEnabled: true,
      stage0Amount: 10,
      stageAmounts: [25, 50, 100],
      balance: 1000,
      martingale: {},
    });
    useAnalyticsStore.getState().clearAll();
  });

  it('checkExpiries win synchronously sets analytics outcome to "win" and recomputes stats', () => {
    const candleTime = 100000;
    useAnalyticsStore.getState().addSignal(makeSignal('sig-win', 'EURUSD', TF, candleTime));
    useDemoAccountStore.setState({
      openTrades: { 'sig-win': makeTrade('sig-win', 'EURUSD', TF, candleTime, 10, 0) },
    });

    useDemoAccountStore.getState().checkExpiries(105, (candleTime + TF_SECONDS) * 1000, 'EURUSD', TF);

    // Никакого ожидания/таймера — исход должен быть виден сразу после
    // синхронного вызова checkExpiries().
    const signal = useAnalyticsStore.getState().signals.find((s) => s.id === 'sig-win');
    expect(signal?.outcome).toBe('win');
    expect(useAnalyticsStore.getState().winRate).toBe(1);
  });

  it('checkExpiries loss synchronously sets analytics outcome to "loss"', () => {
    const candleTime = 100000;
    useAnalyticsStore.getState().addSignal(makeSignal('sig-loss', 'EURUSD', TF, candleTime));
    useDemoAccountStore.setState({
      openTrades: { 'sig-loss': makeTrade('sig-loss', 'EURUSD', TF, candleTime, 10, 0) },
    });

    useDemoAccountStore.getState().checkExpiries(95, (candleTime + TF_SECONDS) * 1000, 'EURUSD', TF);

    const signal = useAnalyticsStore.getState().signals.find((s) => s.id === 'sig-loss');
    expect(signal?.outcome).toBe('loss');
  });

  it('checkExpiries tie synchronously sets analytics outcome to "timeout" (per product spec)', () => {
    const candleTime = 100000;
    useAnalyticsStore.getState().addSignal(makeSignal('sig-tie', 'EURUSD', TF, candleTime));
    useDemoAccountStore.setState({
      openTrades: { 'sig-tie': makeTrade('sig-tie', 'EURUSD', TF, candleTime, 10, 0) },
    });

    useDemoAccountStore.getState().checkExpiries(100, (candleTime + TF_SECONDS) * 1000, 'EURUSD', TF);

    const signal = useAnalyticsStore.getState().signals.find((s) => s.id === 'sig-tie');
    expect(signal?.outcome).toBe('timeout');
  });

  it('the analytics outcome always matches the demo history entry outcome for the same signalId', () => {
    const candleTime = 100000;
    useAnalyticsStore.getState().addSignal(makeSignal('sig-match', 'EURUSD', TF, candleTime));
    useDemoAccountStore.setState({
      openTrades: { 'sig-match': makeTrade('sig-match', 'EURUSD', TF, candleTime, 10, 0) },
    });

    useDemoAccountStore.getState().checkExpiries(110, (candleTime + TF_SECONDS) * 1000, 'EURUSD', TF);

    const historyEntry = useDemoAccountStore.getState().history[0];
    const signal = useAnalyticsStore.getState().signals.find((s) => s.id === 'sig-match');
    const expectedSignalOutcome = historyEntry.outcome === 'tie' ? 'timeout' : historyEntry.outcome;
    expect(signal?.outcome).toBe(expectedSignalOutcome);
  });

  it('resolveFromHistory (orphan resolution) also synchronously syncs the analytics outcome', () => {
    const candleTime = 100000;
    useAnalyticsStore.getState().addSignal(makeSignal('sig-orphan', 'EURUSD', TF, candleTime));
    useDemoAccountStore.setState({
      openTrades: { 'sig-orphan': makeTrade('sig-orphan', 'EURUSD', TF, candleTime, 10, 0) },
    });

    const candles = [
      candle(candleTime, 100, 108, 109, 99),
      candle(candleTime + TF_SECONDS, 108, 108, 110, 107),
    ];
    useDemoAccountStore.getState().resolveFromHistory('EURUSD', TF, candles);

    const signal = useAnalyticsStore.getState().signals.find((s) => s.id === 'sig-orphan');
    expect(signal?.outcome).toBe('win');
  });
});

describe('useDemoAccountStore — per-instrument independence', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    useDemoAccountStore.setState({
      autoTradeEnabled: true,
      stage0Amount: 10,
      stageAmounts: [25, 50, 100],
      balance: 1000,
      martingale: {},
    });
  });

  it('alternating trades on EURUSD:1m and BTCUSD:5m do not affect each other', () => {
    const candleTime = 100000;
    useDemoAccountStore.setState({
      balance: 980,
      martingale: {
        'EURUSD:1m': { stage: 1, halted: false },
        'BTCUSD:5m': { stage: 0, halted: false },
      },
      openTrades: {
        'sig-eur': makeTrade('sig-eur', 'EURUSD', '1m', candleTime, 25, 1),
        'sig-btc': makeTrade('sig-btc', 'BTCUSD', '5m', candleTime, 10, 0),
      },
    });

    useDemoAccountStore.getState().checkExpiries(95, (candleTime + 60) * 1000, 'EURUSD', '1m');
    useDemoAccountStore.getState().checkExpiries(95, (candleTime + TF_SECONDS) * 1000, 'BTCUSD', '5m');

    const state = useDemoAccountStore.getState();
    expect(state.martingale['EURUSD:1m'].stage).toBe(2);
    expect(state.martingale['BTCUSD:5m'].stage).toBe(1);
  });
});

describe('useDemoAccountStore — insufficient funds and halt', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    useDemoAccountStore.setState({
      autoTradeEnabled: true,
      stage0Amount: 10,
      stageAmounts: [25, 50, 100],
      balance: 1000,
      martingale: {},
    });
  });

  it('insufficient funds: trade not created, balance unchanged, instrument halted', () => {
    const T = 1_000_000;
    useDemoAccountStore.setState({ balance: 5 });

    const signal = makeSignal('sig-low', 'EURUSD', TF, T);
    useDemoAccountStore.getState().openTrade(signal);

    const state = useDemoAccountStore.getState();
    expect(state.openTrades['sig-low']).toBeUndefined();
    expect(state.balance).toBe(5);
    expect(state.martingale['EURUSD:5m']).toEqual({ stage: 0, halted: true });
  });

  it('halted instrument: subsequent signals are ignored (idempotent)', () => {
    const T = 2_000_000;
    useDemoAccountStore.setState({
      balance: 5,
      martingale: { 'EURUSD:5m': { stage: 0, halted: true } },
    });

    const signal = makeSignal('sig-halted', 'EURUSD', TF, T);
    useDemoAccountStore.getState().openTrade(signal);

    const state = useDemoAccountStore.getState();
    expect(state.openTrades['sig-halted']).toBeUndefined();
    expect(state.balance).toBe(5);
    expect(state.martingale['EURUSD:5m']).toEqual({ stage: 0, halted: true });
  });

  it('halting one instrument does not affect others', () => {
    const T = 3_000_000;
    useDemoAccountStore.setState({
      balance: 30,
      martingale: { 'BTCUSD:5m': { stage: 3, halted: false } },
    });

    useDemoAccountStore.getState().openTrade(makeSignal('sig-eur', 'EURUSD', TF, T));
    useDemoAccountStore.getState().openTrade(makeSignal('sig-btc', 'BTCUSD', TF, T));

    const state = useDemoAccountStore.getState();
    expect(state.martingale['BTCUSD:5m'].halted).toBe(true);
    expect(state.martingale['EURUSD:5m']?.halted).not.toBe(true);
    expect(state.openTrades['sig-eur']).toBeDefined();
  });
});

describe('useDemoAccountStore — setBalance unhalts', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    useDemoAccountStore.setState({
      autoTradeEnabled: true,
      stage0Amount: 10,
      stageAmounts: [25, 50, 100],
      balance: 1000,
      martingale: {},
    });
  });

  it('setBalance(v > 0) unhalts all instruments, stage stays 0', () => {
    useDemoAccountStore.setState({
      martingale: {
        'EURUSD:5m': { stage: 0, halted: true },
        'BTCUSD:1m': { stage: 0, halted: true },
      },
    });

    useDemoAccountStore.getState().setBalance(5000);

    const state = useDemoAccountStore.getState();
    expect(state.balance).toBe(5000);
    expect(state.martingale['EURUSD:5m'].halted).toBe(false);
    expect(state.martingale['BTCUSD:1m'].halted).toBe(false);
    expect(state.martingale['EURUSD:5m'].stage).toBe(0);
  });

  it('setBalance(v <= 0) does not unhalt any instrument', () => {
    useDemoAccountStore.setState({
      martingale: {
        'EURUSD:5m': { stage: 0, halted: true },
      },
    });

    useDemoAccountStore.getState().setBalance(0);

    const state = useDemoAccountStore.getState();
    expect(state.martingale['EURUSD:5m'].halted).toBe(true);
  });

  it('after unhalt, if balance still insufficient, instrument re-halts on next openTrade', () => {
    const T = 4_000_000;
    useDemoAccountStore.setState({
      balance: 3,
      martingale: { 'EURUSD:5m': { stage: 0, halted: true } },
    });

    useDemoAccountStore.getState().setBalance(3);

    const state = useDemoAccountStore.getState();
    expect(state.martingale['EURUSD:5m'].halted).toBe(false);

    useDemoAccountStore.getState().openTrade(makeSignal('sig-rehalt', 'EURUSD', TF, T));

    const state2 = useDemoAccountStore.getState();
    expect(state2.martingale['EURUSD:5m'].halted).toBe(true);
    expect(state2.openTrades['sig-rehalt']).toBeUndefined();
  });
});

describe('useDemoAccountStore — setters and reset', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    useDemoAccountStore.setState({
      autoTradeEnabled: true,
      stage0Amount: 10,
      stageAmounts: [25, 50, 100],
      balance: 1000,
      martingale: {},
    });
  });

  it('setStage0Amount updates stage0Amount, does not touch martingale', () => {
    useDemoAccountStore.setState({
      martingale: { 'EURUSD:5m': { stage: 2, halted: false } },
    });

    useDemoAccountStore.getState().setStage0Amount(20);

    const state = useDemoAccountStore.getState();
    expect(state.stage0Amount).toBe(20);
    expect(state.martingale['EURUSD:5m']).toEqual({ stage: 2, halted: false });
  });

  it('setStageAmount updates specific stage amount, does not touch martingale', () => {
    useDemoAccountStore.setState({
      martingale: { 'EURUSD:5m': { stage: 1, halted: false } },
    });

    useDemoAccountStore.getState().setStageAmount(2, 75);

    const state = useDemoAccountStore.getState();
    expect(state.stageAmounts).toEqual([25, 75, 100]);
    expect(state.martingale['EURUSD:5m']).toEqual({ stage: 1, halted: false });
  });

  it('changing stage0Amount applies to next trade but not already-open trades', () => {
    const T = 5_000_000;
    useDemoAccountStore.getState().openTrade(makeSignal('sig-1', 'EURUSD', TF, T));

    const trade1 = useDemoAccountStore.getState().openTrades['sig-1'];
    expect(trade1?.stake).toBe(10);

    useDemoAccountStore.getState().setStage0Amount(20);
    useDemoAccountStore.getState().openTrade(makeSignal('sig-2', 'BTCUSD', TF, T + 1));

    const trade2 = useDemoAccountStore.getState().openTrades['sig-2'];
    expect(trade2?.stake).toBe(20);
    expect(trade1?.stake).toBe(10);
  });

  it('resetAccount clears martingale but preserves stage0Amount/stageAmounts', () => {
    useDemoAccountStore.setState({
      balance: 500,
      martingale: {
        'EURUSD:5m': { stage: 3, halted: true },
        'BTCUSD:1m': { stage: 1, halted: false },
      },
      stage0Amount: 15,
      stageAmounts: [30, 60, 120],
      history: [{ signalId: 'x', outcome: 'win', pnl: 5, balanceAfter: 505, closedAt: 1, symbolId: 'A', timeframe: '5m', stage: 0, seriesReset: 'win' }],
    });

    useDemoAccountStore.getState().resetAccount();

    const state = useDemoAccountStore.getState();
    expect(state.balance).toBe(1000);
    expect(state.martingale).toEqual({});
    expect(state.stage0Amount).toBe(15);
    expect(state.stageAmounts).toEqual([30, 60, 120]);
    expect(state.history).toEqual([]);
  });

  it('resetAccount also clears analytics signal history and winRate (bug: balance>1000 with more losses than wins after reset)', () => {
    // Reproduce the screenshot-6 bug: before a reset, the user accumulated
    // more losses than wins in the analytics signal history. resetAccount()
    // used to clear only the demo balance/trade history, leaving the
    // StatusBar win/loss counters and signal history untouched — so after
    // reset the balance was back at $1000 (fresh wins pushed it above),
    // while the stats still showed the old pre-reset losses dominating.
    useAnalyticsStore.getState().clearAll();
    useAnalyticsStore.getState().addSignal(makeSignal('sig-old-win', 'EURUSD', TF, 100000));
    useAnalyticsStore.getState().addSignal(makeSignal('sig-old-loss-1', 'EURUSD', TF, 100100));
    useAnalyticsStore.getState().addSignal(makeSignal('sig-old-loss-2', 'EURUSD', TF, 100200));
    useAnalyticsStore.getState().updateSignalOutcome('sig-old-win', 'win');
    useAnalyticsStore.getState().updateSignalOutcome('sig-old-loss-1', 'loss');
    useAnalyticsStore.getState().updateSignalOutcome('sig-old-loss-2', 'loss');
    useAnalyticsStore.getState().recomputeStats();

    expect(useAnalyticsStore.getState().signals.length).toBe(3);
    expect(useAnalyticsStore.getState().winRate).toBe(1 / 3);

    useDemoAccountStore.getState().resetAccount();

    expect(useAnalyticsStore.getState().signals).toEqual([]);
    expect(useAnalyticsStore.getState().winRate).toBeNull();
    expect(useAnalyticsStore.getState().calibrationSampleCount).toBe(0);
  });
});

describe('useDemoAccountStore — orphaned trade resolution', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    useDemoAccountStore.setState({
      autoTradeEnabled: true,
      stage0Amount: 10,
      stageAmounts: [25, 50, 100],
      balance: 1000,
      martingale: {},
    });
  });

  it('checkExpiries with symbolId B does not resolve trade opened on symbolId A', () => {
    const now = Date.now();

    useDemoAccountStore.setState({
      balance: 990,
      openTrades: { 'sig-A': makeTrade('sig-A', 'A', TF, 1000, 10, 0) },
    });

    useDemoAccountStore.getState().checkExpiries(105, now + 1000, 'B', TF);
    expect(useDemoAccountStore.getState().openTrades['sig-A']).toBeDefined();
    expect(useDemoAccountStore.getState().balance).toBe(990);
  });

  it('orphaned trade resolves using entry candle close after switching away and back', () => {
    const now = Date.now();
    const candleTime = Math.floor(now / 1000 / TF_SECONDS) * TF_SECONDS - TF_SECONDS * 3;

    useDemoAccountStore.setState({
      balance: 990,
      openTrades: { 'sig-A': makeTrade('sig-A', 'A', TF, candleTime, 10, 0) },
    });

    const candles: Candle[] = [
      candle(candleTime - TF_SECONDS, 99, 100, 101, 98),
      candle(candleTime, 100, 102, 103, 99),
      candle(candleTime + TF_SECONDS, 102, 101, 103, 100),
      candle(candleTime + TF_SECONDS * 2, 101, 103, 104, 100),
    ];

    useDemoAccountStore.getState().resolveFromHistory('A', TF, candles);

    expect(useDemoAccountStore.getState().openTrades['sig-A']).toBeUndefined();
    expect(useDemoAccountStore.getState().balance).toBe(1008);
  });

  it('resolveFromHistory resolves by earliest loaded candle when entry candle is older than window', () => {
    const now = Date.now();
    const candleTime = Math.floor(now / 1000 / TF_SECONDS) * TF_SECONDS - TF_SECONDS * 10;

    useDemoAccountStore.setState({
      balance: 990,
      openTrades: { 'sig-stuck': makeTrade('sig-stuck', 'A', TF, candleTime, 10, 0) },
    });

    const candles: Candle[] = [
      candle(candleTime + TF_SECONDS * 5, 99, 101, 102, 98),
      candle(candleTime + TF_SECONDS * 6, 101, 103, 104, 100),
      candle(candleTime + TF_SECONDS * 7, 103, 102, 104, 101),
    ];

    useDemoAccountStore.getState().resolveFromHistory('A', TF, candles);

    const state = useDemoAccountStore.getState();
    expect(state.openTrades['sig-stuck']).toBeUndefined();
    expect(state.history).toHaveLength(1);
    expect(state.history[0].resolutionType).toBe('fallback');
  });

  it('resolveFromHistory does not fallback-resolve when entry candle is within loaded range but missing (temporary gap)', () => {
    const now = Date.now();
    const candleTime = Math.floor(now / 1000 / TF_SECONDS) * TF_SECONDS - TF_SECONDS * 3;

    useDemoAccountStore.setState({
      balance: 990,
      openTrades: { 'sig-gap': makeTrade('sig-gap', 'A', TF, candleTime, 10, 0) },
    });

    const candles: Candle[] = [
      candle(candleTime - TF_SECONDS, 99, 100, 101, 98),
      candle(candleTime + TF_SECONDS, 102, 101, 103, 100),
      candle(candleTime + TF_SECONDS * 2, 101, 103, 104, 100),
    ];

    useDemoAccountStore.getState().resolveFromHistory('A', TF, candles);

    expect(useDemoAccountStore.getState().openTrades['sig-gap']).toBeDefined();
  });

  it('resolveFromHistory uses the real entry candle open (not the stale fallbackEntryPrice) when entryPrice was never confirmed live', () => {
    // Репродукция бага: сделка "осиротела" (вкладка была свёрнута/reload
    // произошёл до того, как live-поток успел вызвать confirmEntryPrice) —
    // trade.entryPrice остаётся null. fallbackEntryPrice (=100, цена
    // сигнала — close ещё формирующейся свечи ДО открытия сделки) заметно
    // ниже реальной цены открытия свечи входа (entryCandle.open = 105).
    // Относительно РЕАЛЬНОГО входа (105) цена на экспирации (103) для buy —
    // явный убыток, но относительно устаревшего fallbackEntryPrice (100)
    // это выглядело бы как выигрыш. Демо-счёт обязан резолвить по
    // реальному входу, а не по случайно оказавшейся под рукой цене сигнала.
    const now = Date.now();
    const candleTime = Math.floor(now / 1000 / TF_SECONDS) * TF_SECONDS - TF_SECONDS * 3;

    useDemoAccountStore.setState({
      balance: 990,
      openTrades: {
        'sig-unconfirmed': {
          ...makeTrade('sig-unconfirmed', 'A', TF, candleTime, 10, 0, 'buy', 100),
          entryPrice: null, // never confirmed live
        },
      },
    });

    const candles: Candle[] = [
      candle(candleTime - TF_SECONDS, 99, 100, 101, 98),
      candle(candleTime, 105, 103, 106, 102), // real entry candle: opens at 105
      candle(candleTime + TF_SECONDS, 103, 101, 104, 100),
    ];

    useDemoAccountStore.getState().resolveFromHistory('A', TF, candles);

    const state = useDemoAccountStore.getState();
    expect(state.openTrades['sig-unconfirmed']).toBeUndefined();
    expect(state.history).toHaveLength(1);
    // 103 (expiry close) < 105 (real entry open) => loss for a buy trade.
    expect(state.history[0].outcome).toBe('loss');
    expect(state.history[0].pnl).toBe(-10);
    expect(state.balance).toBe(990); // stake already deducted at open, nothing refunded on loss
  });

  it('resolveFromHistory still respects an already-confirmed entryPrice (does not override with entryCandle.open)', () => {
    const now = Date.now();
    const candleTime = Math.floor(now / 1000 / TF_SECONDS) * TF_SECONDS - TF_SECONDS * 3;

    useDemoAccountStore.setState({
      balance: 990,
      openTrades: {
        'sig-confirmed': makeTrade('sig-confirmed', 'A', TF, candleTime, 10, 0, 'buy', 100),
      },
    });

    const candles: Candle[] = [
      candle(candleTime - TF_SECONDS, 99, 100, 101, 98),
      candle(candleTime, 105, 103, 106, 102),
      candle(candleTime + TF_SECONDS, 103, 101, 104, 100),
    ];

    useDemoAccountStore.getState().resolveFromHistory('A', TF, candles);

    // Confirmed entryPrice was 100 (from makeTrade default), close is 103
    // => still a win, regardless of entryCandle.open (105).
    expect(useDemoAccountStore.getState().history[0].outcome).toBe('win');
  });

  it('resolveFromHistory does not resolve when candles array is empty', () => {
    useDemoAccountStore.setState({
      balance: 990,
      openTrades: { 'sig-empty': makeTrade('sig-empty', 'A', TF, 1000, 10, 0) },
    });

    useDemoAccountStore.getState().resolveFromHistory('A', TF, []);

    expect(useDemoAccountStore.getState().openTrades['sig-empty']).toBeDefined();
  });
});

describe('useDemoAccountStore — entry price confirmation', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    useDemoAccountStore.setState({
      autoTradeEnabled: true,
      stage0Amount: 10,
      stageAmounts: [25, 50, 100],
      balance: 1000,
      martingale: {},
    });
  });

  it('openTrade stores knownOpenPrice as entryPrice when provided', () => {
    const T = 5_000_000;
    const signal = makeSignal('sig-entry-confirm', 'A', TF, T);

    useDemoAccountStore.getState().openTrade(signal, 100.5);

    const trade = useDemoAccountStore.getState().openTrades['sig-entry-confirm'];
    expect(trade).toBeDefined();
    expect(trade?.entryPrice).toBe(100.5);
    expect(trade?.fallbackEntryPrice).toBe(100);
  });

  it('openTrade sets entryPrice to null when knownOpenPrice not provided', () => {
    const T = 6_000_000;
    const signal = makeSignal('sig-entry-null', 'A', TF, T);

    useDemoAccountStore.getState().openTrade(signal);

    const trade = useDemoAccountStore.getState().openTrades['sig-entry-null'];
    expect(trade).toBeDefined();
    expect(trade?.entryPrice).toBeNull();
    expect(trade?.fallbackEntryPrice).toBe(100);
  });

  it('confirmEntryPrice sets entryPrice on matching trades with null entryPrice', () => {
    const candleTime = 7_000_000 + TF_SECONDS;

    useDemoAccountStore.setState({
      balance: 990,
      openTrades: {
        'sig-confirm-1': makeTrade('sig-confirm-1', 'A', TF, candleTime, 10, 0, 'buy', 0),
        'sig-confirm-2': makeTrade('sig-confirm-2', 'A', TF, candleTime, 10, 0, 'sell', 0),
      },
    });
    // Fix entryPrice to null for the test
    useDemoAccountStore.setState((s) => ({
      openTrades: {
        'sig-confirm-1': { ...s.openTrades['sig-confirm-1'], entryPrice: null },
        'sig-confirm-2': { ...s.openTrades['sig-confirm-2'], entryPrice: null },
      },
    }));

    useDemoAccountStore.getState().confirmEntryPrice('A', TF, candleTime, 100.5);

    const state = useDemoAccountStore.getState();
    expect(state.openTrades['sig-confirm-1']?.entryPrice).toBe(100.5);
    expect(state.openTrades['sig-confirm-2']?.entryPrice).toBe(100.5);
  });

  it('confirmEntryPrice does not overwrite already-confirmed entryPrice', () => {
    const candleTime = 8_000_000 + TF_SECONDS;

    useDemoAccountStore.setState({
      balance: 990,
      openTrades: {
        'sig-locked': { ...makeTrade('sig-locked', 'A', TF, candleTime, 10, 0), entryPrice: 99 },
      },
    });

    useDemoAccountStore.getState().confirmEntryPrice('A', TF, candleTime, 100.5);

    expect(useDemoAccountStore.getState().openTrades['sig-locked']?.entryPrice).toBe(99);
  });

  it('confirmEntryPrice ignores trades on different symbol or timeframe', () => {
    const candleTime = 9_000_000 + TF_SECONDS;

    useDemoAccountStore.setState({
      balance: 990,
      openTrades: {
        'sig-other-sym': { ...makeTrade('sig-other-sym', 'B', TF, candleTime, 10, 0), entryPrice: null },
        'sig-other-tf': { ...makeTrade('sig-other-tf', 'A', '1m', candleTime, 10, 0), entryPrice: null },
      },
    });

    useDemoAccountStore.getState().confirmEntryPrice('A', TF, candleTime, 100.5);

    const state = useDemoAccountStore.getState();
    expect(state.openTrades['sig-other-sym']?.entryPrice).toBeNull();
    expect(state.openTrades['sig-other-tf']?.entryPrice).toBeNull();
  });

  it('resolveTrade uses confirmed entryPrice over fallback when determining win/loss', () => {
    const candleTime = 10_000_000;

    useDemoAccountStore.setState({
      balance: 990,
      openTrades: {
        'sig-confirmed-entry': { ...makeTrade('sig-confirmed-entry', 'A', TF, candleTime, 10, 0), entryPrice: 100.5 },
      },
    });

    useDemoAccountStore.getState().checkExpiries(100.3, (candleTime + TF_SECONDS) * 1000, 'A', TF);

    expect(useDemoAccountStore.getState().history[0].outcome).toBe('loss');
  });
});

describe('useDemoAccountStore — openTrade timing and dedup', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    useDemoAccountStore.setState({
      autoTradeEnabled: true,
      stage0Amount: 10,
      stageAmounts: [25, 50, 100],
      balance: 1000,
      martingale: {},
    });
  });

  it('openTrade sets candleTime and expiryAt one full timeframe after signal.time', () => {
    const T = 1_000_000;
    const signal = makeSignal('sig-open-1', 'A', TF, T);

    useDemoAccountStore.getState().openTrade(signal);

    const trade = useDemoAccountStore.getState().openTrades['sig-open-1'];
    expect(trade).toBeDefined();
    expect(trade?.candleTime).toBe(T + TF_SECONDS);
    expect(trade?.expiryAt).toBe((T + TF_SECONDS * 2) * 1000);
    expect(trade?.expiryAt).toBeGreaterThan((T + TF_SECONDS) * 1000);
  });

  it('openTrade does not duplicate an already-open trade', () => {
    const T = 2_000_000;
    const signal = makeSignal('sig-dup-1', 'A', TF, T);

    useDemoAccountStore.getState().openTrade(signal);
    const balanceAfterFirst = useDemoAccountStore.getState().balance;

    useDemoAccountStore.getState().openTrade(signal);
    const balanceAfterSecond = useDemoAccountStore.getState().balance;

    expect(balanceAfterFirst).toBe(balanceAfterSecond);
    expect(Object.keys(useDemoAccountStore.getState().openTrades)).toHaveLength(1);
  });
});

describe('useDemoAccountStore — currentLossStreak (аудит 2026-09-13, "не допустить 3 убыточные сделки подряд")', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    useDemoAccountStore.setState({
      autoTradeEnabled: true,
      stage0Amount: 10,
      stageAmounts: [25, 50, 100],
      balance: 1000,
      martingale: {},
    });
  });

  it('starts at 0 on a fresh account', () => {
    expect(useDemoAccountStore.getState().currentLossStreak).toBe(0);
  });

  it('checkExpiries: two consecutive real losses bring the streak to 2', () => {
    const t1 = 100000;
    useDemoAccountStore.setState({
      openTrades: { 'sig-1': makeTrade('sig-1', 'EURUSD', TF, t1, 10, 0) },
    });
    useDemoAccountStore.getState().checkExpiries(95, (t1 + TF_SECONDS) * 1000, 'EURUSD', TF);
    expect(useDemoAccountStore.getState().currentLossStreak).toBe(1);

    const t2 = t1 + TF_SECONDS;
    useDemoAccountStore.setState({
      openTrades: { 'sig-2': makeTrade('sig-2', 'EURUSD', TF, t2, 10, 1) },
    });
    useDemoAccountStore.getState().checkExpiries(95, (t2 + TF_SECONDS) * 1000, 'EURUSD', TF);
    expect(useDemoAccountStore.getState().currentLossStreak).toBe(2);
  });

  it('checkExpiries: a win resets an in-progress streak back to 0', () => {
    const t1 = 100000;
    useDemoAccountStore.setState({
      openTrades: { 'sig-1': makeTrade('sig-1', 'EURUSD', TF, t1, 10, 0) },
    });
    useDemoAccountStore.getState().checkExpiries(95, (t1 + TF_SECONDS) * 1000, 'EURUSD', TF);
    expect(useDemoAccountStore.getState().currentLossStreak).toBe(1);

    const t2 = t1 + TF_SECONDS;
    useDemoAccountStore.setState({
      openTrades: { 'sig-2': makeTrade('sig-2', 'EURUSD', TF, t2, 10, 1) },
    });
    useDemoAccountStore.getState().checkExpiries(105, (t2 + TF_SECONDS) * 1000, 'EURUSD', TF);
    expect(useDemoAccountStore.getState().currentLossStreak).toBe(0);
  });

  it('checkExpiries: a tie (timeout push) neither continues nor resets the streak', () => {
    const t1 = 100000;
    useDemoAccountStore.setState({
      openTrades: { 'sig-1': makeTrade('sig-1', 'EURUSD', TF, t1, 10, 0) },
    });
    useDemoAccountStore.getState().checkExpiries(95, (t1 + TF_SECONDS) * 1000, 'EURUSD', TF);
    expect(useDemoAccountStore.getState().currentLossStreak).toBe(1);

    const t2 = t1 + TF_SECONDS;
    useDemoAccountStore.setState({
      openTrades: { 'sig-2': makeTrade('sig-2', 'EURUSD', TF, t2, 10, 1) },
    });
    // Entry price 100, close 100 — a tie, per the same convention already
    // used elsewhere in this file (see "checkExpiries tie synchronously
    // sets analytics outcome to 'timeout'" above).
    useDemoAccountStore.getState().checkExpiries(100, (t2 + TF_SECONDS) * 1000, 'EURUSD', TF);
    expect(useDemoAccountStore.getState().currentLossStreak).toBe(1);
  });

  it('resolveFromHistory updates the streak the same way checkExpiries does', () => {
    const now = Date.now();
    const candleTime = Math.floor(now / 1000 / TF_SECONDS) * TF_SECONDS - TF_SECONDS * 3;

    useDemoAccountStore.setState({
      openTrades: { 'sig-A': makeTrade('sig-A', 'A', TF, candleTime, 10, 0) },
    });

    // Entry 100, candle after expiry closes at 99 (below entry) → loss for a
    // 'buy' trade — same resolution shape as the existing orphaned-trade
    // tests above, just with a losing close instead of a winning one.
    const candles: Candle[] = [
      candle(candleTime - TF_SECONDS, 99, 100, 101, 98),
      candle(candleTime, 100, 102, 103, 99),
      candle(candleTime + TF_SECONDS, 99, 98, 100, 97),
      candle(candleTime + TF_SECONDS * 2, 98, 97, 99, 96),
    ];

    useDemoAccountStore.getState().resolveFromHistory('A', TF, candles);

    expect(useDemoAccountStore.getState().openTrades['sig-A']).toBeUndefined();
    expect(useDemoAccountStore.getState().currentLossStreak).toBe(1);
  });

  it('resetAccount clears an in-progress streak back to 0', () => {
    const t1 = 100000;
    useDemoAccountStore.setState({
      openTrades: { 'sig-1': makeTrade('sig-1', 'EURUSD', TF, t1, 10, 0) },
    });
    useDemoAccountStore.getState().checkExpiries(95, (t1 + TF_SECONDS) * 1000, 'EURUSD', TF);
    expect(useDemoAccountStore.getState().currentLossStreak).toBe(1);

    useDemoAccountStore.getState().resetAccount();
    expect(useDemoAccountStore.getState().currentLossStreak).toBe(0);
  });
});

describe('useDemoAccountStore — persist migration', () => {
  it('migrates from v1 (consecutiveLosses/currentStake) to v5, converting legacy percents to amounts', () => {
    const v1State = {
      balance: 500,
      baseStake: 10,
      consecutiveLosses: 2,
      currentStake: 40,
      profitPercent: 80,
      autoTradeEnabled: true,
      openTrades: {},
      history: [],
    };

    const result = migrateDemoAccountState(v1State, 1);

    expect((result as { consecutiveLosses?: number }).consecutiveLosses).toBeUndefined();
    expect((result as { currentStake?: number }).currentStake).toBeUndefined();
    expect(result.martingale).toEqual({});
    expect(result.stage0Amount).toBe(10);
    // Legacy default percents [250,500,1000] of stage0Amount=10 → [25,50,100]
    expect(result.stageAmounts).toEqual([25, 50, 100]);
    expect(result.balance).toBe(500);
    expect(result.history).toEqual([]);
    expect(result.openTrades).toEqual({});
    expect(result.profitPercent).toBe(80);
    expect(result.autoTradeEnabled).toBe(true);
  });

  it('migrates from v3 (baseStake → stage0Amount, halted defaults, percents → amounts)', () => {
    const v3State = {
      balance: 500,
      baseStake: 15,
      stagePercents: [250, 500, 1000] as [number, number, number],
      profitPercent: 80,
      autoTradeEnabled: true,
      martingale: {
        'EURUSD:5m': { stage: 1 },
      },
      openTrades: {},
      history: [],
    };

    const result = migrateDemoAccountState(v3State, 3);

    expect((result as { baseStake?: number }).baseStake).toBeUndefined();
    expect(result.stage0Amount).toBe(15);
    expect(result.martingale['EURUSD:5m']).toEqual({ stage: 1, halted: false });
    // stage0Amount=15 with percents [250,500,1000] → [37.5, 75, 150]
    expect(result.stageAmounts).toEqual([37.5, 75, 150]);
    expect(result.balance).toBe(500);
    expect(result.profitPercent).toBe(80);
    expect(result.autoTradeEnabled).toBe(true);
  });

  it('migrates from v4 with stageAmounts already absent (percent-based), keeping effective stakes', () => {
    const v4State = {
      balance: 500,
      stage0Amount: 10,
      stagePercents: [250, 500, 1000] as [number, number, number],
      profitPercent: 80,
      autoTradeEnabled: true,
      martingale: {},
      openTrades: {},
      history: [],
    };

    const result = migrateDemoAccountState(v4State, 4);

    expect(result.stageAmounts).toEqual([25, 50, 100]);
    expect((result as { stagePercents?: unknown }).stagePercents).toBeUndefined();
  });

  it('migrates from v5 (no martingaleEnabled field) defaulting it to true, preserving prior behavior', () => {
    const v5State = {
      balance: 500,
      stage0Amount: 10,
      stageAmounts: [25, 50, 100] as [number, number, number],
      profitPercent: 80,
      autoTradeEnabled: true,
      martingale: { 'EURUSD:5m': { stage: 2, halted: false } },
      openTrades: {},
      history: [],
    };

    const result = migrateDemoAccountState(v5State, 5);

    expect(result.martingaleEnabled).toBe(true);
    expect(result.stageAmounts).toEqual([25, 50, 100]);
    expect(result.martingale['EURUSD:5m']).toEqual({ stage: 2, halted: false });
  });
});
