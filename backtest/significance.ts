// РЕФАКТОРИНГ (бинарные опционы, Фаза 2): direction-horizon-source-variant-B.md,
// раздел 3, требует тест значимости против случайного направленного
// бейзлайна для каждой строки таблицы pattern-audit-checklist.md — иначе
// при ~42 паттернах × 7 значений expiryBars (~266 независимых сравнений)
// часть комбинаций пройдёт с "хорошей" accuracy просто по multiple
// comparisons problem, даже если ни один паттерн не имеет реальной
// предсказательной силы.
//
// Используется точный биномиальный тест (не приближение через нормальное
// распределение — при малых выборках погранично-редких паттернов
// (Rising/Falling Three Methods, Abandoned Baby) нормальное приближение
// ненадёжно именно там, где корректность важнее всего) против baseline=0.5
// (случайное направление, тот же размер выборки — см. методологию
// академических источников в direction-horizon-source-variant-B.md,
// раздел 1).

/**
 * log(n!) через lgamma-приближение (Lanczos) — точнее, чем наивное
 * произведение факториалов, и не переполняется при n в сотни/тысячи
 * (реалистичный размер выборки сигналов на M1-паттерн за разумный период
 * истории).
 */
function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const xx = x - 1;
  let a = c[0];
  const t = xx + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (xx + i);
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

function logFactorial(n: number): number {
  return logGamma(n + 1);
}

function logBinomialCoefficient(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

function binomialPmf(k: number, n: number, p: number): number {
  if (k < 0 || k > n) return 0;
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return k === n ? 1 : 0;
  const logP = logBinomialCoefficient(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p);
  return Math.exp(logP);
}

export interface SignificanceResult {
  wins: number;
  total: number;
  observedAccuracy: number;
  baseline: number;
  /** Двусторонний точный биномиальный p-value против baseline. */
  pValue: number;
  /** p < alpha, accuracy > baseline, И выборка прошла минимальный порог. */
  significant: boolean;
  reason: 'insufficient-samples' | 'not-significant' | 'significant';
}

// direction-horizon-source-variant-B.md, раздел 3, п.2: "не меньше нескольких
// сотен сигналов" — 200 выбрано как компромисс: при p=0.5 baseline и alpha=0.05,
// 200 сигналов дают разумную мощность обнаружить эффект порядка нескольких
// процентных пунктов, наименьший практически значимый эффект для контракта
// с типичной выплатой 80-90% (см. breakevenWinRate в
// pattern-reliability-calibration.ts). Паттерны, не набравшие порог,
// помечаются "недостаточно данных", а не оцениваются с ложной точностью.
export const MIN_SAMPLES_FOR_SIGNIFICANCE = 200;

/**
 * Двусторонний точный биномиальный тест: H0 — истинная accuracy паттерна
 * равна baseline (случайное направление). significant=true только если
 * выборка прошла минимальный порог, p-value < alpha, И наблюдённая accuracy
 * выше baseline (нас интересует исключительно "лучше случайного").
 */
export function binomialSignificanceTest(
  wins: number,
  total: number,
  baseline: number = 0.5,
  alpha: number = 0.05,
): SignificanceResult {
  const observedAccuracy = total > 0 ? wins / total : 0;

  if (total < MIN_SAMPLES_FOR_SIGNIFICANCE) {
    return { wins, total, observedAccuracy, baseline, pValue: NaN, significant: false, reason: 'insufficient-samples' };
  }

  // Двусторонний p-value: сумма вероятностей всех исходов k, не более
  // вероятных, чем наблюдённый (стандартное определение точного
  // биномиального теста, устойчиво к асимметрии при baseline != 0.5).
  const pObserved = binomialPmf(wins, total, baseline);
  let pValue = 0;
  for (let k = 0; k <= total; k++) {
    const pk = binomialPmf(k, total, baseline);
    if (pk <= pObserved * (1 + 1e-9)) pValue += pk;
  }
  pValue = Math.min(1, pValue);

  const significant = pValue < alpha && observedAccuracy > baseline;
  return {
    wins,
    total,
    observedAccuracy,
    baseline,
    pValue,
    significant,
    reason: significant ? 'significant' : 'not-significant',
  };
}
