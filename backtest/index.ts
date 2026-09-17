#!/usr/bin/env tsx

import { loadHistory } from './data-loader';
import { resample } from './resampler';
import { simulate } from './simulator';
import { computeSplitMetrics } from './metrics';
import { generateReport } from './report';
import { DEFAULT_BACKTEST_CONFIG } from './config';
import { LOGIC_CHANGE_LOG, currentFreezeMs, computeForwardTestReport } from './change-registry';
import { DEFAULT_PROFIT_PERCENT_FALLBACK } from '@/lib/pattern-reliability-calibration';
import { timeframeSchema } from '@/types/domain';
import type { Timeframe } from '@/types/domain';

interface CliArgs {
  symbol: string;
  from: string;
  to: string;
  timeframe: string;
  outputDir: string;
  barsToResolve: number;
  windowSize: number;
  inSampleRatio: number;
  // Аудит 2026-09-13, п.5 (протокол против переобучения через сам аудит):
  // необязательные CLI-параметры для честной форвард-тест секции отчёта —
  // см. change-registry.ts. Без --freeze-at используется момент заморозки
  // ДЕЙСТВУЮЩЕГО набора правок (currentFreezeMs(LOGIC_CHANGE_LOG)), а не
  // произвольная дата — иначе легко случайно "сдвинуть" границу так, что
  // старые (уже виденные при разработке правки) сделки притворятся
  // форвард-тестом.
  // Аудит 2026-09-13, п.5 (протокол против переобучения через сам аудит) +
  // отдельный фикс "R-модель бэктеста не совпадала с реальной экономикой
  // демо-счёта" (см. metrics.ts): --profit-percent теперь единообразно
  // определяет и точку безубыточности для форвард-теста, и саму
  // доходность (averageR/profitFactor/maxDrawdownR) во ВСЕХ метриках
  // (split включая IN-SAMPLE/OUT-OF-SAMPLE) — раньше эти два места
  // молчаливо расходились: точка безубыточности считалась от payout,
  // а сама доходность — от независимо захардкоженной модели 2:1.
  freezeAt: string | null;
  profitPercent: number;
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
    symbol: map.get('symbol') ?? 'BTCUSDT',
    from: map.get('from') ?? '2025-01-01',
    to: map.get('to') ?? '2025-06-01',
    timeframe: map.get('timeframe') ?? '15m',
    outputDir: map.get('output') ?? DEFAULT_BACKTEST_CONFIG.outputDir,
    barsToResolve: parseInt(map.get('bars') ?? '5', 10),
    windowSize: parseInt(map.get('window') ?? '500', 10),
    inSampleRatio: parseFloat(map.get('is-ratio') ?? '0.7'),
    freezeAt: map.get('freeze-at') ?? null,
    profitPercent: parseFloat(map.get('profit-percent') ?? String(DEFAULT_PROFIT_PERCENT_FALLBACK)),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();

  const tfResult = timeframeSchema.safeParse(args.timeframe);
  if (!tfResult.success) {
    console.error(
      `Invalid timeframe: ${args.timeframe}. Valid: ${timeframeSchema.options.join(', ')}`,
    );
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
  if (args.inSampleRatio <= 0 || args.inSampleRatio >= 1) {
    console.error('--is-ratio must be between 0 and 1 (exclusive)');
    process.exit(1);
  }

  let freezeAtMs = currentFreezeMs(LOGIC_CHANGE_LOG);
  if (args.freezeAt !== null) {
    const parsed = new Date(args.freezeAt).getTime();
    if (Number.isNaN(parsed)) {
      console.error('Invalid --freeze-at date format. Use YYYY-MM-DD.');
      process.exit(1);
    }
    freezeAtMs = parsed;
  }
  if (!Number.isFinite(args.profitPercent) || args.profitPercent <= 0) {
    console.error('--profit-percent must be a positive number.');
    process.exit(1);
  }

  console.log(`\nLoading 1m history: ${args.symbol} ${args.from} \u2192 ${args.to}`);
  const candles1m = await loadHistory({ symbol: args.symbol, fromMs, toMs });
  console.log(`Loaded ${candles1m.length} 1m candles`);

  if (candles1m.length < 100) {
    console.error('Not enough candles for backtest (need at least 100)');
    process.exit(1);
  }

  const candles = resample(candles1m, timeframe);
  console.log(`Resampled to ${timeframe}: ${candles.length} candles`);

  console.log(
    `Simulating (window=${args.windowSize}, barsToResolve=${args.barsToResolve}, isRatio=${args.inSampleRatio})...`,
  );
  const trades = simulate(candles, {
    symbol: args.symbol,
    timeframe,
    indicatorConfig: { ...DEFAULT_BACKTEST_CONFIG.indicatorConfig },
    activeFeatures: [...DEFAULT_BACKTEST_CONFIG.activeFeatures],
    barsToResolve: args.barsToResolve,
    windowSize: args.windowSize,
    inSampleRatio: args.inSampleRatio,
  });
  console.log(`Generated ${trades.length} trades\n`);

  if (trades.length === 0) {
    console.log('No trades generated. Try a longer period or different timeframe.');
    process.exit(0);
  }

  const split = computeSplitMetrics(trades, args.profitPercent);
  const forwardTest = computeForwardTestReport(trades, freezeAtMs, args.profitPercent);
  generateReport(trades, split, forwardTest, {
    symbol: args.symbol,
    timeframe: args.timeframe,
    from: args.from,
    to: args.to,
    outputDir: args.outputDir,
    profitPercent: args.profitPercent,
  });
}

main().catch((err: unknown) => {
  console.error('Backtest failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
