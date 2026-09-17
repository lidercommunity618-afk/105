import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, TrendingUp, DollarSign } from 'lucide-react';
import { SYMBOLS, FOREX_SYMBOLS } from '@/data/symbols';
import { useSettingsStore } from '@/stores/settingsStore';
import { clsx } from '@/lib/utils';
import type { Symbol } from '@/types/domain';

export function SymbolSelector() {
  const [open, setOpen] = useState(false);
  const symbolId = useSettingsStore((s) => s.symbolId);
  const setSymbol = useSettingsStore((s) => s.setSymbol);
  const marketMode = useSettingsStore((s) => s.marketMode);
  const setMarketMode = useSettingsStore((s) => s.setMarketMode);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const allSymbols: readonly Symbol[] = marketMode === 'forex' ? FOREX_SYMBOLS : SYMBOLS;
  const selected = [...SYMBOLS, ...FOREX_SYMBOLS].find((s) => s.id === symbolId);

  return (
    <div ref={ref} className="relative min-w-0 flex-1 sm:flex-none">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-1.5 rounded-lg bg-base-800 px-3 py-1.5 text-sm font-semibold text-base-100 transition hover:bg-base-700 sm:w-auto"
      >
        <span className="truncate">{selected?.displaySymbol ?? symbolId}</span>
        <ChevronDown size={14} className="shrink-0 transition" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-xl border border-base-800 bg-base-900 py-1 shadow-2xl animate-fade-in">
          <div className="flex gap-1 px-2 pb-2 pt-1">
            <button
              onClick={() => setMarketMode('crypto')}
              className={clsx(
                'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold transition',
                marketMode === 'crypto' ? 'bg-primary-600 text-white' : 'bg-base-800 text-base-300 hover:text-base-100',
              )}
            >
              <TrendingUp size={12} />
              КРИПТО
            </button>
            <button
              onClick={() => setMarketMode('forex')}
              className={clsx(
                'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold transition',
                marketMode === 'forex' ? 'bg-secondary-600 text-white' : 'bg-base-800 text-base-300 hover:text-base-100',
              )}
            >
              <DollarSign size={12} />
              ФОРЕКС
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {allSymbols.map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  if (s.id !== symbolId) setSymbol(s.id);
                  setOpen(false);
                }}
                className={clsx(
                  'flex w-full items-center justify-between px-3 py-2 text-left text-sm transition hover:bg-base-800',
                  s.id === symbolId ? 'text-secondary-400' : 'text-base-200',
                )}
              >
                <div className="flex flex-col">
                  <span className="font-medium">{s.displaySymbol}</span>
                  <span className="text-2xs text-base-400">{s.displayName}</span>
                </div>
                {s.id === symbolId && <Check size={14} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
