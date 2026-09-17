import { describe, it, expect } from 'vitest';
import { getSessionRegime } from '@/compute/session-regime';

// London/New York previously used hardcoded UTC hours (8-17 and 13-22),
// which are only correct for part of the year: the EU (BST) and US (EDT)
// switch to summer time on different Sundays in March and revert on
// different Sundays in November, so several weeks a year the fixed-UTC
// version reads the wrong session (or misses/adds an hour of overlap)
// entirely. These fixtures pick one date each side of both boundaries.

function utc(y: number, m: number, d: number, h: number, min = 0): number {
  return Date.UTC(y, m - 1, d, h, min);
}

describe('getSessionRegime — DST correctness (Пункт 7)', () => {
  it('reads London as open at 08:30 local in winter (UTC = local, no DST)', () => {
    // 8 Jan 2026 08:30 UTC = 08:30 London time (GMT, no DST).
    const regime = getSessionRegime(utc(2026, 1, 8, 8, 30));
    expect(['london', 'overlap']).toContain(regime);
  });

  it('reads London as still in-session at 08:30 UTC in summer (BST = UTC+1, so 09:30 local)', () => {
    // 8 Jul 2026 08:30 UTC = 09:30 London time (BST). A hardcoded
    // openUtcHour=8 check would treat this the same as the winter case
    // (correctly, coincidentally, since it's still >=8) — the boundary case
    // below is the one a hardcoded hour actually gets wrong.
    const regime = getSessionRegime(utc(2026, 7, 8, 8, 30));
    expect(['london', 'overlap']).toContain(regime);
  });

  it('closes London at 17:30 UTC in summer even though a hardcoded 17:00 UTC close would still show it open', () => {
    // 8 Jul 2026 17:30 UTC = 18:30 London time (BST) — after the exchange's
    // 17:00 *local* close. The old hardcoded closeUtcHour=17 would have
    // read this as within the 8-17 UTC window and called it open; the
    // DST-aware version correctly closes it an hour earlier in UTC terms.
    const regime = getSessionRegime(utc(2026, 7, 8, 17, 30));
    expect(regime).not.toBe('london');
  });

  it('opens New York at 13:30 UTC in winter (EST = UTC-5, so 08:30 local)', () => {
    // 8 Jan 2026 13:30 UTC = 08:30 New York time (EST).
    const regime = getSessionRegime(utc(2026, 1, 8, 13, 30));
    expect(['newyork', 'overlap']).toContain(regime);
  });

  it('has New York already open at 12:30 UTC in summer (EDT = UTC-4, so 08:30 local) though a hardcoded 13:00 open would miss it', () => {
    // 8 Jul 2026 12:30 UTC = 08:30 New York time (EDT). The old hardcoded
    // openUtcHour=13 would have read this as pre-open; the DST-aware
    // version correctly shows New York already in session an hour earlier
    // in UTC terms.
    const regime = getSessionRegime(utc(2026, 7, 8, 12, 30));
    expect(['newyork', 'overlap']).toContain(regime);
  });

  it('returns closed on a UTC weekend', () => {
    // 10 Jan 2026 is a Saturday.
    expect(getSessionRegime(utc(2026, 1, 10, 12, 0))).toBe('closed');
  });
});
