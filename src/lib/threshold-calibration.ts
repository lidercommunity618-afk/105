import type { Signal } from '@/types/domain';

// Этап 4 плана калибровки ("КАЛИБРОВКА" + "АНАЛИТИКА ПО ФАКТОРАМ" →
// самообучение): Этап 2 уже подстраивает PATTERN_RELIABILITY_MULTIPLIER по
// данным. Этот модуль — симметричный контур для ЧАСТОТЫ сигналов: строит
// таблицу "порог входа (priorityThreshold) → ожидаемая частота/точность" по
// уже сохранённой истории сигналов ОДНОГО инструмента и предлагает (не
// применяет!) минимальный порог, достаточный для целевой частоты, если он
// не роняет винрейт ниже допуска. Ничего не мутирует — чистая функция,
// применение (setPriorityThreshold + per-symbol override) — отдельный шаг,
// вызываемый только после явного подтверждения пользователем (см.
// CalibrationPanel.tsx и priority-threshold-overrides.ts).
//
// Порог входа имеет смысл подбирать только по сигналам, у которых
// calibratedProbability пришёл из РЕАЛЬНОЙ калиброванной модели
// (calibrationSource === 'model'), а не из sigmoidFallback() — тот
// намеренно зажат в [0.35, 0.65] и не является оценкой уверенности (см.
// комментарий рядом с sigmoidFallback() в signal-builder.ts). Смешивать
// fallback-сигналы в бэктест порога значило бы повторить ту же
// категориальную ошибку, которую уже нашли и исправили для самого гейта
// (аудит 2026-09-05).

// АУДИТ ЭТАПА 4 (2026-09-09): изначально здесь стояло
// `MIN_THRESHOLD_BACKTEST_SAMPLES = MIN_SAMPLES` (100) — по аналогии с тем,
// что priorityThreshold как гейт не активен, пока
// CalibrationModel.isReady() (тот же MIN_SAMPLES). Это верно для
// готовности МОДЕЛИ (её собственный `samples: CalibrationSample[]` в
// calibration-model.ts, cap MAX_SAMPLES=500, per-symbol), но НЕ для
// источника данных, из которого реально считает этот модуль:
// useAnalyticsStore.signals — ГЛОБАЛЬНАЯ (across ALL инструментов сразу)
// история, жёстко ограниченная MAX_SIGNALS=100 РЕЗОЛВНУТЫХ сигналов
// (см. capSignals() в useAnalyticsStore.ts). Эти два хранилища — РАЗНЫЕ, с
// разными ёмкостями и разным скоупом (per-symbol vs global-shared).
//
// Итог: 100 — это не "минимально достаточная выборка", а ЖЁСТКИЙ ПОТОЛОК
// того, что вообще физически может накопиться для ОДНОГО инструмента (и
// то только если пользователь не торгует вообще ничего другого и ни один
// сигнал не ушёл в 'timeout'/'fallback'). Для любого пользователя,
// торгующего больше чем одним инструментом, `decidedCount >= 100` для
// конкретного символа практически недостижим НИКОГДА — эта секция
// калибровки молча превратилась бы в вечное "недостаточно истории",
// полностью убивая пользу Этапа 4. Порог понижен до значения, реально
// достижимого в пределах общего лимита 100 сигналов на ВСЕХ инструментах.
//
// BUGFIX (аудит 2026-09-13): раньше здесь было "но всё ещё заметно выше
// MIN_FACTOR_SAMPLES=5" — на момент этого комментария MIN_FACTOR_SAMPLES
// в factor-analytics.ts был поднят с 5 до 20 по той же самой логике
// (недостаточная выборка для самокалибровки), так что оба порога сейчас
// численно совпадают (20). Это совпадение независимо обоснованных чисел,
// а не требование, что один должен быть строго выше другого — концептуальное
// различие остаётся: там — надёжность ОДНОГО паттерна, здесь — агрегат по
// всем 'model'-сигналам одного инструмента и порога (решение с более
// широкими последствиями). Если оба когда-нибудь снова разойдутся —
// проверить, что расхождение обосновано, а не забытым чтением одного из
// двух мест.
export const MIN_THRESHOLD_BACKTEST_SAMPLES = 20;

