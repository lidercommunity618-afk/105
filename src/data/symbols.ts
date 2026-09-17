import type { Symbol, Timeframe, SourceId } from '@/types/domain';
import { ROUTING_CHAIN } from './providers.config';
import { FOREX_MARKET_HOURS } from '@/data/market-hours';

export const CRYPTO_SYMBOLS: readonly Symbol[] = [
  {
    id: 'BTCUSDT',
    assetClass: 'crypto',
    displaySymbol: 'BTC/USDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    displayName: 'Bitcoin',
    pipSize: 0.01,
    marketHours: null,
  },
  {
    id: 'ETHUSDT',
    assetClass: 'crypto',
    displaySymbol: 'ETH/USDT',
    baseAsset: 'ETH',
    quoteAsset: 'USDT',
    displayName: 'Ethereum',
    pipSize: 0.01,
    marketHours: null,
  },
  {
    id: 'SOLUSDT',
    assetClass: 'crypto',
    displaySymbol: 'SOL/USDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    displayName: 'Solana',
    pipSize: 0.0001,
    marketHours: null,
  },
  {
    id: 'BNBUSDT',
    assetClass: 'crypto',
    displaySymbol: 'BNB/USDT',
    baseAsset: 'BNB',
    quoteAsset: 'USDT',
    displayName: 'BNB',
    pipSize: 0.01,
    marketHours: null,
  },
  {
    id: 'XRPUSDT',
    assetClass: 'crypto',
    displaySymbol: 'XRP/USDT',
    baseAsset: 'XRP',
    quoteAsset: 'USDT',
    displayName: 'XRP',
    pipSize: 0.0001,
    marketHours: null,
  },
];

export const FOREX_SYMBOLS: readonly Symbol[] = [
  {
    id: 'EURUSD',
    assetClass: 'forex',
    displaySymbol: 'EUR/USD',
    baseAsset: 'EUR',
    quoteAsset: 'USD',
    displayName: 'Euro / US Dollar',
    pipSize: 0.00001,
    marketHours: FOREX_MARKET_HOURS,
  },
  {
    id: 'GBPUSD',
    assetClass: 'forex',
    displaySymbol: 'GBP/USD',
    baseAsset: 'GBP',
    quoteAsset: 'USD',
    displayName: 'British Pound / US Dollar',
    pipSize: 0.00001,
    marketHours: FOREX_MARKET_HOURS,
  },
  {
    id: 'USDJPY',
    assetClass: 'forex',
    displaySymbol: 'USD/JPY',
    baseAsset: 'USD',
    quoteAsset: 'JPY',
    displayName: 'US Dollar / Japanese Yen',
    pipSize: 0.001,
    marketHours: FOREX_MARKET_HOURS,
  },
  {
    id: 'AUDUSD',
    assetClass: 'forex',
    displaySymbol: 'AUD/USD',
    baseAsset: 'AUD',
    quoteAsset: 'USD',
    displayName: 'Australian Dollar / US Dollar',
    pipSize: 0.00001,
    marketHours: FOREX_MARKET_HOURS,
  },
  {
    id: 'USDCHF',
    assetClass: 'forex',
    displaySymbol: 'USD/CHF',
    baseAsset: 'USD',
    quoteAsset: 'CHF',
    displayName: 'US Dollar / Swiss Franc',
    pipSize: 0.00001,
    marketHours: FOREX_MARKET_HOURS,
  },
  {
    id: 'USDCAD',
    assetClass: 'forex',
    displaySymbol: 'USD/CAD',
    baseAsset: 'USD',
    quoteAsset: 'CAD',
    displayName: 'US Dollar / Canadian Dollar',
    pipSize: 0.00001,
    marketHours: FOREX_MARKET_HOURS,
  },
  {
    id: 'NZDUSD',
    assetClass: 'forex',
    displaySymbol: 'NZD/USD',
    baseAsset: 'NZD',
    quoteAsset: 'USD',
    displayName: 'New Zealand Dollar / US Dollar',
    pipSize: 0.00001,
    marketHours: FOREX_MARKET_HOURS,
  },
  {
    id: 'EURGBP',
    assetClass: 'forex',
    displaySymbol: 'EUR/GBP',
    baseAsset: 'EUR',
    quoteAsset: 'GBP',
    displayName: 'Euro / British Pound',
    pipSize: 0.00001,
    marketHours: FOREX_MARKET_HOURS,
  },
  {
    id: 'EURJPY',
    assetClass: 'forex',
    displaySymbol: 'EUR/JPY',
    baseAsset: 'EUR',
    quoteAsset: 'JPY',
    displayName: 'Euro / Japanese Yen',
    pipSize: 0.001,
    marketHours: FOREX_MARKET_HOURS,
  },
  {
    id: 'GBPJPY',
    assetClass: 'forex',
    displaySymbol: 'GBP/JPY',
    baseAsset: 'GBP',
    quoteAsset: 'JPY',
    displayName: 'British Pound / Japanese Yen',
    pipSize: 0.001,
    marketHours: FOREX_MARKET_HOURS,
  },
  {
    id: 'XAUUSD',
    assetClass: 'forex',
    displaySymbol: 'XAU/USD',
    baseAsset: 'XAU',
    quoteAsset: 'USD',
    displayName: 'Gold / US Dollar',
    pipSize: 0.01,
    marketHours: FOREX_MARKET_HOURS,
  },
  {
    id: 'XAGUSD',
    assetClass: 'forex',
    displaySymbol: 'XAG/USD',
    baseAsset: 'XAG',
    quoteAsset: 'USD',
    displayName: 'Silver / US Dollar',
    pipSize: 0.001,
    marketHours: FOREX_MARKET_HOURS,
  },
];

