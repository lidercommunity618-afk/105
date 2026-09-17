#!/usr/bin/env tsx
/**
 * Horizon Audit — Variant B
 *
 * Аудит горизонта паттернов на реальных исторических данных.
 * Загружает 1m-свечи через существующий data-loader (Deriv для forex),
 * ресэмплирует в целевой таймфрейм, прогоняет ВСЕ детекторы на каждой
 * исторической свече и оценивает направленную точность на нескольких
 * горизонтах экспирации (expiryBars).
 *
 * Методология (direction-horizon-source-variant-B.md, раздел 3):
 *  1. Хронологическое разбиение train/validation/test 60/20/20.
 *  2. Выбор лучшего expiryBars — ТОЛЬКО по train+validation.
 *  3. Финальная оценка — на отложенной test-выборке.
 *  4. Точный двусторонний биномиальный тест значимости против baseline=0.5
 *     (см. ./significance.ts) — СЛИЯНИЕ (2026-09-16): раньше здесь был
 *     Monte-Carlo permutation-тест (1000 симуляций случайного направления);
 *     заменён на точный биномиальный тест ровно по той причине, по которой
 *     он лучше на малых выборках редких паттернов (Abandoned Baby,
 *     Rising/Falling Three Methods) — Monte-Carlo с 1000 итерациями даёт
 *     грубое разрешение p-value вблизи границы значимости именно там, где
 *     корректность важнее всего; точный тест не имеет этой погрешности.
 *  5. Минимальный порог числа срабатываний — MIN_SAMPLES_FOR_SIGNIFICANCE
 *     (200, см. ./significance.ts, обоснование мощности теста в
 *     комментарии там же) — СЛИЯНИЕ: до объединения здесь стоял
 *     непроверенный порог 10, который не был обоснован расчётом мощности
 *     и был на порядок ниже.
 *  6. Предупреждение о множественных сравнениях (Holm-Bonferroni,
 *     применяется поверх результатов точного теста, без изменений).
 *
 * Использование:
 *   npm run backtest:horizon-audit -- --symbol=EURUSD --timeframe=15m \
 *     --from=2026-06-16 --to=2026-09-16
 */

import { loadHistory } from './data-loader';
import { resample } from './resampler';
import { binomialSignificanceTest, MIN_SAMPLES_FOR_SIGNIFICANCE } from './significance';
import { detectAllPatterns } from '@/compute/patterns';
import { computeIndicators } from '@/compute/IndicatorAggregator';
import { computeStructure } from '@/compute/indicators/trend-structure';
import { calcSmartMoney } from '@/compute/indicators/smart-money';
import { timeframeSchema, ALL_FEATURES, DEFAULT_INDICATOR_CONFIG } from '@/types/domain';
import type { Candle, Timeframe, PatternName, SignalDirection } from '@/types/domain';

// ─── CLI ───────────────────────────────────────────────────────────

interface CliArgs {
  symbol: string;
  from: string;
  to: string;
  timeframe: string;
  outputDir: string;
  windowSize: number;
  minSamples: number;
  significanceAlpha: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const map = new Map<string, string>();
  for (const arg of args) {
    const eqIdx = arg.indexOf('=');
    if (eqIdx > 0 && arg.startsWith('--')) {
      map.set(arg.slice(2, eqIdx), arg.slice(eqIdx + 1));
    }
  }
  return {
    symbol: map.get('symbol') ?? 'EURUSD',
    from: map.get('from') ?? '2026-06-16',
    to: map.get('to') ?? '2026-09-16',
    timeframe: map.get('timeframe') ?? '15m',
    outputDir: map.get('output') ?? 'backtest/output',
    windowSize: parseInt(map.get('window') ?? '500', 10),
    minSamples: parseInt(map.get('min-samples') ?? '30', 10),
    significanceAlpha: parseFloat(map.get('alpha') ?? '0.05'),
  };
}

// ─── Pattern horizon grids (from pattern-audit-checklist-variant-B.md) ─

