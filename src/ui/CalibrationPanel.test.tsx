import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CalibrationPanel } from '@/ui/CalibrationPanel';
import { useAnalyticsStore } from '@/stores/useAnalyticsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Signal } from '@/types/domain';

function makeSignal(overrides: Partial<Signal> & { id: string }): Signal {
  return {
    symbolId: 'BTCUSDT',
    direction: 'buy',
    strength: 'moderate',
    score: 3,
    calibratedProbability: 0.6,
    entryPrice: 100,
    reason: 'test',
    indicators: {} as unknown as Signal['indicators'],
    pattern: null,
    time: 1000,
    timeframe: '15m',
    outcome: 'win',
    frozenAt: null,
    isRevised: false,
    isPreClose: false,
    revisionNote: null,
    barsToResolve: 5,
    spread: null,
    spreadSource: null,
    recommendedExpiry: 900,
    featureVector: [],
    factors: [{ kind: 'pattern', name: 'hammer', direction: 'buy', contribution: 1, argument: 'hammer pattern (100%)', value: null }],
    rejectedPatterns: [],
    engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
    chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
    marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
    tradeOpened: true,
    ...overrides,
  };
}

// BUGFIX (независимый аудит, 2026-09-08): предпросмотр пересчёта надёжности
// паттернов раньше не сбрасывался при смене инструмента — "Применить" мог
// записать множители, посчитанные по статистике одного символа, как
// override для другого (см. комментарий у useEffect([symbolId]) в
// CalibrationPanel.tsx).
describe('CalibrationPanel — reliability preview resets on symbol switch', () => {
  beforeEach(() => {
    useAnalyticsStore.getState().clearAll();
    useSettingsStore.getState().setSymbol('BTCUSDT');
  });

  it('closes an open preview when the active symbol changes', () => {
    // BUGFIX (аудит 2026-09-13, MIN_FACTOR_SAMPLES 5 -> 20): было 5 сделок,
    // ровно старый порог; теперь нужно >= MIN_FACTOR_SAMPLES (20), иначе
    // 'hammer' исключается из предпросмотра и reliabilityPreview остаётся
    // пустым массивом (кнопка "Применить" не рендерится вовсе). Точное
    // соотношение win/loss для этого теста не важно — он проверяет только
    // сброс предпросмотра при смене символа, а не конкретное значение
    // множителя.
    for (let i = 0; i < 20; i++) {
      useAnalyticsStore.getState().addSignal(
        makeSignal({ id: `btc-${i}`, outcome: i < 16 ? 'win' : 'loss' }),
      );
    }

    render(<CalibrationPanel />);

    // Two buttons share the label "Калибровать" — the ATR-backtest run
    // button (top of the panel) and the reliability-preview button (under
    // "КАЛИБРОВКА НАДЁЖНОСТИ ПАТТЕРНОВ"); the latter is the second one in
    // document order.
    const calibrateButtons = screen.getAllByRole('button', { name: 'Калибровать' });
    fireEvent.click(calibrateButtons[1]);

    expect(screen.getByText('Применить')).toBeInTheDocument();

    // Switch the active instrument without clicking "Отмена"/"Применить".
    act(() => {
      useSettingsStore.getState().setSymbol('EURUSD');
    });

    expect(screen.queryByText('Применить')).not.toBeInTheDocument();
    expect(screen.queryByText('Отмена')).not.toBeInTheDocument();
  });
});