export const TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

export const SYMBOLS: readonly Symbol[] = [...CRYPTO_SYMBOLS, ...FOREX_SYMBOLS];

export function findSymbol(id: string): Symbol | undefined {
  return SYMBOLS.find((s) => s.id === id);
}

const SOURCE_SYMBOL_MAP: Partial<Record<string, Partial<Record<SourceId, string>>>> = {
  EURUSD: { twelvedata: 'EUR/USD', finnhub: 'OANDA:EUR_USD', yahoo: 'EURUSD=X' },
  GBPUSD: { twelvedata: 'GBP/USD', finnhub: 'OANDA:GBP_USD', yahoo: 'GBPUSD=X' },
  USDJPY: { twelvedata: 'USD/JPY', finnhub: 'OANDA:USD_JPY', yahoo: 'USDJPY=X' },
  AUDUSD: { twelvedata: 'AUD/USD', finnhub: 'OANDA:AUD_USD', yahoo: 'AUDUSD=X' },
  USDCHF: { twelvedata: 'USD/CHF', finnhub: 'OANDA:USD_CHF', yahoo: 'USDCHF=X' },
  USDCAD: { twelvedata: 'USD/CAD', finnhub: 'OANDA:USD_CAD', yahoo: 'USDCAD=X' },
  NZDUSD: { twelvedata: 'NZD/USD', finnhub: 'OANDA:NZD_USD', yahoo: 'NZDUSD=X' },
  EURGBP: { twelvedata: 'EUR/GBP', finnhub: 'OANDA:EUR_GBP', yahoo: 'EURGBP=X' },
  EURJPY: { twelvedata: 'EUR/JPY', finnhub: 'OANDA:EUR_JPY', yahoo: 'EURJPY=X' },
  GBPJPY: { twelvedata: 'GBP/JPY', finnhub: 'OANDA:GBP_JPY', yahoo: 'GBPJPY=X' },
  XAUUSD: { twelvedata: 'XAU/USD', finnhub: 'OANDA:XAU_USD', yahoo: 'GC=F' },
  XAGUSD: { twelvedata: 'XAG/USD', finnhub: 'OANDA:XAG_USD', yahoo: 'SI=F' },
};

export function mapSymbolForSource(symbolId: string, sourceId: SourceId): string {
  return SOURCE_SYMBOL_MAP[symbolId]?.[sourceId] ?? symbolId;
}

export function isCrypto(symbolId: string): boolean {
  const sym = findSymbol(symbolId);
  return sym?.assetClass === 'crypto';
}

const DERIV_CRYPTO_SYMBOLS = new Set(['BTCUSD', 'ETHUSD', 'BNBUSD', 'SOLUSD', 'XRPUSD']);

function toDerivCryptoId(symbolId: string): string {
  return symbolId.replace(/USDT$/, 'USD');
}

export function isDerivSupported(symbolId: string): boolean {
  const sym = findSymbol(symbolId);
  if (!sym) return false;
  if (sym.assetClass === 'forex') return true;
  if (sym.assetClass === 'crypto') return DERIV_CRYPTO_SYMBOLS.has(toDerivCryptoId(symbolId));
  return false;
}

export function getRoutingChain(symbol: Symbol): SourceId[] {
  const base = ROUTING_CHAIN[symbol.assetClass] ?? [];
  return base.filter((id) => {
    if (id === 'deriv') return isDerivSupported(symbol.id);
    return true;
  });
}

export function mapSymbolForDeriv(symbolId: string): string {
  const sym = findSymbol(symbolId);
  if (!sym) return symbolId;
  if (sym.assetClass === 'forex') return `frx${symbolId}`;
  if (sym.assetClass === 'crypto') return `cry${toDerivCryptoId(symbolId)}`;
  return symbolId;
}
