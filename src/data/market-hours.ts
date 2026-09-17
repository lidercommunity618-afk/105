import type { MarketHoursConfig, Symbol } from '@/types/domain';
import { serverClock } from './server-clock';

const SUNDAY = 0;
const SATURDAY = 6;

export const FOREX_MARKET_HOURS: MarketHoursConfig = {
  openDays: [false, true, true, true, true, true, false],
  openMinutesUtc: 0,
  closeMinutesUtc: 24 * 60,
};

export function isMarketOpen(symbol: Symbol, now: number = serverClock.now()): boolean {
  if (symbol.marketHours === null) return true;
  return isMarketHoursOpen(symbol.marketHours, now);
}

export function isMarketHoursOpen(config: MarketHoursConfig, now: number): boolean {
  const date = new Date(now);
  const dayUtc = date.getUTCDay();
  const minutesUtc = date.getUTCHours() * 60 + date.getUTCMinutes();

  if (!config.openDays[dayUtc]) return false;

  const { openMinutesUtc, closeMinutesUtc } = config;

  if (openMinutesUtc <= closeMinutesUtc) {
    return minutesUtc >= openMinutesUtc && minutesUtc < closeMinutesUtc;
  }

  if (dayUtc === SATURDAY && minutesUtc >= openMinutesUtc) return true;
  if (dayUtc === SUNDAY && minutesUtc < closeMinutesUtc) return true;
  return false;
}

export function formatMarketStatus(symbol: Symbol): string {
  if (symbol.marketHours === null) return '24/7';
  return isMarketOpen(symbol) ? 'OPEN' : 'CLOSED';
}
