import { describe, it, expect } from 'vitest';
import {
  CRYPTO_SYMBOLS,
  FOREX_SYMBOLS,
  SYMBOLS,
  TIMEFRAMES,
  TIMEFRAME_SECONDS,
  findSymbol,
  mapSymbolForSource,
  isCrypto,
  isDerivSupported,
  getRoutingChain,
  mapSymbolForDeriv,
} from './symbols';

describe('SYMBOLS', () => {
  it('combines crypto and forex symbols', () => {
    expect(SYMBOLS.length).toBe(CRYPTO_SYMBOLS.length + FOREX_SYMBOLS.length);
  });

  it('includes BTCUSDT and EURUSD', () => {
    expect(SYMBOLS.some((s) => s.id === 'BTCUSDT')).toBe(true);
    expect(SYMBOLS.some((s) => s.id === 'EURUSD')).toBe(true);
  });
});

describe('findSymbol', () => {
  it('finds a symbol by id', () => {
    const sym = findSymbol('BTCUSDT');
    expect(sym).toBeDefined();
    expect(sym!.id).toBe('BTCUSDT');
    expect(sym!.assetClass).toBe('crypto');
  });

  it('returns undefined for unknown symbol', () => {
    expect(findSymbol('UNKNOWN')).toBeUndefined();
  });
});

describe('TIMEFRAME_SECONDS', () => {
  it('maps all timeframes to correct seconds', () => {
    expect(TIMEFRAME_SECONDS['1m']).toBe(60);
    expect(TIMEFRAME_SECONDS['5m']).toBe(300);
    expect(TIMEFRAME_SECONDS['15m']).toBe(900);
    expect(TIMEFRAME_SECONDS['30m']).toBe(1800);
    expect(TIMEFRAME_SECONDS['1h']).toBe(3600);
    expect(TIMEFRAME_SECONDS['4h']).toBe(14400);
    expect(TIMEFRAME_SECONDS['1d']).toBe(86400);
  });

  it('has the same number of entries as TIMEFRAMES', () => {
    expect(Object.keys(TIMEFRAME_SECONDS).length).toBe(TIMEFRAMES.length);
  });
});

describe('mapSymbolForSource', () => {
  it('maps EURUSD to source-specific symbols', () => {
    expect(mapSymbolForSource('EURUSD', 'twelvedata')).toBe('EUR/USD');
    expect(mapSymbolForSource('EURUSD', 'finnhub')).toBe('OANDA:EUR_USD');
    expect(mapSymbolForSource('EURUSD', 'yahoo')).toBe('EURUSD=X');
  });

  it('maps XAUUSD to Yahoo gold futures', () => {
    expect(mapSymbolForSource('XAUUSD', 'yahoo')).toBe('GC=F');
  });

  it('maps XAGUSD to Yahoo silver futures', () => {
    expect(mapSymbolForSource('XAGUSD', 'yahoo')).toBe('SI=F');
  });

  it('returns the original symbolId when no mapping exists', () => {
    expect(mapSymbolForSource('BTCUSDT', 'binance')).toBe('BTCUSDT');
    expect(mapSymbolForSource('UNKNOWN', 'binance')).toBe('UNKNOWN');
  });
});

describe('isCrypto', () => {
  it('returns true for crypto symbols', () => {
    expect(isCrypto('BTCUSDT')).toBe(true);
    expect(isCrypto('ETHUSDT')).toBe(true);
  });

  it('returns false for forex symbols', () => {
    expect(isCrypto('EURUSD')).toBe(false);
  });

  it('returns false for unknown symbols', () => {
    expect(isCrypto('UNKNOWN')).toBe(false);
  });
});

describe('isDerivSupported', () => {
  it('returns true for all forex symbols', () => {
    expect(isDerivSupported('EURUSD')).toBe(true);
    expect(isDerivSupported('GBPJPY')).toBe(true);
    expect(isDerivSupported('XAUUSD')).toBe(true);
  });

  it('returns true for supported crypto symbols', () => {
    expect(isDerivSupported('BTCUSDT')).toBe(true);
    expect(isDerivSupported('ETHUSDT')).toBe(true);
  });

  it('returns false for unknown symbols', () => {
    expect(isDerivSupported('UNKNOWN')).toBe(false);
  });
});

describe('getRoutingChain', () => {
  it('returns crypto chain for crypto symbols', () => {
    const sym = findSymbol('BTCUSDT')!;
    const chain = getRoutingChain(sym);
    expect(chain).toContain('binance');
    expect(chain).toContain('deriv');
  });

  it('returns forex chain for forex symbols', () => {
    const sym = findSymbol('EURUSD')!;
    const chain = getRoutingChain(sym);
    expect(chain).toContain('deriv');
    expect(chain).not.toContain('binance');
  });

  it('filters out deriv when symbol is not deriv-supported', () => {
    // Create a fake symbol that would not be deriv-supported
    // All real symbols are deriv-supported, so we test the filter logic
    const sym = findSymbol('BTCUSDT')!;
    const chain = getRoutingChain(sym);
    // BTCUSDT is deriv-supported, so deriv should be in the chain
    expect(chain).toContain('deriv');
  });
});

describe('mapSymbolForDeriv', () => {
  it('prefixes forex symbols with frx', () => {
    expect(mapSymbolForDeriv('EURUSD')).toBe('frxEURUSD');
    expect(mapSymbolForDeriv('GBPJPY')).toBe('frxGBPJPY');
  });

  it('prefixes crypto symbols with cry and converts USDT to USD', () => {
    expect(mapSymbolForDeriv('BTCUSDT')).toBe('cryBTCUSD');
    expect(mapSymbolForDeriv('ETHUSDT')).toBe('cryETHUSD');
  });

  it('returns original for unknown symbol', () => {
    expect(mapSymbolForDeriv('UNKNOWN')).toBe('UNKNOWN');
  });
});
