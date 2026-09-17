import { describe, it, expect } from 'vitest';
import { getHumanReadableError, classifyDataError, sourceLabel, type DataErrorReason } from './error-messages';

describe('getHumanReadableError', () => {
  it('returns a non-empty string for every known reason', () => {
    const reasons: DataErrorReason[] = [
      'unknown-symbol', 'all-sources-failed', 'timeout', 'connection-lost',
      'unsupported-symbol', 'rate-limited', 'not-configured', 'unknown',
    ];
    for (const reason of reasons) {
      const msg = getHumanReadableError(reason);
      expect(msg).toBeTruthy();
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(5);
    }
  });

  it('returns different messages for different reasons', () => {
    const msg1 = getHumanReadableError('timeout');
    const msg2 = getHumanReadableError('all-sources-failed');
    expect(msg1).not.toBe(msg2);
  });
});

describe('classifyDataError', () => {
  it('returns timeout for messages containing "timeout"', () => {
    expect(classifyDataError('Binance: request timeout')).toBe('timeout');
    expect(classifyDataError('Deriv WS: request timeout')).toBe('timeout');
  });

  it('returns connection-lost for connection-related errors', () => {
    expect(classifyDataError('socket lost')).toBe('connection-lost');
    expect(classifyDataError('connection failed')).toBe('connection-lost');
    expect(classifyDataError('Disconnected')).toBe('connection-lost');
    expect(classifyDataError('connection closed')).toBe('connection-lost');
  });

  it('returns unsupported-symbol for unsupported messages', () => {
    expect(classifyDataError('unsupported timeframe')).toBe('unsupported-symbol');
    expect(classifyDataError('Unsupported symbol')).toBe('unsupported-symbol');
  });

  it('returns rate-limited for rate limit messages', () => {
    expect(classifyDataError('rate limit exceeded')).toBe('rate-limited');
    expect(classifyDataError('Rate Limit hit')).toBe('rate-limited');
  });

  it('returns not-configured for configuration messages', () => {
    expect(classifyDataError('Supabase not configured')).toBe('not-configured');
    expect(classifyDataError('proxy required')).toBe('not-configured');
  });

  it('returns unknown for unrecognized messages', () => {
    expect(classifyDataError('something unexpected happened')).toBe('unknown');
  });

  it('returns unknown for null/undefined messages', () => {
    expect(classifyDataError(null)).toBe('unknown');
    expect(classifyDataError(undefined)).toBe('unknown');
    expect(classifyDataError('')).toBe('unknown');
  });

  it('is case-insensitive', () => {
    expect(classifyDataError('TIMEOUT')).toBe('timeout');
    expect(classifyDataError('UNSUPPORTED')).toBe('unsupported-symbol');
  });
});

describe('sourceLabel', () => {
  it('returns human-readable labels for all known sources', () => {
    expect(sourceLabel('binance')).toBe('Binance');
    expect(sourceLabel('deriv')).toBe('Deriv');
    expect(sourceLabel('twelvedata')).toBe('TwelveData');
    expect(sourceLabel('finnhub')).toBe('Finnhub');
    expect(sourceLabel('yahoo')).toBe('Yahoo');
  });

  it('returns the raw id for unknown sources', () => {
    expect(sourceLabel('unknown' as never)).toBe('unknown');
  });
});