const HORIZON_GRIDS: Record<string, number[]> = {
  'impulse-breakout': [1, 2, 3],
  'liquidity-sweep-reaction': [1, 2, 3],
  'order-block-continuation': [5, 10, 20, 30],
  'harmonic-pattern': [10, 20, 30],
  'strong-order-block-reaction': [1, 2, 3, 5, 10, 20, 30],
  'macd-deceleration-continuation': [5, 10, 20, 30],
  'fvg-return': [1, 2, 3, 5, 10, 20, 30],
  'fvg-rejection': [1, 2, 3, 5],
  'fvg-breaker-block': [5, 10, 20, 30],
  'fvg-nested': [5, 10, 20, 30],
  'order-block-breaker': [5, 10, 20, 30],
  'order-block-nested': [5, 10, 20, 30],
  'liquidity-sweep': [1, 2, 3],
  'hammer': [1, 2, 3, 5],
  'shooting-star': [1, 2, 3, 5],
  'inverted-hammer': [1, 2, 3, 5],
  'hanging-man': [1, 2, 3, 5],
  'marubozu-bullish': [1, 2, 3],
  'marubozu-bearish': [1, 2, 3],
  'bullish-engulfing': [1, 2, 3, 5],
  'bearish-engulfing': [1, 2, 3, 5],
  'bullish-harami': [2, 3, 5, 10],
  'bearish-harami': [2, 3, 5, 10],
  'piercing-line': [1, 2, 3, 5],
  'dark-cloud-cover': [1, 2, 3, 5],
  'tweezer-bottom': [1, 2, 3, 5],
  'tweezer-top': [1, 2, 3, 5],
  'morning-star': [3, 5, 10],
  'evening-star': [3, 5, 10],
  'three-white-soldiers': [3, 5, 10],
  'three-black-crows': [3, 5, 10],
  'abandoned-baby-bottom': [3, 5, 10],
  'abandoned-baby-top': [3, 5, 10],
  'pin-bar': [1, 2, 3, 5],
  'rising-three-methods': [10, 20, 30],
  'falling-three-methods': [10, 20, 30],
  'consolidation-breakout': [1, 2, 3, 5],
  'inside-bar': [1, 2, 3, 5],
  'mean-reversion': [5, 10, 15, 20],
};

// Doji и Spinning Top намеренно исключены — нет направленной гипотезы.
const EXCLUDED_PATTERNS = new Set<PatternName>(['doji', 'spinning-top']);

// ─── Types ─────────────────────────────────────────────────────────

interface Occurrence {
  patternName: PatternName;
  setupType: string | null;
  direction: SignalDirection;
  barIndex: number;
  entryPrice: number;
  time: number;
  confidence: number;
  partition: 'train' | 'validation' | 'test';
  // outcome per expiry: -1 (loss), 0 (timeout), 1 (win)
  outcomes: Map<number, number>;
}

interface PatternResult_ {
  patternName: PatternName;
  setupType: string | null;
  totalOccurrences: number;
  trainValCount: number;
  testCount: number;
  bestExpiryBars: number | null;
  testAccuracy: number | null;
  testWinCount: number | null;
  testDecidedCount: number | null;
  baselineMean: number | null;
  baselineStd: number | null;
  pValue: number | null;
  significant: boolean | null;
  status: 'ok' | 'insufficient-data' | 'no-detections';
  perExpiry: {
    expiryBars: number;
    trainValAccuracy: number;
    testAccuracy: number;
    testDecided: number;
  }[];
}

// ─── Core audit ─────────────────────────────────────────────────────

