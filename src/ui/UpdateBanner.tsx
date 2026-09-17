import { RefreshCw, X, Loader2 } from 'lucide-react';

interface UpdateBannerProps {
  updating: boolean;
  onUpdate: () => void;
  onDismiss: () => void;
}

export function UpdateBanner({ updating, onUpdate, onDismiss }: UpdateBannerProps) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 animate-slide-up border-t border-secondary-800 bg-base-900/95 px-4 py-2.5 backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          {updating ? (
            <Loader2 size={16} className="animate-spin text-secondary-400" />
          ) : (
            <RefreshCw size={16} className="text-secondary-400" />
          )}
          <span className="text-xs font-semibold text-base-100">
            {updating ? 'Обновление…' : 'Доступна новая версия'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {updating ? null : (
            <button
              onClick={onDismiss}
              className="rounded-lg p-1 text-base-400 transition hover:bg-base-800 hover:text-base-100"
              aria-label="Закрыть"
            >
              <X size={16} />
            </button>
          )}
          <button
            onClick={onUpdate}
            disabled={updating}
            className="rounded-lg bg-secondary-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-secondary-500 disabled:opacity-50"
          >
            {updating ? 'Перезагрузка…' : 'Обновить'}
          </button>
        </div>
      </div>
    </div>
  );
}