// Допуск на потерю точности — единственное официально разрешённое
// "проседание" винрейта ради частоты. Явно вынесен в константу, а не
// зашит в формулу, чтобы (а) быть виден в UI-подписи, (б) быть
// настраиваемым в будущем без правки логики.
export const WINRATE_TOLERANCE = 0.03; // 3 п.п.

// Целевая частота из требования: не менее 1 сигнала за 5 минут.
export const TARGET_SIGNALS_PER_5MIN = 1;

// Шаг и границы сетки кандидатов порога — совпадают с границами слайдера
// priorityThreshold в SettingsPanel.tsx / setPriorityThreshold() в
// settingsStore.ts (0.5..0.95), чтобы рекомендация никогда не предлагала
// значение, которое сам слайдер не может выставить.
export const THRESHOLD_GRID_STEP = 0.05;
export const THRESHOLD_GRID_MIN = 0.5;
export const THRESHOLD_GRID_MAX = 0.95;

export interface ThresholdCandidateStat {
  threshold: number;
  /** Все ПОДАННЫЕ сигналы (calibrationSource==='model', calibratedProbability >= threshold),
   *  НЕЗАВИСИМО от того, резолвнулись ли они и открывалась ли по ним сделка —
   *  для частоты считается сам факт эмиссии сигнала, а не его исход. */
  emittedCount: number;
  /** Подмножество emittedCount, которое реально резолвилось (win/loss, с
   *  учётом tradeOpened !== false — та же семантика, что в
   *  calibration-buckets.ts/useAnalyticsStore.recomputeStats) — ТОЛЬКО эта
   *  выборка идёт в знаменатель winRate. Намеренно НЕ то же множество, что
   *  emittedCount (см. computeThresholdCandidates ниже: смешивать их —
   *  тот же класс бага, что уже находили в computeFactorStats/computeBuckets). */
  decidedCount: number;
  wins: number;
  winRate: number | null;
  /** null, если исторического окна недостаточно для оценки (< 2 различных
   *  по времени 'model'-сигналов во всей истории по символу). */
  signalsPer5Min: number | null;
  meetsFrequencyTarget: boolean;
  /** true, если winRate не null, накоплено достаточно резолвнутых сделок
   *  (>= MIN_THRESHOLD_BACKTEST_SAMPLES) И winRate >= baselineWinRate - WINRATE_TOLERANCE. */
  meetsAccuracyFloor: boolean;
}

export interface ThresholdRecommendation {
  candidates: ThresholdCandidateStat[];
  /** Текущий эффективный порог для символа — ВСЕГДА присутствует в
   *  candidates как отдельная точка ("было"), даже если сетка
   *  THRESHOLD_GRID_STEP на него не попадает (не округляется к сетке). */
  currentThreshold: number;
  /** null, если ни один кандидат не удовлетворяет ОБОИМ условиям
   *  одновременно — это ЧЕСТНЫЙ результат "недостижимо без потери
   *  точности", а не повод тихо занизить порог. */
  recommendedThreshold: number | null;
  reason: string;
}

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Строит таблицу "порог → частота/точность" по уже сохранённой истории
 * сигналов ОДНОГО символа. Вызывающий код обязан передать уже
 * отфильтрованный по symbolId массив — так же, как CalibrationPanel.tsx уже
 * фильтрует signals по symbolId перед computeFactorStats/computeBuckets;
 * этот модуль сам не фильтрует по символу и не обязан об этом знать.
 *
 * baselineWinRate — текущий живой винрейт (useAnalyticsStore.winRate),
 * ПЕРЕДАЁТСЯ вызывающим кодом, не пересчитывается здесь — единый источник
 * правды для "живого винрейта" уже есть (recomputeStats()); дублировать его
 * расчёт здесь означало бы риск разъехаться с ним.
 */
