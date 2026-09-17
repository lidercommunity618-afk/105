import { serverClock } from '@/data/server-clock';

export type SessionName = 'sydney' | 'tokyo' | 'london' | 'newyork';
export type SessionRegime = SessionName | 'overlap' | 'closed';

interface SessionWindow {
  name: SessionName;
  // Exchange-local open/close hour. Sydney/Tokyo don't observe DST in a way
  // that shifts these UTC-adjacent windows meaningfully for our purposes,
  // so they stay as fixed UTC hours (unchanged from before). London/New York
  // DO shift relative to UTC — the EU and US switch to summer time on
  // different dates — so those two are computed from IANA timezones instead
  // of a hardcoded UTC hour (see localHourToUtc below).
  openUtcHour?: number;
  closeUtcHour?: number;
  timeZone?: string;
  openLocalHour?: number;
  closeLocalHour?: number;
}

const SESSIONS: SessionWindow[] = [
  { name: 'sydney', openUtcHour: 22, closeUtcHour: 7 },
  { name: 'tokyo', openUtcHour: 0, closeUtcHour: 9 },
  { name: 'london', timeZone: 'Europe/London', openLocalHour: 8, closeLocalHour: 17 },
  { name: 'newyork', timeZone: 'America/New_York', openLocalHour: 8, closeLocalHour: 17 },
];

// Converts an exchange-local hour (in `timeZone`) to the UTC hour it
// currently corresponds to, on the given date — correctly tracking DST
// because the offset is derived from Intl's actual local-time rendering of
// `date`, not a static table. Several weeks a year (the EU/US DST switch
// windows don't align), a hardcoded UTC hour is off by exactly one hour;
// this recomputes the offset on every call so it never drifts.
function localHourToUtc(date: Date, timeZone: string, localHour: number): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  });
  const utcHourNow = date.getUTCHours();
  const localHourNow = parseInt(fmt.format(date), 10);
  let offset = localHourNow - utcHourNow;
  if (offset > 12) offset -= 24;
  if (offset < -12) offset += 24;
  return ((localHour - offset) % 24 + 24) % 24;
}

function resolvedWindow(s: SessionWindow, date: Date): { openUtcHour: number; closeUtcHour: number } {
  if (s.timeZone && s.openLocalHour !== undefined && s.closeLocalHour !== undefined) {
    return {
      openUtcHour: localHourToUtc(date, s.timeZone, s.openLocalHour),
      closeUtcHour: localHourToUtc(date, s.timeZone, s.closeLocalHour),
    };
  }
  return { openUtcHour: s.openUtcHour ?? 0, closeUtcHour: s.closeUtcHour ?? 0 };
}

export function getSessionRegime(now: number = serverClock.now()): SessionRegime {
  const date = new Date(now);
  const hourUtc = date.getUTCHours();
  const dayUtc = date.getUTCDay();
  if (dayUtc === 0 || dayUtc === 6) return 'closed';

  const active = SESSIONS.filter((s) => {
    const { openUtcHour, closeUtcHour } = resolvedWindow(s, date);
    if (openUtcHour < closeUtcHour) {
      return hourUtc >= openUtcHour && hourUtc < closeUtcHour;
    }
    return hourUtc >= openUtcHour || hourUtc < closeUtcHour;
  });

  // BUGFIX (аудит): раньше ЛЮБЫЕ 2+ одновременно активные сессии
  // возвращались как 'overlap', и isHighLiquiditySession() ниже безусловно
  // считала 'overlap' высоколиквидным окном. Но Sydney (22-07 UTC) и Tokyo
  // (0-9 UTC) перекрываются весь азиатский "мёртвый" интервал ~00:00-07:00
  // UTC — включая именно то предлондонское окно (Judas Swing, см. диагноз
  // 5 убыточных сделок 06:26-06:48 UTC), которое сама система должна
  // распознавать как низколиквидное. Только оверлап, включающий London или
  // New York — тот, что реально соответствует ICT-понятию высоколиквидного
  // "overlap" (London/NY session overlap) — теперь возвращается как
  // 'overlap'; чистый Sydney+Tokyo оверлап возвращается как одиночная
  // (более узнаваемая для нижестоящей логики) азиатская сессия.
  if (active.length >= 2) {
    const activeNames = new Set(active.map((s) => s.name));
    const hasWesternSession = activeNames.has('london') || activeNames.has('newyork');
    if (hasWesternSession) return 'overlap';
    return activeNames.has('tokyo') ? 'tokyo' : active[0].name;
  }
  if (active.length === 1) return active[0].name;
  return 'closed';
}

export function isHighLiquiditySession(regime: SessionRegime): boolean {
  return regime === 'london' || regime === 'newyork' || regime === 'overlap';
}
