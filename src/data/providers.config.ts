import type { Timeframe, SourceId } from '@/types/domain';

export const PROVIDERS_CONFIG = {
  binance: {
    restHosts: ['https://api.binance.com', 'https://api.binance.us'],
    wsHosts: { global: 'wss://stream.binance.com:9443/ws', us: 'wss://stream.binance.us:9443/ws' },
    intervalMap: { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d' } as Record<Timeframe, string>,
    reconnectBackoffMs: [3000, 6000, 12000, 30000, 60000],
    requestTimeoutMs: 10000,
    defaultHistory: 1000,
  },
  deriv: {
    wsUrl: 'wss://ws.derivws.com/websockets/v3',
    defaultAppId: '1089',
    granularityMap: { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 } as Record<Timeframe, number>,
    reconnectBackoffMs: [3000, 6000, 12000, 30000, 60000],
    pingIntervalMs: 15000,
    requestTimeoutMs: 10000,
    defaultHistory: 1000,
  },
  twelvedata: {
    restUrl: 'https://api.twelvedata.com/time_series',
    intervalMap: { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h', '4h': '4h', '1d': '1day' } as Record<Timeframe, string>,
    requestTimeoutMs: 10000,
    defaultHistory: 1000,
  },
  finnhub: {
    requestTimeoutMs: 10000,
    defaultHistory: 500,
  },
  yahoo: {
    requestTimeoutMs: 10000,
    defaultHistory: 1000,
  },
} as const;

export const ROUTING_CHAIN: Record<'crypto' | 'forex', readonly SourceId[]> = {
  crypto: ['binance', 'deriv'],
  forex: ['deriv', 'yahoo', 'twelvedata', 'finnhub'],
} as const;

import { getApiKey } from '@/stores/useApiKeysStore';

export function resolveDerivAppId(): string {
  const sessionKey = getApiKey('derivAppId');
  if (sessionKey && sessionKey.trim().length > 0) return sessionKey.trim();
  const raw = import.meta.env.VITE_DERIV_APP_ID;
  if (raw && raw.trim().length > 0) return raw.trim();
  return PROVIDERS_CONFIG.deriv.defaultAppId;
}

export function buildDerivWsUrl(): string {
  const appId = resolveDerivAppId();
  return `${PROVIDERS_CONFIG.deriv.wsUrl}?app_id=${encodeURIComponent(appId)}`;
}
export const DERIV_DEFAULT_APP_ID = PROVIDERS_CONFIG.deriv.defaultAppId;

export const STALE_TICK_MS = 45_000;
