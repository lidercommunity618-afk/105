import { Target } from 'lucide-react';
import { useAnalyticsStore } from '@/stores/useAnalyticsStore';
import { clsx } from '@/lib/utils';

const MAX_SAMPLES = 50;

export function PredictionAccuracyBadge() {
  const signals = useAnalyticsStore((s) => s.signals);

  // Аудит (тот же класс бага, что и StatusBar/ИСТОРИЯ СИГНАЛОВ): сигналы
  // без реально открытой демо-сделки (tradeOpened === false) исключаются —
  // иначе бейдж показывает "винрейт", в который подмешаны непроторгованные
  // сигналы, что не соответствует реальному результату по демо-счёту.
  // tradeOpened === undefined (записи до этого фикса) трактуется как "да" —
  // тем же способом, что и в useAnalyticsStore.recomputeStats()/StatusBar.tsx.
  const traded = signals.filter((s) => s.tradeOpened !== false);
  const resolved = traded.filter(
    (s) => s.outcome === 'win' || s.outcome === 'loss',
  );
  const recent = resolved.slice(0, MAX_SAMPLES);

  if (recent.length === 0) return null;

  const wins = recent.filter((s) => s.outcome === 'win').length;
  const winRate = wins / recent.length;
  const tone = winRate >= 0.6 ? 'success' : winRate >= 0.45 ? 'secondary' : 'error';

  const colors: Record<typeof tone, string> = {
    success: 'bg-success-700/20 text-success-400',
    secondary: 'bg-secondary-700/20 text-secondary-400',
    error: 'bg-error-700/20 text-error-400',
  };

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-2xs font-bold',
        colors[tone],
      )}
      title={`Винрейт за последние ${recent.length} сигнал${recent.length === 1 ? '' : 'ов'}`}
    >
      <Target size={12} />
      {(winRate * 100).toFixed(0)}%
      <span className="font-normal opacity-70">· {recent.length}</span>
    </span>
  );
}
