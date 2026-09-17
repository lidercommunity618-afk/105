import { Brain, Loader2 } from 'lucide-react';
import { clsx } from '@/lib/utils';

// Вынесено из AiAnalysisOverlay.tsx: Header.tsx и LandscapeControls.tsx
// статически импортировали именно эту кнопку (она нужна сразу, всегда на
// экране), и из-за общего файла тянули в главный бандл заодно и тяжёлую
// разметку самой AiAnalysisOverlay, которая видна только после клика.
export function AiAnalysisButton({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={clsx(
        'flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-2xs font-semibold transition sm:py-1.5',
        loading
          ? 'bg-base-800 text-base-500'
          : 'bg-secondary-700/30 text-secondary-400 hover:bg-secondary-700/50',
      )}
    >
      {loading ? <Loader2 size={12} className="animate-spin" /> : <Brain size={12} />}
      ИИ
    </button>
  );
}
