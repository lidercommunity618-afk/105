import { useState, lazy, Suspense } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';

// SettingsButton остаётся маленьким и грузится сразу (он всегда виден в
// шапке панели «Анализ»). Сама SettingsPanel (~29 КБ исходника, тянет за
// собой StrategiesModal/Education) грузится лениво только в момент клика —
// вынесена в отдельный файл специально для этого: пока SettingsButton и
// SettingsPanel лежали в одном src/ui/SettingsPanel.tsx, статический импорт
// SettingsButton из App.tsx утаскивал в главный бандл и SettingsPanel тоже.
const SettingsPanel = lazy(() =>
  import('@/ui/SettingsPanel').then((m) => ({ default: m.SettingsPanel })),
);

export function SettingsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center justify-center rounded-lg bg-base-800 p-2 text-base-300 transition hover:bg-base-700 hover:text-base-100"
        aria-label="Настройки"
      >
        <SettingsIcon size={18} />
      </button>
      {open && (
        <Suspense fallback={null}>
          <SettingsPanel onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
