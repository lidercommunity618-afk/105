import { useState, useEffect, lazy, Suspense } from 'react';
import { Activity, Signal, Settings as SettingsIcon, X } from 'lucide-react';
import { IndicatorPanel } from '@/ui/IndicatorPanel';
import { SignalFeed } from '@/ui/SignalFeed';
import { DirectionIndicator } from '@/ui/DirectionIndicator';
import { MarketStructureBadge } from '@/ui/MarketStructureBadge';
import { useAnalyticsStore } from '@/stores/useAnalyticsStore';
import { useTickStore } from '@/stores/useTickStore';
import { clsx } from '@/lib/utils';

const CalibrationPanel = lazy(() =>
  import('@/ui/CalibrationPanel').then((m) => ({ default: m.CalibrationPanel })),
);
const SettingsPanel = lazy(() =>
  import('@/ui/SettingsPanel').then((m) => ({ default: m.SettingsPanel })),
);

type DrawerTab = 'indicators' | 'signals' | 'settings';

interface MobileNavProps {
  fullSnapshot: ReturnType<typeof useTickStore.getState>['fullSnapshot'];
  currentSignal: ReturnType<typeof useAnalyticsStore.getState>['currentSignal'];
}

export function MobileNav({ fullSnapshot, currentSignal }: MobileNavProps) {
  const [activeTab, setActiveTab] = useState<DrawerTab | null>(null);
  const [touchStartY, setTouchStartY] = useState<number | null>(null);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    if (activeTab === null) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [activeTab]);

  const closeDrawer = () => {
    setIsClosing(true);
    setTimeout(() => {
      setActiveTab(null);
      setIsClosing(false);
    }, 250);
  };

  const openTab = (tab: DrawerTab) => {
    if (activeTab === tab) {
      closeDrawer();
      return;
    }
    setActiveTab(tab);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    setTouchStartY(e.touches[0].clientY);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartY === null) return;
    const diff = e.touches[0].clientY - touchStartY;
    if (diff > 60) {
      closeDrawer();
      setTouchStartY(null);
    }
  };

  const tabs: { id: DrawerTab; label: string; icon: typeof Activity }[] = [
    { id: 'indicators', label: 'Анализ', icon: Activity },
    { id: 'signals', label: 'Сигналы', icon: Signal },
    { id: 'settings', label: 'Настройки', icon: SettingsIcon },
  ];

  return (
    <>
      {activeTab !== null && (
        <div
          className={clsx(
            'fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden',
            isClosing ? 'animate-fade-out' : 'animate-fade-in',
          )}
          onClick={closeDrawer}
        />
      )}

      <div
        className={clsx(
          'fixed inset-x-0 bottom-0 z-40 transition-transform duration-300 ease-out lg:hidden',
          activeTab === null || isClosing ? 'translate-y-full' : 'translate-y-0',
        )}
        style={{ height: '72dvh' }}
      >
        <div className="flex h-full flex-col rounded-t-3xl border-t border-base-700/60 bg-base-950/98 shadow-2xl">
          {/* Grab handle + close button — swipe-down-to-close only works
              from here, not from the scrollable content below, so that
              scrolling up inside a tab doesn't collapse the drawer. */}
          <div
            className="relative flex items-center justify-center px-4 pb-1 pt-3"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
          >
            <div className="h-1 w-10 rounded-full bg-base-600" />
            <button
              onClick={closeDrawer}
              className="absolute right-4 rounded-full p-1.5 text-base-400 transition hover:bg-base-800 hover:text-base-100"
              aria-label="Закрыть"
            >
              <X size={16} />
            </button>
          </div>

          {/* Title bar with contextual content */}
          <div className="flex items-center justify-between border-b border-base-800/60 px-4 py-2.5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-base-300">
              {activeTab === 'indicators' && 'Анализ'}
              {activeTab === 'signals' && 'Сигналы'}
              {activeTab === 'settings' && 'Настройки'}
            </h3>
            <div className="flex items-center gap-2">
              {activeTab === 'indicators' && <DirectionIndicator signal={currentSignal} size={20} />}
              {activeTab === 'indicators' && fullSnapshot && (
                <MarketStructureBadge structure={fullSnapshot.structure} candleTime={fullSnapshot.candleTime} />
              )}
            </div>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto overscroll-contain p-4">
            {activeTab === 'indicators' && (
              <div className="flex flex-col gap-4">
                <IndicatorPanel />
                <Suspense fallback={<div className="h-24 w-full animate-pulse-soft rounded-lg bg-base-900" />}>
                  <CalibrationPanel />
                </Suspense>
              </div>
            )}
            {activeTab === 'signals' && <SignalFeed />}
            {activeTab === 'settings' && (
              <Suspense fallback={null}>
                <SettingsPanel onClose={closeDrawer} />
              </Suspense>
            )}
          </div>
        </div>
      </div>

      {/* Bottom tab bar */}
      <nav
        className="flex shrink-0 items-stretch justify-around border-t border-base-800 bg-base-950/95 px-1 py-1 backdrop-blur-sm lg:hidden"
        style={{ paddingBottom: 'max(0.25rem, env(safe-area-inset-bottom))' }}
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => openTab(tab.id)}
              className={clsx(
                'relative flex min-h-[48px] flex-1 flex-col items-center justify-center gap-0.5 rounded-xl transition-colors duration-200',
                isActive ? 'text-secondary-400' : 'text-base-500 active:text-base-300',
              )}
              aria-label={tab.label}
            >
              {isActive && (
                <span className="absolute -top-px left-1/2 h-0.5 w-8 -translate-x-1/2 rounded-full bg-secondary-500" />
              )}
              <Icon size={20} className={clsx('transition-transform duration-200', isActive && 'scale-110')} />
              <span className={clsx('text-2xs font-semibold transition-colors', isActive ? 'text-secondary-400' : 'text-base-500')}>
                {tab.label}
              </span>
            </button>
          );
        })}
      </nav>
    </>
  );
}