function buildOccurrences(
  candles: Candle[],
  activeFeatures: PatternName[],
  config: typeof DEFAULT_INDICATOR_CONFIG,
  windowSize: number,
  maxExpiry: number,
): Occurrence[] {
  const occurrences: Occurrence[] = [];
  const minStart = Math.max(windowSize, 50);

  for (let i = minStart; i < candles.length - maxExpiry; i++) {
    const window = candles.slice(i - windowSize + 1, i + 1);

    const { snapshot } = computeIndicators(window, config, activeFeatures);
    const structure = computeStructure(window, 50, true, config.atrPeriod);
    const smartMoney = calcSmartMoney(window);

    const patterns = detectAllPatterns(
      window,
      activeFeatures,
      snapshot,
      structure,
      smartMoney,
      config.atrPeriod,
      { fast: config.macdFast, slow: config.macdSlow, signal: config.macdSignal },
      {
        minLegAtr: config.harmonicMinLegAtr,
        fibTolerancePct: config.harmonicFibTolerancePct,
        htfFactor: config.harmonicHtfFactor,
      },
    );

    const entryCandle = candles[i];

    for (const p of patterns) {
      if (EXCLUDED_PATTERNS.has(p.name)) continue;
      const grid = HORIZON_GRIDS[p.name];
      if (!grid) continue;

      const outcomes = new Map<number, number>();
      for (const expiry of grid) {
        if (i + expiry >= candles.length) {
          outcomes.set(expiry, 0); // timeout / unavailable
          continue;
        }
        const expiryCandle = candles[i + expiry];
        const isBuy = p.direction === 'buy';
        if (expiryCandle.close === entryCandle.close) {
          outcomes.set(expiry, 0);
        } else {
          const win = isBuy
            ? expiryCandle.close > entryCandle.close
            : expiryCandle.close < entryCandle.close;
          outcomes.set(expiry, win ? 1 : -1);
        }
      }

      occurrences.push({
        patternName: p.name,
        setupType: p.setupType ?? null,
        direction: p.direction,
        barIndex: i,
        entryPrice: entryCandle.close,
        time: entryCandle.time,
        confidence: p.confidence,
        partition: 'train', // assigned later
        outcomes,
      });
    }
  }

  return occurrences;
}

function assignPartitions(occurrences: Occurrence[], totalBars: number): void {
  const trainEnd = Math.floor(totalBars * 0.6);
  const valEnd = Math.floor(totalBars * 0.8);
  for (const o of occurrences) {
    if (o.barIndex < trainEnd) o.partition = 'train';
    else if (o.barIndex < valEnd) o.partition = 'validation';
    else o.partition = 'test';
  }
}

function accuracyForExpiry(
  occs: Occurrence[],
  expiry: number,
): { accuracy: number; decided: number } {
  let wins = 0;
  let decided = 0;
  for (const o of occs) {
    const out = o.outcomes.get(expiry);
    if (out === undefined) continue;
    if (out === 0) continue; // timeout excluded from denominator
    decided++;
    if (out === 1) wins++;
  }
  return { accuracy: decided > 0 ? wins / decided : 0, decided };
}

function selectBestExpiry(
  trainVal: Occurrence[],
  grid: number[],
): { bestExpiry: number; bestAccuracy: number } | null {
  let bestExpiry = grid[0];
  let bestAccuracy = -1;
  for (const expiry of grid) {
    const { accuracy, decided } = accuracyForExpiry(trainVal, expiry);
    if (decided === 0) continue;
    if (accuracy > bestAccuracy) {
      bestAccuracy = accuracy;
      bestExpiry = expiry;
    }
  }
  if (bestAccuracy < 0) return null;
  return { bestExpiry, bestAccuracy };
}

// СЛИЯНИЕ (2026-09-16): Monte-Carlo permutation-тест baselineTest() удалён —
// заменён на точный биномиальный тест binomialSignificanceTest() из
// ./significance.ts (см. точку вызова ниже и header-комментарий файла).
// mulberry32 (seeded PRNG) больше не используется этим модулем — удалён
// вместе с функцией, которую он обслуживал.

function holmBonferroni(
  results: PatternResult_[],
  alpha: number,
): void {
  const tested = results
    .filter((r) => r.pValue !== null)
    .sort((a, b) => (a.pValue! - b.pValue!));
  const m = tested.length;
  for (let i = 0; i < tested.length; i++) {
    const threshold = alpha / (m - i);
    tested[i].significant = tested[i].pValue! <= threshold;
  }
}

// ─── Report generation ──────────────────────────────────────────────

