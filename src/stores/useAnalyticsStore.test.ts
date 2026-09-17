import { describe, it, expect, beforeEach } from 'vitest';
import { useAnalyticsStore } from './useAnalyticsStore';
import type { Signal } from '@/types/domain';

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

describe('useAnalyticsStore', () => {
  beforeEach(() => {
    useAnalyticsStore.getState().clearAll();
  });

  describe('addSignal', () => {
    it('adds a signal to the front of the list', () => {
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 'sig-1' }));
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 'sig-2' }));
      const signals = useAnalyticsStore.getState().signals;
      expect(signals).toHaveLength(2);
      expect(signals[0].id).toBe('sig-2');
    });

    it('caps resolved signals at 100', () => {
      for (let i = 0; i < 110; i++) {
        useAnalyticsStore.getState().addSignal(makeSignal({ id: `sig-${i}`, outcome: 'win' }));
      }
      expect(useAnalyticsStore.getState().signals).toHaveLength(100);
      // Most recent 100 are kept (sig-10..sig-109); the oldest 10 are evicted.
      expect(useAnalyticsStore.getState().signals[0].id).toBe('sig-109');
      expect(useAnalyticsStore.getState().signals.some((s) => s.id === 'sig-9')).toBe(false);
    });

    // Аудит (баг: «сигналы после закрытия сделки не обрабатываются в
    // ИСТОРИЮ СИГНАЛОВ»): outcome === 'pending' сигнал ждёт исхода, который
    // выставляется асинхронно (см. useDemoAccountStore.checkExpiries/
    // resolveFromHistory → updateSignalOutcome, которая обновляет запись по
    // id через `.map()` и молча ничего не делает, если id уже не в массиве).
    // Раньше простое `.slice(0, MAX_SIGNALS)` по свежести могло вытолкнуть
    // такой pending-сигнал из массива ДО того, как его исход наступил —
    // сигнал бесследно исчезал из «ИСТОРИЯ СИГНАЛОВ», хотя демо-сделка по
    // нему потом закрывалась и была видна в «Последние сделки». Теперь
    // pending-сигналы никогда не подпадают под эвикшн.
    it('never evicts pending signals even when far beyond the cap', () => {
      for (let i = 0; i < 150; i++) {
        useAnalyticsStore.getState().addSignal(makeSignal({ id: `pending-${i}`, outcome: 'pending' }));
      }
      expect(useAnalyticsStore.getState().signals).toHaveLength(150);
      expect(useAnalyticsStore.getState().signals.every((s) => s.outcome === 'pending')).toBe(true);
    });

    it('evicts resolved signals to stay near the cap while preserving pending ones regardless of position', () => {
      // A pending signal opened early (e.g. an open demo trade the user is
      // still waiting on) followed by many newer resolved signals from
      // switching symbols — the pending one must not be pushed out.
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 'still-open', outcome: 'pending' }));
      for (let i = 0; i < 120; i++) {
        useAnalyticsStore.getState().addSignal(makeSignal({ id: `resolved-${i}`, outcome: 'win' }));
      }
      const signals = useAnalyticsStore.getState().signals;
      expect(signals.some((s) => s.id === 'still-open')).toBe(true);
      expect(signals.filter((s) => s.outcome === 'win')).toHaveLength(100);

      // Once its trade finally closes, updateSignalOutcome must still find it.
      useAnalyticsStore.getState().updateSignalOutcome('still-open', 'win');
      expect(useAnalyticsStore.getState().signals.find((s) => s.id === 'still-open')?.outcome).toBe('win');
    });

    it('does not add a duplicate signal with the same id', () => {
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 'sig-1', score: 3 }));
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 'sig-1', score: 5 }));
      const signals = useAnalyticsStore.getState().signals;
      expect(signals).toHaveLength(1);
      expect(signals[0].score).toBe(3);
    });

    it('does not add a duplicate even when other signals are in between', () => {
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 'sig-1' }));
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 'sig-2' }));
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 'sig-1' }));
      expect(useAnalyticsStore.getState().signals).toHaveLength(2);
    });
  });

  describe('upsertSignal', () => {
    it('inserts a new signal if id does not exist', () => {
      useAnalyticsStore.getState().upsertSignal(makeSignal({ id: 'sig-1' }));
      expect(useAnalyticsStore.getState().signals).toHaveLength(1);
    });

    it('replaces an existing signal with the same id', () => {
      useAnalyticsStore.getState().upsertSignal(makeSignal({ id: 'sig-1', score: 3 }));
      useAnalyticsStore.getState().upsertSignal(makeSignal({ id: 'sig-1', score: 5 }));
      const signals = useAnalyticsStore.getState().signals;
      expect(signals).toHaveLength(1);
      expect(signals[0].score).toBe(5);
    });
  });

  describe('setCurrentSignal', () => {
    it('sets the current signal', () => {
      const sig = makeSignal({ id: 'current' });
      useAnalyticsStore.getState().setCurrentSignal(sig);
      expect(useAnalyticsStore.getState().currentSignal?.id).toBe('current');
    });

    it('clears the current signal when passed null', () => {
      useAnalyticsStore.getState().setCurrentSignal(makeSignal());
      useAnalyticsStore.getState().setCurrentSignal(null);
      expect(useAnalyticsStore.getState().currentSignal).toBeNull();
    });
  });

  describe('updateSignalOutcome', () => {
    it('updates the outcome of a matching signal', () => {
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 'sig-1', outcome: 'pending' }));
      useAnalyticsStore.getState().updateSignalOutcome('sig-1', 'win');
      expect(useAnalyticsStore.getState().signals[0].outcome).toBe('win');
    });

    it('updates currentSignal if its id matches', () => {
      const sig = makeSignal({ id: 'sig-1', outcome: 'pending' });
      useAnalyticsStore.getState().setCurrentSignal(sig);
      useAnalyticsStore.getState().updateSignalOutcome('sig-1', 'loss');
      expect(useAnalyticsStore.getState().currentSignal?.outcome).toBe('loss');
    });

    it('does not modify signals when id does not match', () => {
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 'sig-1', outcome: 'pending' }));
      useAnalyticsStore.getState().updateSignalOutcome('nonexistent', 'win');
      expect(useAnalyticsStore.getState().signals[0].outcome).toBe('pending');
    });
  });

  describe('setCalibrationResult', () => {
    it('sets calibration ready when totalTrades > 0', () => {
      useAnalyticsStore.getState().setCalibrationResult({
        symbolId: 'BTCUSDT', timeframe: '15m', bestExpiryBars: 2,
        directionAccuracy: 0.6, totalTrades: 10, calibratedAt: Date.now(),
      });
      expect(useAnalyticsStore.getState().calibrationReady).toBe(true);
      expect(useAnalyticsStore.getState().calibrationSampleCount).toBe(10);
      expect(useAnalyticsStore.getState().expiryCalibrationAccuracy).toBe(0.6);
    });

    // BUGFIX (независимый аудит, 2026-09-08): ATR-бэктест — историческая
    // симуляция, полностью отдельная от живого винрейта по реальным
    // демо-сделкам (см. expiryCalibrationAccuracy у AnalyticsState и его
    // комментарий). Раньше setCalibrationResult() перезаписывал общее
    // поле `winRate`, которое recomputeStats() использует для ЖИВОЙ
    // статистики (StatusBar.tsx, "Винрейт (лайв)" в CalibrationPanel.tsx) —
    // запуск ATR-бэктеста временно подменял видимый пользователю живой
    // винрейт историческим до следующего resolved-сигнала. `winRate`
    // должен оставаться нетронутым здесь при любом входе.
    it('does not touch the live winRate field', () => {
      useAnalyticsStore.getState().setCalibrationResult({
        symbolId: 'BTCUSDT', timeframe: '15m', bestExpiryBars: 2,
        directionAccuracy: 0.6, totalTrades: 10, calibratedAt: Date.now(),
      });
      expect(useAnalyticsStore.getState().winRate).toBeNull();
    });

    it('sets expiryCalibrationAccuracy to null when directionAccuracy is 0', () => {
      useAnalyticsStore.getState().setCalibrationResult({
        symbolId: 'BTCUSDT', timeframe: '15m', bestExpiryBars: 2,
        directionAccuracy: 0, totalTrades: 5, calibratedAt: Date.now(),
      });
      expect(useAnalyticsStore.getState().expiryCalibrationAccuracy).toBeNull();
    });

    it('resets state when passed null', () => {
      useAnalyticsStore.getState().setCalibrationResult({
        symbolId: 'BTCUSDT', timeframe: '15m', bestExpiryBars: 2,
        directionAccuracy: 0.6, totalTrades: 10, calibratedAt: Date.now(),
      });
      useAnalyticsStore.getState().setCalibrationResult(null);
      expect(useAnalyticsStore.getState().calibrationReady).toBe(false);
      expect(useAnalyticsStore.getState().calibrationResult).toBeNull();
      expect(useAnalyticsStore.getState().expiryCalibrationAccuracy).toBeNull();
      expect(useAnalyticsStore.getState().winRate).toBeNull();
    });
  });

  describe('setCalibrationState', () => {
    it('sets calibration ready when sampleCount >= 10', () => {
      useAnalyticsStore.getState().setCalibrationState({ weights: [1], bias: 0, sampleCount: 10 });
      expect(useAnalyticsStore.getState().calibrationReady).toBe(true);
      expect(useAnalyticsStore.getState().calibrationSampleCount).toBe(10);
    });

    it('sets calibration not ready when sampleCount < 10', () => {
      useAnalyticsStore.getState().setCalibrationState({ weights: [1], bias: 0, sampleCount: 5 });
      expect(useAnalyticsStore.getState().calibrationReady).toBe(false);
    });

    it('resets state when passed null', () => {
      useAnalyticsStore.getState().setCalibrationState({ weights: [1], bias: 0, sampleCount: 15 });
      useAnalyticsStore.getState().setCalibrationState(null);
      expect(useAnalyticsStore.getState().calibrationReady).toBe(false);
      expect(useAnalyticsStore.getState().calibrationState).toBeNull();
    });
  });

  describe('recomputeStats', () => {
    it('computes winRate from completed signals', () => {
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's1', outcome: 'win' }));
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's2', outcome: 'loss' }));
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's3', outcome: 'win' }));
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's4', outcome: 'pending' }));
      useAnalyticsStore.getState().recomputeStats();
      // 2 wins, 1 loss → 2/3
      expect(useAnalyticsStore.getState().winRate).toBeCloseTo(2 / 3, 5);
    });

    it('counts timeout as completed but excludes from winRate', () => {
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's1', outcome: 'win' }));
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's2', outcome: 'loss' }));
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's3', outcome: 'timeout' }));
      useAnalyticsStore.getState().recomputeStats();
      // winRate = 1 win / (1 win + 1 loss) = 0.5, sampleCount = 3
      expect(useAnalyticsStore.getState().winRate).toBeCloseTo(0.5, 5);
      expect(useAnalyticsStore.getState().calibrationSampleCount).toBe(3);
    });

    it('sets winRate to null when only timeouts', () => {
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's1', outcome: 'timeout' }));
      useAnalyticsStore.getState().recomputeStats();
      expect(useAnalyticsStore.getState().winRate).toBeNull();
      expect(useAnalyticsStore.getState().calibrationSampleCount).toBe(1);
    });

    it('sets winRate to null when no completed signals', () => {
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's1', outcome: 'pending' }));
      useAnalyticsStore.getState().recomputeStats();
      expect(useAnalyticsStore.getState().winRate).toBeNull();
    });

    it('sets winRate to null when no signals at all', () => {
      useAnalyticsStore.getState().recomputeStats();
      expect(useAnalyticsStore.getState().winRate).toBeNull();
    });

    // Аудит (синхронизация с демо-счётом): сигналы без реально открытой
    // демо-сделки (tradeOpened === false) не должны искажать винрейт.
    it('excludes tradeOpened: false signals from winRate and sample count', () => {
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's1', outcome: 'win', tradeOpened: true }));
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's2', outcome: 'loss', tradeOpened: true }));
      // These three would flip the winRate/sample count if counted.
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's3', outcome: 'win', tradeOpened: false }));
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's4', outcome: 'loss', tradeOpened: false }));
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's5', outcome: 'timeout', tradeOpened: false }));
      useAnalyticsStore.getState().recomputeStats();

      expect(useAnalyticsStore.getState().winRate).toBeCloseTo(0.5, 5);
      expect(useAnalyticsStore.getState().calibrationSampleCount).toBe(2);
    });

    it('treats tradeOpened: undefined (legacy signals) as traded, counting them toward winRate', () => {
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's1', outcome: 'win' }));
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's2', outcome: 'loss' }));
      useAnalyticsStore.getState().recomputeStats();

      expect(useAnalyticsStore.getState().winRate).toBeCloseTo(0.5, 5);
      expect(useAnalyticsStore.getState().calibrationSampleCount).toBe(2);
    });

    it('winRate is null when every signal has tradeOpened: false', () => {
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's1', outcome: 'win', tradeOpened: false }));
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's2', outcome: 'loss', tradeOpened: false }));
      useAnalyticsStore.getState().recomputeStats();

      expect(useAnalyticsStore.getState().winRate).toBeNull();
      expect(useAnalyticsStore.getState().calibrationSampleCount).toBe(0);
    });
  });

  describe('clearAll', () => {
    it('resets everything', () => {
      useAnalyticsStore.getState().addSignal(makeSignal());
      useAnalyticsStore.getState().setCurrentSignal(makeSignal());
      useAnalyticsStore.getState().setConnectionStatus('live');
      useAnalyticsStore.getState().clearAll();
      expect(useAnalyticsStore.getState().signals).toHaveLength(0);
      expect(useAnalyticsStore.getState().currentSignal).toBeNull();
      expect(useAnalyticsStore.getState().winRate).toBeNull();
      expect(useAnalyticsStore.getState().calibrationReady).toBe(false);
    });
  });

  describe('clearSignalHistory', () => {
    it('clears signals and winRate but not connectionStatus', () => {
      useAnalyticsStore.getState().addSignal(makeSignal());
      useAnalyticsStore.getState().setConnectionStatus('live');
      useAnalyticsStore.getState().clearSignalHistory();
      expect(useAnalyticsStore.getState().signals).toHaveLength(0);
      expect(useAnalyticsStore.getState().winRate).toBeNull();
      expect(useAnalyticsStore.getState().connectionStatus).toBe('live');
    });
  });

  describe('resetSession', () => {
    // Баг 1 (ИСТОРИЯ СИГНАЛОВ): resetSession() заменяет clearAll() в
    // useTickStore.start() — при переключении символа/таймфрейма или
    // перезагрузке приложения список сигналов и статистика должны
    // сохраняться (очистка — только вручную через clearSignalHistory),
    // сбрасывается лишь "активная" карточка предыдущего сигнала.
    it('clears currentSignal but preserves signals, winRate and calibration state', () => {
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's1', outcome: 'win' }));
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's2', outcome: 'loss' }));
      useAnalyticsStore.getState().recomputeStats();
      useAnalyticsStore.getState().setCurrentSignal(makeSignal({ id: 'current' }));
      useAnalyticsStore.getState().setCalibrationState({ weights: [1], bias: 0, sampleCount: 12 });

      useAnalyticsStore.getState().resetSession();

      expect(useAnalyticsStore.getState().currentSignal).toBeNull();
      expect(useAnalyticsStore.getState().signals).toHaveLength(2);
      expect(useAnalyticsStore.getState().winRate).toBeCloseTo(0.5, 5);
      expect(useAnalyticsStore.getState().calibrationReady).toBe(true);
    });
  });

  // ДЕАКТИВИРОВАНО (2026-09-06, по прямому запросу): автоудаление истории
  // сигналов раз в сутки убрано — см. App.tsx (хук больше не вызывается) и
  // JSDoc у maybeRunAutoCleanup ниже. Метод оставлен как no-op вместо
  // удаления, чтобы не трогать persist-схему (lastAutoCleanupAt) для уже
  // существующих пользователей и типизацию для любого стороннего кода,
  // который могло на него ссылаться.
  describe('maybeRunAutoCleanup (deactivated)', () => {
    it('is a no-op: never clears signals, regardless of lastAutoCleanupAt', () => {
      useAnalyticsStore.getState().addSignal(makeSignal({ id: 's1', outcome: 'win' }));
      useAnalyticsStore.setState({ lastAutoCleanupAt: Date.now() - 25 * 60 * 60 * 1000 }); // 25h ago — would have tripped the old timer
      const ran = useAnalyticsStore.getState().maybeRunAutoCleanup();
      expect(ran).toBe(false);
      expect(useAnalyticsStore.getState().signals).toHaveLength(1);
    });

    it('does not touch lastAutoCleanupAt at all', () => {
      useAnalyticsStore.setState({ lastAutoCleanupAt: null });
      useAnalyticsStore.getState().maybeRunAutoCleanup();
      expect(useAnalyticsStore.getState().lastAutoCleanupAt).toBeNull();
    });
  });
});
