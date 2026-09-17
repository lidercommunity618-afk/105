import { useState, useMemo, useEffect } from 'react';
import { FlaskConical, Loader2, CheckCircle2, AlertCircle, Database, TrendingUp, Table2, ListTree, SlidersHorizontal, RotateCcw, Gauge } from 'lucide-react';
import { workerClient } from '@/compute/WorkerClient';
import { useTickStore } from '@/stores/useTickStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAnalyticsStore } from '@/stores/useAnalyticsStore';
import { useDemoAccountStore } from '@/stores/useDemoAccountStore';
import { findSymbol } from '@/data/symbols';
import { MIN_SAMPLES } from '@/decision/calibration-model';
import { clsx } from '@/lib/utils';
import { computeBuckets } from '@/ui/calibration-buckets';
import { computeFactorStats, MIN_FACTOR_SAMPLES } from '@/ui/factor-analytics';
import {
  computeReliabilitySuggestions,
  toMultiplierUpdates,
  breakevenWinRateFromProfitPercent,
  type ReliabilitySuggestion,
} from '@/lib/pattern-reliability-calibration';
import {
  effectiveReliabilityOverridesForSymbol,
  applyReliabilityMultiplierUpdatesForSymbol,
  resetReliabilityOverridesForSymbol,
} from '@/lib/pattern-categories';
import {
  computeThresholdCandidates,
  WINRATE_TOLERANCE,
  type ThresholdRecommendation,
} from '@/lib/threshold-calibration';
import {
  effectivePriorityThresholdForSymbol,
  hasPriorityThresholdOverride,
} from '@/lib/priority-threshold-overrides';
import type { SignalFactorKind } from '@/types/domain';

// BUGFIX (аудит, п.2.4): typed as Record<string, string> before, so TS never
// flagged the missing 'bos' entry after 'bos' was added to SignalFactorKind
// (см. types/domain.ts) — the factor table silently fell back to the raw
// 'bos' string instead of a Russian label. Typed against SignalFactorKind
// now so a future addition to the union fails to compile here too.
const FACTOR_KIND_LABELS_RU: Record<SignalFactorKind, string> = {
  indicator: 'Индикатор',
  pattern: 'Паттерн',
  strategy: 'Стратегия',
  structure: 'Структура',
  filter: 'Фильтр',
  bos: 'Слом структуры (BOS)',
};

