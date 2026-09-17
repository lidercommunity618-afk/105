import { useEffect, useState, useCallback, useMemo, lazy, Suspense } from 'react';
import { Header } from '@/ui/Header';
import { ChartPanel } from '@/ui/ChartPanel';
import { IndicatorPanel } from '@/ui/IndicatorPanel';
import { SignalFeed } from '@/ui/SignalFeed';
import { StatusBar } from '@/ui/StatusBar';
import { HealthCheck } from '@/ui/HealthCheck';

import { DirectionIndicator } from '@/ui/DirectionIndicator';
import { MarketStructureBadge } from '@/ui/MarketStructureBadge';
import { PriorityAlertBanner } from '@/ui/PriorityAlertBanner';
import { UpdateBanner } from '@/ui/UpdateBanner';
import { MobileNav } from '@/ui/MobileNav';
import { LandscapeControls } from '@/ui/LandscapeControls';
import { useLandscape } from '@/hooks/useLandscape';
import { useWakeLock } from '@/hooks/useWakeLock';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTickStore } from '@/stores/useTickStore';
import { useAnalyticsStore } from '@/stores/useAnalyticsStore';
import { useDemoAccountStore } from '@/stores/useDemoAccountStore';
import { useAppUpdate } from '@/hooks/useAppUpdate';
import { useAiAnalysis } from '@/hooks/useAiAnalysis';
import { findSymbol } from '@/data/symbols';
import { unlockAudio } from '@/lib/audio';
import { initSentry } from '@/lib/sentry';

// Экраны, которые пользователь может вообще не открыть за сессию (настройки,
// ИИ-анализ, калибровка) или которые нужны только один раз до старта
// терминала (онбординг) — грузятся по требованию через React.lazy, как уже
// сделано для Education внутри SettingsPanel. ChartPanel сюда намеренно НЕ
// входит — это ядро главного экрана, ему место в основном бандле.
const SettingsButton = lazy(() =>
  import('@/ui/SettingsButton').then((m) => ({ default: m.SettingsButton })),
);
const AiAnalysisOverlay = lazy(() =>
  import('@/ui/AiAnalysisOverlay').then((m) => ({ default: m.AiAnalysisOverlay })),
);
const CalibrationPanel = lazy(() =>
  import('@/ui/CalibrationPanel').then((m) => ({ default: m.CalibrationPanel })),
);
const Onboarding = lazy(() =>
  import('@/ui/Onboarding').then((m) => ({ default: m.Onboarding })),
);

type Phase = 'health' | 'onboarding' | 'terminal';

// Лёгкие skeleton-фоллбэки в стиле уже существующего animate-pulse-soft
// (см. StatusBar.tsx) — без новой библиотеки анимаций.
function SettingsButtonSkeleton() {
  return <div className="h-[34px] w-[34px] animate-pulse-soft rounded-lg bg-base-800" />;
}

function CalibrationPanelSkeleton() {
  return <div className="h-24 w-full animate-pulse-soft rounded-lg bg-base-900" />;
}

function OnboardingSkeleton() {
  return (
    <div className="flex h-[100dvh] w-full items-center justify-center bg-base-950">
      <div className="h-8 w-40 animate-pulse-soft rounded-lg bg-base-800" />
    </div>
  );
}