// Этап 4 плана калибровки: то же самое исправление для нового предпросмотра
// подбора ПОРОГА ВХОДА (thresholdPreview) — тот же класс бага, что и выше
// для reliabilityPreview, теперь во второй, симметричной секции.
describe('CalibrationPanel — threshold preview resets on symbol switch', () => {
  beforeEach(() => {
    useAnalyticsStore.getState().clearAll();
    useSettingsStore.getState().setSymbol('BTCUSDT');
  });

  it('closes an open threshold preview when the active symbol changes', () => {
    render(<CalibrationPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Подобрать порог' }));

    // No 'model'-sourced signal history yet, so the preview renders its
    // "insufficient history" reason text instead of a candidate table.
    const reasonText = 'Недостаточно истории с calibrationSource=model для оценки — калибровочная модель ещё не готова (см. MIN_THRESHOLD_BACKTEST_SAMPLES).';
    expect(screen.getByText(reasonText)).toBeInTheDocument();

    // Switch the active instrument without clicking "Отмена"/"Применить".
    act(() => {
      useSettingsStore.getState().setSymbol('EURUSD');
    });

    expect(screen.queryByText(reasonText)).not.toBeInTheDocument();
  });
});

// АУДИТ ЭТАПА 4 (2026-09-09): найден и исправлен реальный баг — baselineWinRate,
// передаваемый в computeThresholdCandidates, изначально брался из ГЛОБАЛЬНОГО
// useAnalyticsStore.winRate (агрегат по ВСЕМ инструментам), а не из винрейта
// ТЕКУЩЕГО символа, хотя сами `signals` в тот же вызов уже фильтровались по
// symbolId. Эффект: инструмент с честной, но скромной статистикой мог
// получить "недостижимо без потери точности" только потому, что другой,
// гораздо более прибыльный инструмент задирал общий блендированный винрейт.
// Этот тест воспроизводит именно такой сценарий и фиксирует правильное
// поведение — точно та же по духу защита, что уже проверяется для
// reliabilityPreview/thresholdPreview выше, но для baselineWinRate.
describe('CalibrationPanel — threshold recommendation baseline is per-symbol, not global', () => {
  beforeEach(() => {
    useAnalyticsStore.getState().clearAll();
  });

  function seedSymbol(symbolId: string, winRate: number) {
    // Keep counts well under useAnalyticsStore's MAX_SIGNALS=100 GLOBAL cap
    // (shared across every instrument, not just this one — see
    // capSignals() in useAnalyticsStore.ts) so neither symbol's history
    // evicts the other's within this test, while still clearing
    // MIN_THRESHOLD_BACKTEST_SAMPLES.
    const count = 25;
    const wins = Math.round(count * winRate);
    for (let i = 0; i < count; i++) {
      useAnalyticsStore.getState().addSignal(
        makeSignal({
          id: `${symbolId}-${i}`,
          symbolId,
          time: i * 5,
          calibratedProbability: 0.6,
          calibrationSource: 'model',
          outcome: i < wins ? 'win' : 'loss',
          tradeOpened: true,
        }),
      );
    }
  }

  it('does not let a much stronger sibling instrument inflate the baseline for a weaker one', () => {
    // BTCUSDT: excellent live performance (96%). EURUSD: mediocre but
    // internally self-consistent performance (52%) — its own history alone
    // should be enough to recommend a threshold, since the candidate winRate
    // at the historical probability exactly matches EURUSD's own baseline.
    seedSymbol('BTCUSDT', 0.96);
    seedSymbol('EURUSD', 0.52);
    // recomputeStats() is normally triggered by outcome resolution in
    // production (tick-store/outcomes.ts); addSignal() alone does not call
    // it. Call it explicitly here so useAnalyticsStore.winRate (the global,
    // cross-instrument field) actually reflects the blended ~74% figure —
    // otherwise it stays null and the bug this test targets can't surface.
    useAnalyticsStore.getState().recomputeStats();

    useSettingsStore.getState().setSymbol('EURUSD');
    render(<CalibrationPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Подобрать порог' }));

    // If BTCUSDT's much better winRate had leaked into EURUSD's baseline
    // (the blended cross-instrument winRate is ~74%, well above EURUSD's
    // own 52%), no candidate would clear the accuracy floor and only the
    // "unreachable" reason text would render, with no Apply button.
    expect(screen.getByRole('button', { name: 'Применить' })).toBeInTheDocument();
  });
});
