import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CandleTimer } from '@/ui/CandleTimer';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTickStore } from '@/stores/useTickStore';
import { serverClock } from '@/data/server-clock';
import type { Candle } from '@/types/domain';

// Аудит (синхронизация таймера обратного отсчёта свечи с реальным
// открытием/закрытием свечи): раньше CandleTimer.tsx вычислял границу
// свечи ТОЛЬКО по формуле Math.floor(nowMs / tfMs) * tfSec — то есть
// предполагал, что границы свечей идеально выровнены по эпохе Unix и
// идут непрерывно, полностью игнорируя реальные свечи в useTickStore.
// Это расходится с реальностью, когда лента данных прерывиста
// (compactTimeline() намеренно пропускает выходные для форекса — см.
// src/data/compact-timeline.ts) — то есть ИМЕННО в тот момент, когда
// пользователю особенно важно видеть корректный отсчёт. Теперь таймер
// обязан считать границу от candles[candles.length-1].time — того же
// источника истины, которым пользуются schedulePreCloseTimer() и
// checkExpiries() для реального открытия/закрытия сделок.
function candle(time: number): Candle {
  return { time, open: 100, high: 101, low: 99, close: 100, volume: 1 };
}

describe('CandleTimer — sync with real candle open/close', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSettingsStore.setState({ symbolId: 'BTCUSDT', timeframe: '5m' });
    useTickStore.setState({ candles: [], candleLifecycle: 'live', marketClosed: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives the countdown from the real last candle, not from raw epoch-aligned wall clock', () => {
    // Реальная последняя свеча открылась в T (специально НЕ выровнена по
    // "чистой" границе 5-минутного таймфрейма — как это бывает после
    // пропуска выходных/переподключения фида).
    const T = 1_700_000_037; // заведомо не кратно 300 (5m)
    const nowMs = (T + 60) * 1000; // прошла 1 минута с реального открытия свечи

    serverClock.sync(nowMs);
    useTickStore.setState({ candles: [candle(T)] });

    render(<CandleTimer />);

    // Осталось 4 минуты до закрытия РЕАЛЬНОЙ свечи (T + 300 - (T+60) = 240s = 4:00),
    // а не до ближайшей "чистой" эпоха-выровненной границы, которая была
    // бы другой цифрой.
    expect(screen.getByText('4:00')).toBeInTheDocument();
  });

  it('falls back to epoch-aligned estimate only when no real candle has loaded yet', () => {
    useTickStore.setState({ candles: [] });

    render(<CandleTimer />);

    // Не падает и не блокирует рендер — просто временная оценка до
    // прихода первой реальной свечи.
    expect(screen.getByText('Свеча')).toBeInTheDocument();
  });
});