export function computeThresholdCandidates(
  signals: Signal[],
  currentThreshold: number,
  baselineWinRate: number | null,
): ThresholdRecommendation {
  const modelSignals = signals.filter(
    (s) => s.calibrationSource === 'model' && s.calibratedProbability !== null,
  );

  // Общее временное окно наблюдения — по ВСЕМ modelSignals, а не по
  // отфильтрованному порогом подмножеству. Иначе более строгий порог
  // (меньше сигналов) искусственно "сжимал" бы окно до времени первого/
  // последнего оставшегося сигнала и завышал бы расчётную частоту —
  // частота должна отвечать на вопрос "если бы этот порог действовал всё
  // это время, сколько сигналов проходило бы за 5 минут", а не быть
  // отношением к своему же урезанному диапазону.
  const times = modelSignals.map((s) => s.time).sort((a, b) => a - b);
  const spanSeconds = times.length >= 2 ? times[times.length - 1] - times[0] : 0;
  const windowsOf5Min = spanSeconds > 0 ? spanSeconds / 300 : 0;

  const grid = new Set<number>();
  for (let t = THRESHOLD_GRID_MIN; t <= THRESHOLD_GRID_MAX + 1e-9; t += THRESHOLD_GRID_STEP) {
    grid.add(roundTo2(t));
  }
  grid.add(roundTo2(currentThreshold)); // "было" гарантированно в таблице

  const candidates: ThresholdCandidateStat[] = Array.from(grid)
    .sort((a, b) => a - b)
    .map((threshold) => {
      const emitted = modelSignals.filter((s) => (s.calibratedProbability as number) >= threshold);
      const decided = emitted.filter(
        (s) => s.tradeOpened !== false && (s.outcome === 'win' || s.outcome === 'loss'),
      );
      const wins = decided.filter((s) => s.outcome === 'win').length;
      const winRate = decided.length > 0 ? wins / decided.length : null;
      const signalsPer5Min = windowsOf5Min > 0 ? emitted.length / windowsOf5Min : null;
      const meetsFrequencyTarget = signalsPer5Min !== null && signalsPer5Min >= TARGET_SIGNALS_PER_5MIN;
      const meetsAccuracyFloor =
        winRate !== null &&
        decided.length >= MIN_THRESHOLD_BACKTEST_SAMPLES &&
        (baselineWinRate === null || winRate >= baselineWinRate - WINRATE_TOLERANCE);

      return {
        threshold,
        emittedCount: emitted.length,
        decidedCount: decided.length,
        wins,
        winRate,
        signalsPer5Min,
        meetsFrequencyTarget,
        meetsAccuracyFloor,
      };
    });

  // Выбор рекомендации: среди кандидатов, удовлетворяющих ОБОИМ условиям
  // (частота и точность), берём тот, что даёт НАИБОЛЬШИЙ винрейт — точность
  // в приоритете, частота — это порог достаточности, а не то, что
  // максимизируем. При равном винрейте — более высокий (консервативный) порог.
  const qualifying = candidates.filter((c) => c.meetsFrequencyTarget && c.meetsAccuracyFloor);
  let recommendedThreshold: number | null = null;
  let reason: string;
  if (qualifying.length === 0) {
    recommendedThreshold = null;
    reason =
      times.length < 2
        ? 'Недостаточно истории с calibrationSource=model для оценки — калибровочная модель ещё не готова (см. MIN_THRESHOLD_BACKTEST_SAMPLES).'
        : 'Ни один порог из сетки не даёт частоту ≥1/5мин без потери винрейта ниже допуска — при текущем потоке сетапов цель недостижима без снижения точности.';
  } else {
    const best = qualifying.reduce((a, b) => {
      if ((b.winRate ?? 0) !== (a.winRate ?? 0)) return (b.winRate ?? 0) > (a.winRate ?? 0) ? b : a;
      return b.threshold > a.threshold ? b : a;
    });
    recommendedThreshold = best.threshold;
    reason = `Порог ${best.threshold.toFixed(2)}: ожидаемая частота ${(best.signalsPer5Min ?? 0).toFixed(2)} сигн./5мин, винрейт ${((best.winRate ?? 0) * 100).toFixed(0)}% на ${best.decidedCount} резолвнутых сделках.`;
  }

  return {
    candidates,
    currentThreshold: roundTo2(currentThreshold),
    recommendedThreshold,
    reason,
  };
}
