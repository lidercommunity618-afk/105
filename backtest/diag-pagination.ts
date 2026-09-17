#!/usr/bin/env tsx
import { loadHistory } from './data-loader';

async function main(): Promise<void> {
  const fromMs = new Date('2026-01-01').getTime();
  const toMs = new Date('2026-02-01').getTime();
  console.log('Loading EURUSD 1m from 2026-01-01 to 2026-02-01...');
  const candles = await loadHistory({ symbol: 'EURUSD', fromMs, toMs });
  console.log('Got candles:', candles.length);
  if (candles.length > 0) {
    console.log('First:', new Date(candles[0].time * 1000).toISOString());
    console.log('Last:', new Date(candles[candles.length - 1].time * 1000).toISOString());
  }
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
