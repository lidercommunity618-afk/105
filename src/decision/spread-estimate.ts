import type { Tick, SpreadEstimate } from '@/types/domain';

const STATIC_SPREADS: Record<string, number> = {
  BTCUSDT: 0.5,
  ETHUSDT: 0.3,
  SOLUSDT: 0.05,
  BNBUSDT: 0.1,
  XRPUSDT: 0.005,
  EURUSD: 0.00008,
  GBPUSD: 0.00009,
  USDJPY: 0.009,
  AUDUSD: 0.00008,
};

export function estimateSpread(symbolId: string, tick: Tick | null): SpreadEstimate {
  if (tick && tick.bid != null && tick.ask != null && tick.ask >= tick.bid) {
    return {
      spread: tick.ask - tick.bid,
      source: 'live',
    };
  }
  return {
    spread: STATIC_SPREADS[symbolId] ?? 0,
    source: 'estimated',
  };
}
