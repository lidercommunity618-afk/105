import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SignalFeed } from '@/ui/SignalFeed';
import { useAnalyticsStore } from '@/stores/useAnalyticsStore';
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
    timeframe: '5m',
    outcome: 'pending',
    frozenAt: null,
    isRevised: false,
    isPreClose: false,
    revisionNote: null,
    barsToResolve: 5,
    spread: null,
    spreadSource: null,
    recommendedExpiry: 300,
    featureVector: [],
    factors: [], rejectedPatterns: [], engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
    chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
    marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
    ...overrides,
  };
}

// Аудит (ИСТОРИЯ СИГНАЛОВ === Последние сделки): список должен показывать
// ТОЛЬКО то же множество, что и реальная история демо-счёта — запись
// появляется исключительно после закрытия реальной демо-сделки.
describe('SignalFeed — ИСТОРИЯ СИГНАЛОВ mirrors closed demo trades only', () => {
  beforeEach(() => {
    useAnalyticsStore.getState().clearAll();
  });

  it('does not render a signal history section when there are no closed traded signals', () => {
    useAnalyticsStore.getState().addSignal(
      makeSignal({ id: 'sig-pending', outcome: 'pending', tradeOpened: true }),
    );
    useAnalyticsStore.getState().addSignal(
      makeSignal({ id: 'sig-untraded', outcome: 'timeout', tradeOpened: false }),
    );

    render(<SignalFeed />);

    expect(screen.queryByText('ИСТОРИЯ СИГНАЛОВ')).not.toBeInTheDocument();
  });

  it('excludes a still-pending signal from the history list even if a demo trade was opened', () => {
    useAnalyticsStore.getState().addSignal(
      makeSignal({ id: 'sig-pending', outcome: 'pending', tradeOpened: true }),
    );
    useAnalyticsStore.getState().addSignal(
      makeSignal({ id: 'sig-closed', outcome: 'win', tradeOpened: true }),
    );

    render(<SignalFeed />);

    expect(screen.getByText('ИСТОРИЯ СИГНАЛОВ')).toBeInTheDocument();
    expect(screen.getByText('Прибыль')).toBeInTheDocument();
    // The "Не торговался" badge and any row for the pending signal must not
    // leak into the list — pending signals are not shown at all anymore.
    expect(screen.queryByText('Не торговался')).not.toBeInTheDocument();
  });

  it('excludes a signal that never opened a demo trade (tradeOpened: false), even once resolved', () => {
    useAnalyticsStore.getState().addSignal(
      makeSignal({ id: 'sig-untraded', outcome: 'timeout', tradeOpened: false }),
    );
    useAnalyticsStore.getState().addSignal(
      makeSignal({ id: 'sig-closed', outcome: 'loss', tradeOpened: true }),
    );

    render(<SignalFeed />);

    expect(screen.getByText('Убыток')).toBeInTheDocument();
    expect(screen.queryByText('Не торговался')).not.toBeInTheDocument();
    expect(screen.queryByText('Тайм-аут')).not.toBeInTheDocument();
  });

  it('shows a closed signal (tradeOpened: true, outcome resolved) in the history list', () => {
    useAnalyticsStore.getState().addSignal(
      makeSignal({ id: 'sig-closed', outcome: 'win', tradeOpened: true }),
    );

    render(<SignalFeed />);

    expect(screen.getByText('ИСТОРИЯ СИГНАЛОВ')).toBeInTheDocument();
    expect(screen.getByText('Прибыль')).toBeInTheDocument();
  });

  it('treats tradeOpened: undefined (legacy signals) as traded — shown once resolved', () => {
    useAnalyticsStore.getState().addSignal(
      makeSignal({ id: 'sig-legacy', outcome: 'loss' }),
    );

    render(<SignalFeed />);

    expect(screen.getByText('Убыток')).toBeInTheDocument();
  });

  it('excludes the active (currentSignal) card from the history list even once resolved', () => {
    const current = makeSignal({ id: 'sig-current', outcome: 'win', tradeOpened: true });
    useAnalyticsStore.getState().addSignal(current);
    useAnalyticsStore.getState().setCurrentSignal(current);
    useAnalyticsStore.getState().addSignal(
      makeSignal({ id: 'sig-other', outcome: 'loss', tradeOpened: true }),
    );

    render(<SignalFeed />);

    // The active card (full, non-compact SignalCard) never renders an
    // outcome label at all — only the compact history rows do (see
    // SignalCard.tsx). So "Прибыль" must not appear anywhere: not as a
    // duplicate history row (excluded by id) and not on the active card
    // itself (which doesn't render outcome text in the first place).
    expect(screen.queryByText('Прибыль')).not.toBeInTheDocument();
    expect(screen.getByText('Убыток')).toBeInTheDocument();
  });
});