export default function App() {
  const [phase, setPhase] = useState<Phase>('health');
  const onboardingCompleted = useSettingsStore((s) => s.onboardingCompleted);
  const symbolId = useSettingsStore((s) => s.symbolId);
  const timeframe = useSettingsStore((s) => s.timeframe);
  const marketMode = useSettingsStore((s) => s.marketMode);
  const start = useTickStore((s) => s.start);
  const stop = useTickStore((s) => s.stop);
  const candles = useTickStore((s) => s.candles);
  const indicatorSnapshot = useTickStore((s) => s.indicatorSnapshot);
  const indicatorSeries = useTickStore((s) => s.indicatorSeries);
  const fullSnapshot = useTickStore((s) => s.fullSnapshot);
  const currentSignal = useAnalyticsStore((s) => s.currentSignal);
  const allSignals = useAnalyticsStore((s) => s.signals);
  // Точки входа на графике (см. showEntryPoints в settingsStore и
  // ChartPanel.tsx) — только сигналы текущего символа+таймфрейма; вся
  // остальная история (других инструментов) не имеет смысла на этом
  // графике и не должна попадать в маркеры/попап по клику.
  const chartSignals = useMemo(
    () => allSignals.filter((s) => s.symbolId === symbolId && s.timeframe === timeframe),
    [allSignals, symbolId, timeframe],
  );
  const prioritySignal = useTickStore((s) => s.prioritySignal);
  const clearPrioritySignal = useTickStore((s) => s.clearPrioritySignal);

  const isLandscape = useLandscape();
  const [panelsVisible, setPanelsVisible] = useState(true);

  // Аудит («работа в спящем режиме»): удержать экран включённым, пока
  // терминал открыт и автоторговля на демо-счёте активна — см. подробное
  // объяснение ограничений в useWakeLock.ts.
  const keepScreenAwake = useSettingsStore((s) => s.keepScreenAwake);
  const autoTradeEnabled = useDemoAccountStore((s) => s.autoTradeEnabled);
  useWakeLock(phase === 'terminal' && keepScreenAwake && autoTradeEnabled);

  const { state: updateState, update: applyUpdate } = useAppUpdate();
  const [updateDismissed, setUpdateDismissed] = useState(false);

  const ai = useAiAnalysis(symbolId, timeframe, candles);

  // ДЕАКТИВИРОВАНО (2026-09-06, по прямому запросу): автоудаление истории
  // сигналов раз в сутки убрано из активного пути — см. подробности в
  // useAnalyticsStore.ts::maybeRunAutoCleanup (оставлен как no-op) и
  // useAutoCleanupSignals.ts (хук больше нигде не вызывается, файл оставлен
  // для истории/возможного будущего использования, но dead code). Удаление
  // истории теперь только вручную, кнопкой в SignalFeed.tsx.

  useEffect(() => {
    initSentry();
    unlockAudio();
    const onBeforeUnload = () => stop();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [stop]);

  useEffect(() => {
    if (phase !== 'terminal') return;
    void start(symbolId, timeframe);
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolId, timeframe, phase, marketMode, start]);

  const dismissPriority = useCallback(() => clearPrioritySignal(), [clearPrioritySignal]);

  if (phase === 'health') {
    return <HealthCheck onReady={() => setPhase(onboardingCompleted ? 'terminal' : 'onboarding')} />;
  }

  if (phase === 'onboarding') {
    return (
      <Suspense fallback={<OnboardingSkeleton />}>
        <Onboarding onComplete={() => setPhase('terminal')} />
      </Suspense>
    );
  }

  const symbol = findSymbol(symbolId);

  // Landscape fullscreen chart mode on mobile
  if (isLandscape) {
    return (
      <div className="flex h-[100dvh] flex-col overflow-hidden bg-base-950 text-base-100">
        <div className="relative min-h-0 flex-1">
          <ChartPanel candles={candles} snapshot={indicatorSnapshot} series={indicatorSeries} signals={chartSignals} />
          <LandscapeControls
            panelsVisible={panelsVisible}
            onTogglePanels={() => setPanelsVisible((v) => !v)}
            onAiAnalyze={() => void ai.analyze()}
            aiLoading={ai.state.loading}
          />
          <Suspense fallback={null}>
            <AiAnalysisOverlay
              loading={ai.state.loading}
              result={ai.state.result}
              error={ai.state.error}
              onAnalyze={() => void ai.analyze()}
              onClear={ai.clear}
            />
          </Suspense>
        </div>

        {prioritySignal && symbol && (
          <PriorityAlertBanner signal={prioritySignal} pipSize={symbol.pipSize} onDismiss={dismissPriority} />
        )}

        {updateState === 'available' && !updateDismissed && (
          <UpdateBanner
            updating={false}
            onUpdate={applyUpdate}
            onDismiss={() => setUpdateDismissed(true)}
          />
        )}

        {updateState === 'updating' && (
          <UpdateBanner updating={true} onUpdate={applyUpdate} onDismiss={() => {}} />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-base-950 text-base-100">
      <Header onAiAnalyze={() => void ai.analyze()} aiLoading={ai.state.loading} />
      <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
        <main className="flex min-h-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <ChartPanel candles={candles} snapshot={indicatorSnapshot} series={indicatorSeries} signals={chartSignals} />
            <Suspense fallback={null}>
              <AiAnalysisOverlay
                loading={ai.state.loading}
                result={ai.state.result}
                error={ai.state.error}
                onAnalyze={() => void ai.analyze()}
                onClear={ai.clear}
              />
            </Suspense>
          </div>
          <StatusBar />
        </main>

        <aside className="hidden shrink-0 flex-col gap-4 overflow-y-auto border-t border-base-800 bg-base-950 p-4 pb-16 lg:flex lg:w-80 lg:border-l lg:border-t-0">
          <div className="flex items-center justify-between">
            <h2 className="text-2xs font-bold uppercase tracking-wider text-base-400">Анализ</h2>
            <Suspense fallback={<SettingsButtonSkeleton />}>
              <SettingsButton />
            </Suspense>
          </div>
          <div className="flex items-center justify-between gap-2">
            <DirectionIndicator signal={currentSignal} size={24} />
            {fullSnapshot && (
              <MarketStructureBadge structure={fullSnapshot.structure} candleTime={fullSnapshot.candleTime} />
            )}
          </div>
          <IndicatorPanel />
          <SignalFeed />
          <Suspense fallback={<CalibrationPanelSkeleton />}>
            <CalibrationPanel />
          </Suspense>
        </aside>
      </div>

      <MobileNav fullSnapshot={fullSnapshot} currentSignal={currentSignal} />

      {prioritySignal && symbol && (
        <PriorityAlertBanner signal={prioritySignal} pipSize={symbol.pipSize} onDismiss={dismissPriority} />
      )}

      {updateState === 'available' && !updateDismissed && (
        <UpdateBanner
          updating={false}
          onUpdate={applyUpdate}
          onDismiss={() => setUpdateDismissed(true)}
        />
      )}

      {updateState === 'updating' && (
        <UpdateBanner updating={true} onUpdate={applyUpdate} onDismiss={() => {}} />
      )}
    </div>
  );
}
