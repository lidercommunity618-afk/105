import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PredictionAccuracyBadge } from '@/ui/PredictionAccuracyBadge';
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

// Аудит (тот же класс бага, что и StatusBar/ИСТОРИЯ СИГНАЛОВ): бейдж не
// должен учитывать сигналы без реально открытой демо-сделки.
describe('PredictionAccuracyBadge — excludes tradeOpened: false signals', () => {
  beforeEach(() => {
    useAnalyticsStore.getState().clearAll();
  });

  it('renders nothing when there are no traded resolved signals', () => {
    useAnalyticsStore.getState().addSignal(
      makeSignal({ id: 's1', outcome: 'win', tradeOpened: false }),
    );
    useAnalyticsStore.getState().addSignal(
      makeSignal({ id: 's2', outcome: 'loss', tradeOpened: false }),
    );

    const { container } = render(<PredictionAccuracyBadge />);

    expect(container.textContent).toBe('');
  });

  it('computes the win rate using only traded signals, ignoring tradeOpened: false ones', () => {
    // 2 traded: 1 win, 1 loss → 50%. If the 3 untraded wins below were
    // counted, the rate would incorrectly read much higher.
    useAnalyticsStore.getState().addSignal(makeSignal({ id: 's1', outcome: 'win', tradeOpened: true }));
    useAnalyticsStore.getState().addSignal(makeSignal({ id: 's2', outcome: 'loss', tradeOpened: true }));
    useAnalyticsStore.getState().addSignal(makeSignal({ id: 's3', outcome: 'win', tradeOpened: false }));
    useAnalyticsStore.getState().addSignal(makeSignal({ id: 's4', outcome: 'win', tradeOpened: false }));
    useAnalyticsStore.getState().addSignal(makeSignal({ id: 's5', outcome: 'win', tradeOpened: false }));

    render(<PredictionAccuracyBadge />);

    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('· 2')).toBeInTheDocument();
  });

  it('treats tradeOpened: undefined (legacy signals) as traded', () => {
    useAnalyticsStore.getState().addSignal(makeSignal({ id: 's1', outcome: 'win' }));
    useAnalyticsStore.getState().addSignal(makeSignal({ id: 's2', outcome: 'loss' }));

    render(<PredictionAccuracyBadge />);

    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('· 2')).toBeInTheDocument();
  });

  it('ignores pending and timeout signals just like before (only win/loss count toward the rate)', () => {
    useAnalyticsStore.getState().addSignal(makeSignal({ id: 's1', outcome: 'win', tradeOpened: true }));
    useAnalyticsStore.getState().addSignal(makeSignal({ id: 's2', outcome: 'pending', tradeOpened: true }));
    useAnalyticsStore.getState().addSignal(makeSignal({ id: 's3', outcome: 'timeout', tradeOpened: true }));

    render(<PredictionAccuracyBadge />);

    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByText('· 1')).toBeInTheDocument();
  });
});