export function CalibrationPanel() {
  const candles = useTickStore((s) => s.candles);
  const symbolId = useSettingsStore((s) => s.symbolId);
  const timeframe = useSettingsStore((s) => s.timeframe);
  const indicators = useSettingsStore((s) => s.indicators);
  const setCalibrationResult = useAnalyticsStore((s) => s.setCalibrationResult);
  const result = useAnalyticsStore((s) => s.calibrationResult);
  // BUGFIX (аудит 2026-09-13, "калибровка мерит безубыток неправильной
  // константой"): реальная точка безубыточности зависит от фактической
  // выплаты демо-счёта (profitPercent), а не от захардкоженных 50% —
  // см. комментарий у breakevenWinRateFromProfitPercent(). Читаем
  // profitPercent из useDemoAccountStore (единственный источник истины
  // для payout, тот же, что использует resolveTrade() при закрытии сделок)
  // и передаём производный от него безубыток в computeReliabilitySuggestions,
  // а не полагаемся на его дефолт.
  const profitPercent = useDemoAccountStore((s) => s.profitPercent);
  const breakevenWinRate = useMemo(
    () => breakevenWinRateFromProfitPercent(profitPercent),
    [profitPercent],
  );
  // Этап 1 аудита ("КАЛИБРОВКА"/"АНАЛИТИКА ПО ФАКТОРАМ" не связаны, п.3):
  // раньше здесь читались calibrationReady/calibrationSampleCount —
  // историческое поле, которое перезаписывалось ТРЕМЯ независимыми
  // источниками (ATR-бэктест / реальный ML-семпл-каунт / просто счётчик
  // резолвнутых сигналов) с разными порогами готовности, из-за чего
  // индикатор "Сбор данных (X из 100)" в большинстве случаев показывал не
  // то число и не ту логику готовности, что реально использует
  // CalibrationModel.isReady(). mlReady/mlSampleCount — честные,
  // однозначные поля именно для ML-калибровки (порог = MIN_SAMPLES).
  const mlReady = useAnalyticsStore((s) => s.mlReady);
  const mlSampleCount = useAnalyticsStore((s) => s.mlSampleCount);
  const winRate = useAnalyticsStore((s) => s.winRate);
  const allSignals = useAnalyticsStore((s) => s.signals);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const symbol = findSymbol(symbolId);

  // Этап 1 аудита, п.1–2: "НАДЁЖНОСТЬ ПО УВЕРЕННОСТИ" и "АНАЛИТИКА ПО
  // ФАКТОРАМ" раньше считались по ВСЕМ сигналам сразу, независимо от
  // инструмента — статистика доджи/inside-bar по BTCUSDT мешалась со
  // статистикой по EURUSD, если пользователь торговал обоими. Фильтруем
  // здесь, перед передачей в computeBuckets/computeFactorStats — сами
  // функции не меняются (и их существующие тесты, вызывающие их напрямую
  // без фильтра, продолжают работать как раньше).
  const signals = useMemo(
    () => allSignals.filter((s) => s.symbolId === symbolId),
    [allSignals, symbolId],
  );

  // АУДИТ ЭТАПА 4 (2026-09-09): useAnalyticsStore.winRate ("Винрейт (лайв)"
  // выше) — GLOBAL агрегат по ВСЕМ сигналам сразу, во всех инструментах
  // (recomputeStats() читает `signals` без фильтра по symbolId — та же
  // конструкция, которую уже один раз чинили для computeBuckets/
  // computeFactorStats в Этапе 1 аудита, см. комментарий выше про
  // "статистика доджи/inside-bar по BTCUSDT мешалась со статистикой по
  // EURUSD", но пропустили именно для winRate). Использовать его как
  // baselineWinRate для computeThresholdCandidates(signals, ...) — где
  // signals уже отфильтрованы по этому символу — значило бы сравнивать
  // "какой винрейт даст этот порог НА ЭТОМ инструменте" с блендом винрейта
  // по ВСЕМ инструментам, которыми когда-либо торговал пользователь: тот же
  // класс утечки между символами, ради защиты от которого и вводился весь
  // per-symbol override-слой в этом файле. Вычисляем живой винрейт заново,
  // но уже из symbolId-отфильтрованных `signals` — той же формулой, что
  // recomputeStats() (tradeOpened !== false, только резолвнутые win/loss).
  // Глобальное поле winRate/лейбл "Винрейт (лайв)" выше не трогаем — это
  // отдельный, более широкий пре-существующий баг (затрагивает и
  // StatusBar.tsx), не входящий в границы Этапа 4.
  const symbolWinRate = useMemo(() => {
    const traded = signals.filter((s) => s.tradeOpened !== false);
    const decided = traded.filter((s) => s.outcome === 'win' || s.outcome === 'loss');
    if (decided.length === 0) return null;
    const wins = decided.filter((s) => s.outcome === 'win').length;
    return wins / decided.length;
  }, [signals]);

  const buckets = useMemo(() => computeBuckets(signals), [signals]);
  const hasBucketData = buckets.some((b) => b.total > 0);
  const factorStats = useMemo(() => computeFactorStats(signals), [signals]);

  // Этап 2 плана калибровки: предпросмотр "было/станет" для автоматического
  // пересчёта PATTERN_RELIABILITY_MULTIPLIER по АНАЛИТИКА ПО ФАКТОРАМ —
  // null, пока пользователь не нажал "Калибровать"; вычисляется явным
  // действием, не в фоне на каждый тик (см. pattern-reliability-calibration.ts).
  const [reliabilityPreview, setReliabilityPreview] = useState<ReliabilitySuggestion[] | null>(null);
  const [reliabilityApplied, setReliabilityApplied] = useState(false);

  // BUGFIX (независимый аудит, 2026-09-08): reliabilityPreview раньше
  // переживал смену symbolId — предпросмотр "было/станет", посчитанный по
  // factorStats ИНСТРУМЕНТА А (см. previewReliabilityCalibration ниже),
  // оставался открытым, если пользователь переключался на инструмент Б, не
  // нажав "Отмена". Кнопка "Применить" в этот момент вызывает
  // applyReliabilityMultiplierUpdatesForSymbol(symbolId, ...) с ТЕКУЩИМ
  // (уже новым) symbolId — то есть множители, посчитанные по статистике
  // инструмента А, физически записывались бы как override инструмента Б,
  // подтверждая пояснительный текст под таблицей ("применяется только к
  // {symbol.displayName}"), который к этому моменту уже показывает новое
  // название инструмента, но неверно, для другого набора данных. Это
  // ровно тот же класс бага, для защиты от которого и был введён
  // per-symbol API в Этапе 2 — сброс предпросмотра при смене инструмента
  // закрывает последнюю дыру в этой изоляции.
  useEffect(() => {
    setReliabilityPreview(null);
    setReliabilityApplied(false);
  }, [symbolId]);

  const previewReliabilityCalibration = () => {
    setReliabilityApplied(false);
    // FIX (аудит калибровки Этапа 2, п.4): "before" в предпросмотре теперь
    // берётся из effectiveReliabilityOverridesForSymbol(symbolId) — общий
    // дефолт, перекрытый per-symbol override для ТЕКУЩЕГО инструмента, если
    // он уже был откалиброван ранее. Раньше здесь читался только глобальный
    // PATTERN_RELIABILITY_MULTIPLIER (дефолтный аргумент функции), поэтому
    // "было" могло не совпадать с тем, что реально применяется к этому
    // символу, если для него уже применялась калибровка.
    setReliabilityPreview(
      computeReliabilitySuggestions(
        factorStats,
        effectiveReliabilityOverridesForSymbol(symbolId),
        breakevenWinRate,
      ),
    );
  };

  const applyReliabilityCalibration = () => {
    if (!reliabilityPreview) return;
    // FIX (аудит калибровки Этапа 2, п.4 — "калибровка на BTCUSDT влияет и
    // на EURUSD"): применяем множители ТОЛЬКО к текущему symbolId — другие
    // инструменты продолжают использовать свой собственный override (или
    // общий дефолт, если для них калибровка ещё не запускалась).
    applyReliabilityMultiplierUpdatesForSymbol(symbolId, toMultiplierUpdates(reliabilityPreview));
    setReliabilityPreview(null);
    setReliabilityApplied(true);
  };

  const cancelReliabilityPreview = () => setReliabilityPreview(null);

  const handleResetReliability = () => {
    // Сбрасывает override только для текущего инструмента (возврат к общему
    // дефолту) — калибровка других инструментов не затрагивается.
    resetReliabilityOverridesForSymbol(symbolId);
    setReliabilityPreview(null);
    setReliabilityApplied(false);
  };

  // Этап 4 плана калибровки: симметричный контур самообучения, но для
  // ПОРОГА ВХОДА (priorityThreshold) — единственного рычага частоты
  // сигналов, не переоткрывающего уже исправленные баги ложных сигналов
  // (ADX hard veto, cooldown, chop-guard остаются нетронутыми). Тот же
  // preview → explicit apply → per-symbol паттерн, что у "КАЛИБРОВКА
  // НАДЁЖНОСТИ ПАТТЕРНОВ" выше.
  const priorityThreshold = useSettingsStore((s) => s.priorityThreshold);
  const applyPriorityThresholdForSymbol = useTickStore((s) => s.applyPriorityThresholdForSymbol);
  const resetPriorityThresholdForSymbolAction = useTickStore((s) => s.resetPriorityThresholdForSymbol);
  const [thresholdPreview, setThresholdPreview] = useState<ThresholdRecommendation | null>(null);
  const [thresholdApplied, setThresholdApplied] = useState(false);

  // Тот же класс бага, что и находка №2 сегодняшнего аудита
  // (reliabilityPreview не сбрасывался при смене символа): без этого
  // сброса "Применить" мог бы записать порог, посчитанный по истории
  // ИНСТРУМЕНТА А, как override уже нового ИНСТРУМЕНТА Б.
  useEffect(() => {
    setThresholdPreview(null);
    setThresholdApplied(false);
  }, [symbolId]);

  const effectiveThreshold = effectivePriorityThresholdForSymbol(symbolId, priorityThreshold);

  const previewThresholdCalibration = () => {
    setThresholdApplied(false);
    setThresholdPreview(computeThresholdCandidates(signals, effectiveThreshold, symbolWinRate));
  };

  const applyThresholdCalibration = () => {
    if (!thresholdPreview || thresholdPreview.recommendedThreshold === null) return;
    applyPriorityThresholdForSymbol(symbolId, thresholdPreview.recommendedThreshold);
    setThresholdPreview(null);
    setThresholdApplied(true);
  };

  const cancelThresholdPreview = () => setThresholdPreview(null);

  const handleResetThreshold = () => {
    resetPriorityThresholdForSymbolAction(symbolId);
    setThresholdPreview(null);
    setThresholdApplied(false);
  };

  const run = async () => {
    if (candles.length < 50 || !symbol) return;
    setError(null);
    setRunning(true);
    try {
      // BUGFIX (Фаза 1/2/4, "честный бинарный опцион"): раньше найденный
      // atrMultiplier тут же молча применялся глобально (setAtrMultiplier)
      // — он был реальным движковым параметром (размер SL/TP). expiryBars
      // — не такой параметр: он уже считается адаптивно, per-сигнал, от
      // волатильности (см. decision/recommended-expiry.ts) — глобальный
      // фиксированный оверрайд конфликтовал бы с этой логикой. Поэтому
      // result ниже — только диагностика ("на этой истории лучше всего
      // показал себя такой-то expiryBars"), без автоприменения.
      const res = await workerClient.calibrate(symbolId, timeframe, candles, indicators);
      setCalibrationResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Calibration failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded-xl border border-base-800 bg-base-900 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-2xs font-semibold text-base-400">
          <FlaskConical size={12} className="text-secondary-400" />
          КАЛИБРОВКА
        </div>
        <button
          onClick={() => void run()}
          disabled={running || candles.length < 50}
          className="flex items-center gap-1 rounded-md bg-secondary-700/30 px-2 py-1 text-2xs font-semibold text-secondary-400 transition hover:bg-secondary-700/50 disabled:opacity-40"
        >
          {running ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
          {running ? 'Выполняется' : 'Калибровать'}
        </button>
      </div>

      {error && (
        <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-error-700/20 px-2.5 py-1.5 text-2xs text-error-400">
          <AlertCircle size={12} />
          {error}
        </div>
      )}

      <div className="mt-2.5 flex flex-col gap-2">
        <div className="flex items-center gap-1.5 rounded-lg bg-base-950/50 px-2.5 py-1.5">
          <Database size={11} className={clsx(mlReady ? 'text-success-500' : 'text-base-500')} />
          <span className="text-2xs text-base-400">
            {mlReady ? 'Калибровка активна' : `Сбор данных (${mlSampleCount} из ${MIN_SAMPLES})`}
          </span>
          <span className="ml-auto font-mono text-2xs font-semibold text-base-100">{mlSampleCount}</span>
          <span className={clsx('text-2xs font-bold uppercase', mlReady ? 'text-success-500' : 'text-base-500')}>
            {mlReady ? 'Готово' : 'Ожидание'}
          </span>
        </div>

        {winRate !== null && (
          <div className="flex items-center gap-1.5 rounded-lg bg-base-950/50 px-2.5 py-1.5">
            <TrendingUp size={11} className="text-secondary-400" />
            <span className="text-2xs text-base-400">Винрейт (лайв)</span>
            <span className="ml-auto font-mono text-2xs font-semibold text-secondary-400">
              {(winRate * 100).toFixed(0)}%
            </span>
          </div>
        )}
      </div>

      <div className="mt-2.5">
        <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold text-base-400">
          <Table2 size={12} className="text-secondary-400" />
          НАДЁЖНОСТЬ ПО УВЕРЕННОСТИ
        </div>
        {hasBucketData ? (
          <div className="overflow-hidden rounded-lg border border-base-800">
            <table className="w-full text-2xs">
              <thead className="bg-base-950/60 text-base-500">
                <tr>
                  <th className="px-2 py-1 text-left font-semibold">Диап.</th>
                  <th className="px-2 py-1 text-right font-semibold">N</th>
                  <th className="px-2 py-1 text-right font-semibold">Реал. WR</th>
                </tr>
              </thead>
              <tbody>
                {buckets.map((b) => (
                  <tr key={b.label} className="border-t border-base-800/60">
                    <td className="px-2 py-1 text-base-300">{b.label}</td>
                    <td className="px-2 py-1 text-right font-mono text-base-300">{b.total}</td>
                    <td className="px-2 py-1 text-right font-mono font-semibold">
                      {b.winRate === null ? (
                        <span className="text-base-600">—</span>
                      ) : (
                        <span className={bucketColor(b.winRate)}>{(b.winRate * 100).toFixed(0)}%</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-2xs text-base-500">
            Пока нет закрытых сигналов. Таблица заполняется по мере закрытия сигналов.
          </p>
        )}
      </div>

      <div className="mt-2.5">
        <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold text-base-400">
          <ListTree size={12} className="text-secondary-400" />
          АНАЛИТИКА ПО ФАКТОРАМ
        </div>
        {factorStats.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-base-800">
            <table className="w-full text-2xs">
              <thead className="bg-base-950/60 text-base-500">
                <tr>
                  <th className="px-2 py-1 text-left font-semibold">Фактор</th>
                  <th className="px-2 py-1 text-right font-semibold">N</th>
                  <th className="px-2 py-1 text-right font-semibold">Винрейт</th>
                </tr>
              </thead>
              <tbody>
                {factorStats.map((f) => {
                  const reliable = f.decidedCount >= MIN_FACTOR_SAMPLES;
                  return (
                    <tr key={f.name} className="border-t border-base-800/60">
                      <td className="px-2 py-1 text-base-300">
                        <span className="block truncate" title={f.name}>{f.name}</span>
                        <span className="text-base-600">{FACTOR_KIND_LABELS_RU[f.kind] ?? f.kind}</span>
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-base-300">{f.sampleCount}</td>
                      <td className="px-2 py-1 text-right font-mono font-semibold">
                        {f.winRate === null ? (
                          <span className="text-base-600">—</span>
                        ) : reliable ? (
                          <span className={bucketColor(f.winRate)}>{(f.winRate * 100).toFixed(0)}%</span>
                        ) : (
                          <span className="text-base-600" title={`Мало данных: ${f.decidedCount} из ${MIN_FACTOR_SAMPLES}`}>
                            {(f.winRate * 100).toFixed(0)}%*
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="border-t border-base-800/60 px-2 py-1 text-3xs text-base-600">
              * &lt; {MIN_FACTOR_SAMPLES} резолвнутых сделок — винрейт ненадёжен
            </p>
          </div>
        ) : (
          <p className="text-2xs text-base-500">
            Пока нет резолвнутых сигналов со структурированной атрибуцией (factors). Таблица заполняется по мере закрытия сделок.
          </p>
        )}
      </div>

      <div className="mt-2.5">
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-2xs font-semibold text-base-400">
            <SlidersHorizontal size={12} className="text-secondary-400" />
            КАЛИБРОВКА НАДЁЖНОСТИ ПАТТЕРНОВ
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={previewReliabilityCalibration}
              className="flex items-center gap-1 rounded-md bg-secondary-700/30 px-2 py-1 text-2xs font-semibold text-secondary-400 transition hover:bg-secondary-700/50"
            >
              Калибровать
            </button>
            <button
              onClick={handleResetReliability}
              title="Сбросить к ручным значениям"
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-base-500 transition hover:bg-base-800 hover:text-base-300"
            >
              <RotateCcw size={11} />
            </button>
          </div>
        </div>
        <p className="mb-1.5 text-3xs text-base-600">
          Пересчитывает множитель надёжности для паттернов с ≥{MIN_FACTOR_SAMPLES}
          резолвнутыми сделками по формуле winRate / безубыток, ограниченной
          [0.1; 1.5] — вместо ручной правки чисел. Безубыток считается от
          текущей выплаты счёта ({profitPercent}%): {(breakevenWinRate * 100).toFixed(2)}%,
          а не от условных 50% — при выплате меньше 100% даже "монетка" 50/50
          в среднем убыточна. Считается по данным и применяется только к{' '}
          {symbol?.displayName ?? symbolId} — другие инструменты используют
          свой собственный override или общий дефолт, если для них
          калибровка ещё не запускалась.
        </p>

        {reliabilityApplied && (
          <div className="mb-1.5 flex items-center gap-1.5 rounded-lg bg-success-700/20 px-2.5 py-1.5 text-2xs text-success-400">
            <CheckCircle2 size={12} />
            Применено. Новые множители сохранены и вступили в силу.
          </div>
        )}

        {reliabilityPreview && (
          reliabilityPreview.length > 0 ? (
            <>
              <div className="overflow-hidden rounded-lg border border-base-800">
                <table className="w-full text-2xs">
                  <thead className="bg-base-950/60 text-base-500">
                    <tr>
                      <th className="px-2 py-1 text-left font-semibold">Паттерн</th>
                      <th className="px-2 py-1 text-right font-semibold">N</th>
                      <th className="px-2 py-1 text-right font-semibold">WR</th>
                      <th className="px-2 py-1 text-right font-semibold">Было</th>
                      <th className="px-2 py-1 text-right font-semibold">Станет</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reliabilityPreview.map((s) => (
                      <tr key={s.name} className="border-t border-base-800/60">
                        <td className="px-2 py-1 text-base-300">{s.label}</td>
                        <td className="px-2 py-1 text-right font-mono text-base-300">{s.decidedCount}</td>
                        <td className="px-2 py-1 text-right font-mono text-base-300">{(s.winRate * 100).toFixed(0)}%</td>
                        <td className="px-2 py-1 text-right font-mono text-base-500">{s.before.toFixed(2)}</td>
                        <td
                          className={clsx(
                            'px-2 py-1 text-right font-mono font-semibold',
                            s.changed ? 'text-secondary-400' : 'text-base-500',
                          )}
                        >
                          {s.after.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  onClick={applyReliabilityCalibration}
                  className="flex items-center gap-1 rounded-md bg-success-700/30 px-2 py-1 text-2xs font-semibold text-success-400 transition hover:bg-success-700/50"
                >
                  <CheckCircle2 size={11} />
                  Применить
                </button>
                <button
                  onClick={cancelReliabilityPreview}
                  className="rounded-md px-2 py-1 text-2xs font-semibold text-base-500 transition hover:bg-base-800"
                >
                  Отмена
                </button>
              </div>
            </>
          ) : (
            <p className="text-2xs text-base-500">
              Нет паттернов с ≥{MIN_FACTOR_SAMPLES} резолвнутыми сделками для пересчёта — соберите больше данных.
            </p>
          )
        )}
      </div>

      <div className="mt-2.5">
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-2xs font-semibold text-base-400">
            <Gauge size={12} className="text-secondary-400" />
            ПОРОГ ВХОДА (ЧАСТОТА)
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={previewThresholdCalibration}
              className="flex items-center gap-1 rounded-md bg-secondary-700/30 px-2 py-1 text-2xs font-semibold text-secondary-400 transition hover:bg-secondary-700/50"
            >
              Подобрать порог
            </button>
            <button
              onClick={handleResetThreshold}
              title="Сбросить к общему порогу"
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-base-500 transition hover:bg-base-800 hover:text-base-300"
            >
              <RotateCcw size={11} />
            </button>
          </div>
        </div>
        <p className="mb-1.5 text-3xs text-base-600">
          Считается по резолвнутым сигналам с calibrationSource=model на{' '}
          {symbol?.displayName ?? symbolId}; допуск на снижение винрейта: {(WINRATE_TOLERANCE * 100).toFixed(0)}%.
          Применяется только к этому инструменту.
        </p>

        {!hasPriorityThresholdOverride(symbolId) && (
          <p className="mb-1.5 text-3xs text-base-600">
            Порог: {(priorityThreshold * 100).toFixed(0)}% (общий, не откалиброван для этого инструмента)
          </p>
        )}

        {thresholdApplied && (
          <div className="mb-1.5 flex items-center gap-1.5 rounded-lg bg-success-700/20 px-2.5 py-1.5 text-2xs text-success-400">
            <CheckCircle2 size={12} />
            Применено. Новый порог сохранён и вступил в силу.
          </div>
        )}

        {thresholdPreview && (
          thresholdPreview.recommendedThreshold !== null ? (
            <>
              <div className="overflow-hidden rounded-lg border border-base-800">
                <table className="w-full text-2xs">
                  <thead className="bg-base-950/60 text-base-500">
                    <tr>
                      <th className="px-2 py-1 text-left font-semibold">Порог</th>
                      <th className="px-2 py-1 text-right font-semibold">Частота</th>
                      <th className="px-2 py-1 text-right font-semibold">N</th>
                      <th className="px-2 py-1 text-right font-semibold">Винрейт</th>
                    </tr>
                  </thead>
                  <tbody>
                    {thresholdPreview.candidates.map((c) => {
                      const isCurrent = c.threshold === thresholdPreview.currentThreshold;
                      const isRecommended = c.threshold === thresholdPreview.recommendedThreshold;
                      const qualifies = c.meetsFrequencyTarget && c.meetsAccuracyFloor;
                      return (
                        <tr
                          key={c.threshold}
                          className={clsx(
                            'border-t border-base-800/60',
                            isRecommended && 'bg-success-700/10',
                          )}
                        >
                          <td className="px-2 py-1 text-base-300">
                            {c.threshold.toFixed(2)}
                            {isCurrent && <span className="ml-1 text-base-600">(текущий)</span>}
                            {isRecommended && <span className="ml-1 text-success-400">(рекомендуется)</span>}
                          </td>
                          <td
                            className={clsx(
                              'px-2 py-1 text-right font-mono',
                              qualifies ? 'text-base-300' : 'text-base-600',
                            )}
                          >
                            {c.signalsPer5Min === null ? '—' : `${c.signalsPer5Min.toFixed(2)}/5м`}
                          </td>
                          <td
                            className={clsx(
                              'px-2 py-1 text-right font-mono',
                              qualifies ? 'text-base-300' : 'text-base-600',
                            )}
                          >
                            {c.decidedCount}
                          </td>
                          <td className="px-2 py-1 text-right font-mono font-semibold">
                            {c.winRate === null ? (
                              <span className="text-base-600">—</span>
                            ) : (
                              <span className={qualifies ? bucketColor(c.winRate) : 'text-base-600'}>
                                {(c.winRate * 100).toFixed(0)}%
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  onClick={applyThresholdCalibration}
                  className="flex items-center gap-1 rounded-md bg-success-700/30 px-2 py-1 text-2xs font-semibold text-success-400 transition hover:bg-success-700/50"
                >
                  <CheckCircle2 size={11} />
                  Применить
                </button>
                <button
                  onClick={cancelThresholdPreview}
                  className="rounded-md px-2 py-1 text-2xs font-semibold text-base-500 transition hover:bg-base-800"
                >
                  Отмена
                </button>
              </div>
            </>
          ) : (
            <p className="text-2xs text-base-500">{thresholdPreview.reason}</p>
          )
        )}
      </div>

      {result && !error && (
        <div className="mt-2.5">
          {/* Этап 1 аудита, п.1: раньше "Сделки" здесь и "Сбор данных
              (X из 100)" выше делили одно и то же поле calibrationSampleCount
              (setCalibrationResult перезаписывал то, что записал
              setCalibrationState, и наоборот) — визуально выглядело как
              единая "КАЛИБРОВКА", хотя это отдельный бэктест-грид по
              expiryBars, полностью отдельная фича от ML-калибровки
              логрегрессии выше. Явная подпись — чтобы это больше не
              читалось как одна и та же готовность.
              BUGFIX (Фаза 1/2/4, "честный бинарный опцион"): раньше это
              был ATR-бэктест — подбор множителя стопа/цели по winRate.
              Бинарный опцион с фиксированной экспирацией/выплатой не
              имеет структурного стопа/цели (см. decision/signal-builder.ts) —
              теперь это грид по expiryBars (сколько баров держать позицию
              до экспирации), метрика — доля верных знаков движения
              (accuracy), не winRate. Результат ниже — диагностика, не
              применяется автоматически (см. run() выше). */}
          <div className="mb-1.5 text-3xs font-semibold uppercase text-base-600">
            Калибровка экспирации (отдельно от ML-калибровки выше)
          </div>
          <div className="grid grid-cols-2 gap-2 text-2xs">
            <Stat label="Лучшая экспир., баров" value={String(result.bestExpiryBars)} />
            <Stat label="Accuracy направления" value={`${(result.directionAccuracy * 100).toFixed(0)}%`} />
            <Stat label="Сделки" value={String(result.totalTrades)} />
            <Stat label="Таймфрейм" value={result.timeframe} />
          </div>
          <p className="mt-1.5 text-3xs text-base-600">
            Accuracy — доля свечей, где цена закрытия на {result.bestExpiryBars}-м баре была по
            направлению сигнала, на исторических данных выше. Не гарантия на будущее и не
            применяется автоматически к движку — только диагностика.
          </p>
        </div>
      )}
      {!result && !running && !error && (
        <p className="mt-2 text-2xs text-base-500">
          Тестирует конфигурацию индикаторов на истории для поиска лучшего множителя ATR для стопов и целей (отдельно от ML-калибровки выше).
        </p>
      )}
    </div>
  );
}

function bucketColor(winRate: number): string {
  if (winRate >= 0.6) return 'text-success-400';
  if (winRate >= 0.45) return 'text-secondary-400';
  return 'text-error-400';
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-base-950/50 px-2 py-1.5">
      <div className="text-2xs text-base-500">{label}</div>
      <div className="font-mono text-xs font-semibold text-base-100">{value}</div>
    </div>
  );
}
