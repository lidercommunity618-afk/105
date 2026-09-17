import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SignalCard, OutcomeBadge } from '@/ui/SignalCard';
import type { Signal, IndicatorSnapshot } from '@/types/domain';

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'BTCUSDT:1m:1700000000',
    symbolId: 'BTCUSDT',
    direction: 'buy',
    strength: 'moderate',
    score: 3.5,
    calibratedProbability: 0.6,
    entryPrice: 100,
    reason: 'Test reason',
    indicators: {} as IndicatorSnapshot,
    pattern: null,
    time: 1700000000,
    timeframe: '1m',
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

describe('OutcomeBadge', () => {
  it('renders nothing for a pending signal', () => {
    const { container } = render(<OutcomeBadge outcome="pending" />);
    expect(container.textContent).toBe('');
  });

  it('labels a win as Прибыль', () => {
    const { container } = render(<OutcomeBadge outcome="win" />);
    expect(container.textContent).toBe('Прибыль');
  });

  it('labels a loss as Убыток', () => {
    const { container } = render(<OutcomeBadge outcome="loss" />);
    expect(container.textContent).toBe('Убыток');
  });

  it('labels a timeout as Тайм-аут (not the old "Ничья")', () => {
    const { container } = render(<OutcomeBadge outcome="timeout" />);
    expect(container.textContent).toBe('Тайм-аут');
  });
});

describe('SignalCard (compact / history row)', () => {
  it('every non-pending outcome renders a visible OutcomeBadge label', () => {
    for (const outcome of ['win', 'loss', 'timeout'] as const) {
      const { container } = render(
        <SignalCard signal={makeSignal({ outcome })} pipSize={0.01} compact />,
      );
      // The badge text must actually be present in the rendered row — this
      // is the exact bug the user reported: history rows showing up with
      // and without a label side by side.
      expect(container.textContent).not.toBe('');
      expect(container.querySelector('span')?.parentElement?.textContent).toBeTruthy();
    }
  });

  it('a timeout row is styled as resolved, not left looking like a still-pending row', () => {
    const { container: timeoutContainer } = render(
      <SignalCard signal={makeSignal({ outcome: 'timeout' })} pipSize={0.01} compact />,
    );
    const { container: pendingContainer } = render(
      <SignalCard signal={makeSignal({ outcome: 'pending' })} pipSize={0.01} compact />,
    );
    const timeoutRow = timeoutContainer.firstElementChild as HTMLElement;
    const pendingRow = pendingContainer.firstElementChild as HTMLElement;
    // Before the fix, a timeout row used the exact same background/border
    // classes as a pending row (hasOutcome excluded 'timeout'), making a
    // fully-resolved signal indistinguishable at a glance from one still
    // awaiting an outcome.
    expect(timeoutRow.className).not.toBe(pendingRow.className);
  });

  it('win and loss rows still render distinct trend icons', () => {
    const { container: winContainer } = render(
      <SignalCard signal={makeSignal({ outcome: 'win' })} pipSize={0.01} compact />,
    );
    const { container: lossContainer } = render(
      <SignalCard signal={makeSignal({ outcome: 'loss' })} pipSize={0.01} compact />,
    );
    expect(winContainer.querySelector('svg')).toBeTruthy();
    expect(lossContainer.querySelector('svg')).toBeTruthy();
  });

  // Аудит (ИСТОРИЯ СИГНАЛОВ === Последние сделки): SignalCard больше не
  // отвечает за "непроторгованные" сигналы — та фильтрация теперь целиком
  // на уровне SignalFeed (см. SignalFeed.test.tsx), поэтому SignalCard
  // отображает реальный outcome (win/loss/timeout) независимо от
  // tradeOpened — само поле здесь больше не читается.
  it('renders the real outcome label regardless of tradeOpened — the field is not consulted here anymore', () => {
    const { container: withFlag } = render(
      <SignalCard signal={makeSignal({ outcome: 'win', tradeOpened: false })} pipSize={0.01} compact />,
    );
    const { container: withoutFlag } = render(
      <SignalCard signal={makeSignal({ outcome: 'win', tradeOpened: true })} pipSize={0.01} compact />,
    );
    expect(withFlag.textContent).toContain('Прибыль');
    expect(withoutFlag.textContent).toContain('Прибыль');
    expect(withFlag.textContent).not.toContain('Не торговался');
  });
});
