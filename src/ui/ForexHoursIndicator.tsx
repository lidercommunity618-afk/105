import { useEffect, useState } from 'react';
import { Clock, Globe } from 'lucide-react';
import type { Symbol } from '@/types/domain';
import { isMarketOpen } from '@/data/market-hours';
import { serverClock } from '@/data/server-clock';
import { clsx } from '@/lib/utils';

interface ForexHoursIndicatorProps {
  symbol: Symbol;
}

const SESSION_NAMES: Record<string, string> = {
  sydney: 'Сидней',
  tokyo: 'Токио',
  london: 'Лондон',
  newyork: 'Нью-Йорк',
};

interface SessionInfo {
  name: string;
  isOpen: boolean;
}

function getActiveSessions(now: number): SessionInfo[] {
  const date = new Date(now);
  const hourUtc = date.getUTCHours() + date.getUTCMinutes() / 60;

  const sessions: SessionInfo[] = [
    { name: 'sydney', isOpen: hourUtc >= 22 || hourUtc < 7 },
    { name: 'tokyo', isOpen: hourUtc >= 0 && hourUtc < 9 },
    { name: 'london', isOpen: hourUtc >= 8 && hourUtc < 17 },
    { name: 'newyork', isOpen: hourUtc >= 13 && hourUtc < 22 },
  ];

  return sessions.map((s) => ({
    name: SESSION_NAMES[s.name] ?? s.name,
    isOpen: s.isOpen,
  }));
}

export function ForexHoursIndicator({ symbol }: ForexHoursIndicatorProps) {
  const [now, setNow] = useState(serverClock.now());

  useEffect(() => {
    const id = setInterval(() => setNow(serverClock.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (symbol.marketHours === null) {
    return (
      <div className="flex items-center gap-1.5 text-2xs text-base-400">
        <Globe size={12} className="text-success-400" />
        <span className="font-semibold text-success-400">24/7</span>
        <span className="text-base-500">крипто-рынок</span>
      </div>
    );
  }

  const open = isMarketOpen(symbol, now);
  const sessions = getActiveSessions(now);
  const activeSessions = sessions.filter((s) => s.isOpen);

  return (
    <div className="flex items-center gap-1.5 text-2xs">
      <Clock
        size={12}
        className={clsx(open ? 'text-success-400' : 'text-base-500')}
      />
      <span
        className={clsx(
          'font-semibold',
          open ? 'text-success-400' : 'text-accent-400',
        )}
      >
        {open ? 'ОТКРЫТ' : 'ЗАКРЫТ'}
      </span>
      {activeSessions.length > 0 ? (
        <span className="text-base-400">
          · {activeSessions.map((s) => s.name).join(' / ')}
        </span>
      ) : (
        <span className="text-base-500">· нет активных сессий</span>
      )}
    </div>
  );
}
