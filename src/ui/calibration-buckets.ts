import type { Signal } from '@/types/domain';

export const BUCKETS: { label: string; lo: number; hi: number }[] = [
  { label: '0–20%', lo: 0, hi: 0.2 },
  { label: '20–40%', lo: 0.2, hi: 0.4 },
  { label: '40–60%', lo: 0.4, hi: 0.6 },
  { label: '60–80%', lo: 0.6, hi: 0.8 },
  { label: '80–100%', lo: 0.8, hi: 1.001 },
];

export interface BucketRow {
  label: string;
  total: number;
  wins: number;
  winRate: number | null;
}

export function computeBuckets(signals: Signal[]): BucketRow[] {
  // Аудит (перенесённый фикс — расхождение N в таблице калибровки):
  // раньше здесь фильтровались только win/loss, БЕЗ учёта tradeOpened —
  // сигналы, по которым демо-сделка вообще не открывалась (halted-
  // мартингейл, autoTrade выключен, недостаточно баланса и т.д., см.
  // useDemoAccountStore.openTrade), но которые всё равно получили
  // fallback-исход от планировщика (tick-store/outcomes.ts, ветка
  // tradeOpened === false), попадали в N/винрейт этой таблицы наравне с
  // реально проторгованными. Из-за этого N в «НАДЁЖНОСТЬ ПО УВЕРЕННОСТИ»
  // не совпадал с количеством строк в «ИСТОРИЯ СИГНАЛОВ» и с
  // calibrationSampleCount (оба уже фильтруют по tradeOpened !== false —
  // см. SignalFeed.tsx/useAnalyticsStore.recomputeStats). tradeOpened
  // === undefined (сигналы, сохранённые до этого фикса) трактуется как
  // "да" — тем же способом, что и везде в приложении, чтобы не терять
  // задним числом уже накопленную историю.
  const resolved = signals.filter(
    (s) => s.tradeOpened !== false && (s.outcome === 'win' || s.outcome === 'loss'),
  );
  return BUCKETS.map((b) => {
    const inBucket = resolved.filter((s) => {
      const p = s.calibratedProbability;
      return p !== null && p >= b.lo && p < b.hi;
    });
    const wins = inBucket.filter((s) => s.outcome === 'win').length;
    return {
      label: b.label,
      total: inBucket.length,
      wins,
      winRate: inBucket.length > 0 ? wins / inBucket.length : null,
    };
  });
}