function generateMarkdown(
  args: CliArgs,
  candles1mCount: number,
  candlesCount: number,
  results: PatternResult_[],
  dateRange: { from: string; to: string },
): string {
  const lines: string[] = [];
  lines.push(`# Horizon Audit — ${args.symbol} ${args.timeframe}`);
  lines.push('');
  lines.push(`> Сгенерировано: ${new Date().toISOString()}`);
  lines.push(`> Период: ${dateRange.from} → ${dateRange.to}`);
  lines.push(`> Источник: Deriv WebSocket (1m candles → resampled to ${args.timeframe})`);
  lines.push(`> Разбиение: train 60% / validation 20% / test 20% (хронологическое)`);
  lines.push(`> Минимальный порог (train+validation): ${args.minSamples} срабатываний`);
  lines.push(`> Минимальный порог для теста значимости (test-выборка): ${MIN_SAMPLES_FOR_SIGNIFICANCE} решённых исходов`);
  lines.push(`> Значимость: точный двусторонний биномиальный тест против baseline=0.5, с поправкой Holm-Bonferroni, α = ${args.significanceAlpha}`);
  lines.push('');
  lines.push(`**Загружено**: ${candles1mCount} 1m свечей, ${candlesCount} ${args.timeframe} свечей после ресэмплинга.`);
  lines.push('');

  const significantCount = results.filter((r) => r.significant === true).length;
  const insufficientCount = results.filter((r) => r.status === 'insufficient-data').length;
  const noDetectionCount = results.filter((r) => r.status === 'no-detections').length;

  lines.push(`## Сводка`);
  lines.push('');
  lines.push(`- Паттернов в сетке: ${results.length}`);
  lines.push(`- Статистически значимых (после Holm-Bonferroni): **${significantCount}**`);
  lines.push(`- Недостаточно данных: ${insufficientCount}`);
  lines.push(`- Нет срабатываний: ${noDetectionCount}`);
  lines.push('');
  lines.push(`> **Предупреждение о множественных сравнениях**: ${results.length} паттернов × несколько горизонтов = сотни комбинаций. Лучший expiryBars выбран по train+validation, финальная оценка — на отложенной test-выборке. Значимость проверена против random baseline с коррекцией Holm-Bonferroni. Тем не менее, на 3 месяцах данных (~8600 15m баров) статистическая мощность ограничена — результаты предварительные.`);
  lines.push('');

  lines.push(`## Результаты по паттернам`);
  lines.push('');
  lines.push('| Паттерн | Setup | Всего | Train+Val | Test | Лучший expiry | Test accuracy | Baseline mean | p-value | Значим | Статус |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');

  for (const r of results) {
    const setup = r.setupType ?? '—';
    const total = r.totalOccurrences;
    const tv = r.trainValCount;
    const tc = r.testCount;
    const exp = r.bestExpiryBars ?? '—';
    const acc = r.testAccuracy !== null ? `${(r.testAccuracy * 100).toFixed(1)}%` : '—';
    const bmean = r.baselineMean !== null ? `${(r.baselineMean * 100).toFixed(1)}%` : '—';
    const pv = r.pValue !== null ? r.pValue.toFixed(4) : '—';
    const sig = r.significant === true ? 'да' : r.significant === false ? 'нет' : '—';
    const status = r.status === 'ok' ? 'OK' : r.status === 'insufficient-data' ? 'недостаточно данных' : 'нет срабатываний';
    lines.push(`| ${r.patternName} | ${setup} | ${total} | ${tv} | ${tc} | ${exp} | ${acc} | ${bmean} | ${pv} | ${sig} | ${status} |`);
  }

  lines.push('');
  lines.push(`## Детализация по горизонтам`);
  lines.push('');

  for (const r of results) {
    if (r.perExpiry.length === 0) continue;
    lines.push(`### ${r.patternName}${r.setupType ? ` (${r.setupType})` : ''}`);
    lines.push('');
    lines.push('| Expiry bars | Train+Val accuracy | Test accuracy | Test decided |');
    lines.push('|---|---|---|---|');
    for (const pe of r.perExpiry) {
      lines.push(`| ${pe.expiryBars} | ${(pe.trainValAccuracy * 100).toFixed(1)}% | ${(pe.testAccuracy * 100).toFixed(1)}% | ${pe.testDecided} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  const tfResult = timeframeSchema.safeParse(args.timeframe);
  if (!tfResult.success) {
    console.error(`Invalid timeframe: ${args.timeframe}. Valid: ${timeframeSchema.options.join(', ')}`);
    process.exit(1);
  }
  const timeframe: Timeframe = tfResult.data;

  const fromMs = new Date(args.from).getTime();
  const toMs = new Date(args.to).getTime();
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    console.error('Invalid date format. Use YYYY-MM-DD.');
    process.exit(1);
  }
  if (fromMs >= toMs) {
    console.error('--from must be before --to');
    process.exit(1);
  }

  console.log(`\nHorizon Audit: ${args.symbol} ${args.timeframe} ${args.from} → ${args.to}`);
  console.log(`Loading 1m history via Deriv...`);

  const candles1m = await loadHistory({ symbol: args.symbol, fromMs, toMs });
  console.log(`Loaded ${candles1m.length} 1m candles`);

  if (candles1m.length < 500) {
    console.error('Not enough 1m candles for horizon audit (need at least 500)');
    process.exit(1);
  }

  const candles = resample(candles1m, timeframe);
  console.log(`Resampled to ${timeframe}: ${candles.length} candles`);

  if (candles.length < 200) {
    console.error('Not enough resampled candles for horizon audit (need at least 200)');
    process.exit(1);
  }

  // All pattern features (exclude doji/spinning-top from directional analysis)
  const patternFeatures = ALL_FEATURES.filter(
    (f): f is PatternName =>
      HORIZON_GRIDS[f as string] !== undefined && !EXCLUDED_PATTERNS.has(f as PatternName),
  );

  const config = { ...DEFAULT_INDICATOR_CONFIG };

  const maxExpiry = Math.max(...Object.values(HORIZON_GRIDS).flat());
  console.log(`Max expiry: ${maxExpiry} bars. Running detectors on ${candles.length - maxExpiry - args.windowSize} bars...`);

  const occurrences = buildOccurrences(
    candles,
    patternFeatures,
    config,
    args.windowSize,
    maxExpiry,
  );

  assignPartitions(occurrences, candles.length);

  console.log(`Total occurrences: ${occurrences.length}`);
  const trainVal = occurrences.filter((o) => o.partition === 'train' || o.partition === 'validation');
  const test = occurrences.filter((o) => o.partition === 'test');
  console.log(`Train+Validation: ${trainVal.length}, Test: ${test.length}`);

  // Group by pattern + setupType
  const groupKey = (o: Occurrence) => `${o.patternName}|${o.setupType ?? ''}`;
  const groups = new Map<string, Occurrence[]>();
  for (const o of occurrences) {
    const key = groupKey(o);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(o);
  }

  const results: PatternResult_[] = [];
  for (const [key, groupOccs] of groups) {
    const [patternName, setupTypeStr] = key.split('|');
    const setupType = setupTypeStr || null;
    const grid = HORIZON_GRIDS[patternName];
    if (!grid) continue;

    const tv = groupOccs.filter((o) => o.partition !== 'test');
    const tc = groupOccs.filter((o) => o.partition === 'test');

    const result: PatternResult_ = {
      patternName: patternName as PatternName,
      setupType,
      totalOccurrences: groupOccs.length,
      trainValCount: tv.length,
      testCount: tc.length,
      bestExpiryBars: null,
      testAccuracy: null,
      testWinCount: null,
      testDecidedCount: null,
      baselineMean: null,
      baselineStd: null,
      pValue: null,
      significant: null,
      status: 'no-detections',
      perExpiry: [],
    };

    if (groupOccs.length === 0) {
      results.push(result);
      continue;
    }

    if (tv.length < args.minSamples) {
      result.status = 'insufficient-data';
      // Still compute perExpiry for reference
      for (const expiry of grid) {
        const tvAcc = accuracyForExpiry(tv, expiry);
        const tAcc = accuracyForExpiry(tc, expiry);
        result.perExpiry.push({
          expiryBars: expiry,
          trainValAccuracy: tvAcc.accuracy,
          testAccuracy: tAcc.accuracy,
          testDecided: tAcc.decided,
        });
      }
      results.push(result);
      continue;
    }

    // Per-expiry stats
    for (const expiry of grid) {
      const tvAcc = accuracyForExpiry(tv, expiry);
      const tAcc = accuracyForExpiry(tc, expiry);
      result.perExpiry.push({
        expiryBars: expiry,
        trainValAccuracy: tvAcc.accuracy,
        testAccuracy: tAcc.accuracy,
        testDecided: tAcc.decided,
      });
    }

    // Select best expiry on train+validation
    const best = selectBestExpiry(tv, grid);
    if (!best) {
      result.status = 'insufficient-data';
      results.push(result);
      continue;
    }

    result.bestExpiryBars = best.bestExpiry;
    const testResult = accuracyForExpiry(tc, best.bestExpiry);
    result.testAccuracy = testResult.accuracy;
    result.testDecidedCount = testResult.decided;
    result.testWinCount = testResult.decided > 0
      ? Math.round(testResult.accuracy * testResult.decided)
      : 0;

    if (testResult.decided < MIN_SAMPLES_FOR_SIGNIFICANCE) {
      result.status = 'insufficient-data';
      results.push(result);
      continue;
    }

    // Точный двусторонний биномиальный тест значимости против baseline=0.5
    // (СЛИЯНИЕ 2026-09-16, см. header-комментарий файла и ./significance.ts).
    const sig = binomialSignificanceTest(
      result.testWinCount,
      testResult.decided,
      0.5,
      args.significanceAlpha,
    );
    result.baselineMean = sig.baseline;
    result.baselineStd = null; // не применимо для точного теста (не было Monte-Carlo распределения)
    result.pValue = sig.pValue;
    result.status = 'ok';
    results.push(result);
  }

  // Holm-Bonferroni correction
  holmBonferroni(results, args.significanceAlpha);

  // Sort results: significant first, then by test accuracy
  results.sort((a, b) => {
    if (a.significant === true && b.significant !== true) return -1;
    if (b.significant === true && a.significant !== true) return 1;
    const aAcc = a.testAccuracy ?? -1;
    const bAcc = b.testAccuracy ?? -1;
    return bAcc - aAcc;
  });

  // Generate reports
  const md = generateMarkdown(args, candles1m.length, candles.length, results, {
    from: args.from,
    to: args.to,
  });

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  await fs.mkdir(args.outputDir, { recursive: true });

  const baseName = `horizon-audit-${args.symbol}-${args.timeframe}-${args.from}-${args.to}`;
  const mdPath = path.join(args.outputDir, `${baseName}.md`);
  const jsonPath = path.join(args.outputDir, `${baseName}.json`);

  await fs.writeFile(mdPath, md, 'utf-8');
  await fs.writeFile(
    jsonPath,
    JSON.stringify({
      meta: {
        symbol: args.symbol,
        timeframe: args.timeframe,
        from: args.from,
        to: args.to,
        candles1m: candles1m.length,
        candlesResampled: candles.length,
        windowSize: args.windowSize,
        minSamples: args.minSamples,
        minSamplesForSignificance: MIN_SAMPLES_FOR_SIGNIFICANCE,
        alpha: args.significanceAlpha,
        generatedAt: new Date().toISOString(),
      },
      results: results.map((r) => ({
        patternName: r.patternName,
        setupType: r.setupType,
        totalOccurrences: r.totalOccurrences,
        trainValCount: r.trainValCount,
        testCount: r.testCount,
        bestExpiryBars: r.bestExpiryBars,
        testAccuracy: r.testAccuracy,
        testWinCount: r.testWinCount,
        testDecidedCount: r.testDecidedCount,
        baselineMean: r.baselineMean,
        baselineStd: r.baselineStd,
        pValue: r.pValue,
        significant: r.significant,
        status: r.status,
        perExpiry: r.perExpiry,
      })),
    }, null, 2),
    'utf-8',
  );

  console.log(`\nReport saved: ${mdPath}`);
  console.log(`JSON saved: ${jsonPath}`);

  // Summary to console
  const sig = results.filter((r) => r.significant === true);
  const insuf = results.filter((r) => r.status === 'insufficient-data');
  console.log(`\n=== Summary ===`);
  console.log(`Patterns evaluated: ${results.length}`);
  console.log(`Significant (Holm-Bonferroni α=${args.significanceAlpha}): ${sig.length}`);
  console.log(`Insufficient data: ${insuf.length}`);
  if (sig.length > 0) {
    console.log(`\nSignificant patterns:`);
    for (const r of sig) {
      console.log(
        `  ${r.patternName}${r.setupType ? ` (${r.setupType})` : ''}: ` +
        `expiry=${r.bestExpiryBars}, accuracy=${((r.testAccuracy ?? 0) * 100).toFixed(1)}%, ` +
        `baseline=${((r.baselineMean ?? 0) * 100).toFixed(1)}%, p=${r.pValue?.toFixed(4)}`,
      );
    }
  }
}

main().catch((err: unknown) => {
  console.error('Horizon audit failed:', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
