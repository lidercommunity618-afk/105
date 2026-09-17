#!/usr/bin/env tsx
import { loadHistory } from './data-loader';

interface DiagArgs {
  symbol: string;
  from: string;
  to: string;
}

function parseArgs(): DiagArgs {
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
    from: map.get('from') ?? '2026-01-01',
    to: map.get('to') ?? '2026-02-01',
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const fromMs = new Date(args.from).getTime();
  const toMs = new Date(args.to).getTime();

  console.log(`\n=== Deriv Pagination Diagnostic ===`);
  console.log(`Symbol: ${args.symbol}`);
  console.log(`Requested range: ${args.from} → ${args.to}`);
  console.log(`Requested duration: ${Math.round((toMs - fromMs) / 86400000)} days`);
  console.log(`Loading 1m history...`);

  const t0 = Date.now();
  const candles = await loadHistory({ symbol: args.symbol, fromMs, toMs });
  const elapsed = Date.now() - t0;

  console.log(`\n--- Results ---`);
  console.log(`Elapsed: ${elapsed}ms`);
  console.log(`Total candles: ${candles.length}`);

  if (candles.length > 0) {
    const first = candles[0];
    const last = candles[candles.length - 1];
    const firstDate = new Date(first.time * 1000).toISOString();
    const lastDate = new Date(last.time * 1000).toISOString();
    const actualSpanDays = (last.time - first.time) / 86400;
    const requestedSpanSec = (toMs - fromMs) / 1000;
    const coveragePct = ((last.time - first.time) / requestedSpanSec) * 100;

    console.log(`First candle: ${firstDate}`);
    console.log(`Last candle: ${lastDate}`);
    console.log(`Actual span: ${actualSpanDays.toFixed(1)} days`);
    console.log(`Coverage of requested range: ${coveragePct.toFixed(1)}%`);

    const expectedCandles = Math.round((toMs - fromMs) / 60000);
    console.log(`Expected candles (ideal, no gaps): ${expectedCandles}`);
    console.log(`Coverage ratio: ${(candles.length / expectedCandles * 100).toFixed(1)}%`);

    if (candles.length < expectedCandles * 0.5) {
      console.log(`\n⚠ WARNING: Received significantly fewer candles than requested.`);
      console.log(`  This may indicate an API history-depth limit or loader issue.`);
      console.log(`  If the loader stopped at ~2881 candles regardless of the`);
      console.log(`  requested range, this is a Deriv API depth limit, not a bug.`);
      console.log(`  If the loader stopped early with a short-batch break, that`);
      console.log(`  would be a loader bug (now fixed — short batches do not`);
      console.log(`  terminate pagination).`);
    }
  } else {
    console.log(`No candles received.`);
  }

  console.log(`\n--- Stop-reason diagnostics (from loader logs above) ---`);
  console.log(`Check the [Deriv] log lines for the termination reason:`);
  console.log(`  - "empty batch"     → API exhausted (genuine history end)`);
  console.log(`  - "reached start"  → successfully reached requested start date`);
  console.log(`  - "no progress"     → timestamps stopped moving backward`);
  console.log(`  - "hit iteration cap" → reached ${200} iterations (safety limit)`);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
