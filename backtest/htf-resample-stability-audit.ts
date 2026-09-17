#!/usr/bin/env tsx
import type { Candle } from '@/types/domain';
import { detectHtfObZones } from '@/compute/patterns/order-block-nested';
import { detectHtfFvgZones } from '@/compute/patterns/fvg-nested';

// ─────────────────────────────────────────────────────────────────────────
// Эмпирическая проверка (docs/audit/recommendations-post-harmonic-audit.md,
// Рекомендации 1 и 3) того, что HTF-зоны (Order Block / FVG), построенные
// через resampleCandles(..., { alignToAbsoluteTime: true }), СТАБИЛЬНЫ на
// скользящем окне: top/bottom/time зоны в фиксированном, далёком от края
// окна диапазоне истории не должны зависеть от того, где именно проходит
// граница `candles.slice(i - windowSize + 1, i + 1)` (см.
// backtest/simulator.ts / src/engine/analysisEngine.ts) — та же экспозиция,
// что уже была найдена и исправлена для ZigZag/гармоник (см.
// zigzag.ts:findHarmonicZigZagPoints, docs/audit/2026-09-harmonic-module-
// synthetic-audit.md), но до этого фикса подтверждена (не исправлена) и
// здесь.
//
// Методология и валидация методологии (важно — иначе тест мог бы
// тавтологично проходить): наивное сравнение ПОЛНОГО списка зон на каждом
// сдвиге окна ложно определяет "нестабильность" там, где её на самом деле
// нет — набор зон, для которых `status !== 'broken'` (OB) / которые ещё не
// пробиты close (FVG), меняется по мере того, как скользящее окно
// открывает всё больше "будущей" относительно зоны цены — зона, ещё не
// пробитая при меньшем окне обзора, законно может оказаться пробитой при
// бОльшем. Это свойство invalidation-логики, а не баг HTF-группировки.
// Поэтому боевая проверка ниже:
//   1) берёт диапазон истории строго ДО той точки, где эта flapping-
//      неопределённость вообще может возникнуть на используемых
//      синтетических данных (см. STABLE_HORIZON_TIME) — то есть только
//      зоны, чей статус уже гарантированно не будет пересчитан на
//      оставшихся сдвигах;
//   2) сравнивает точное строковое представление (тип+top+bottom+time)
//      этого диапазона побайтово на N последовательных сдвигах.
// Методология проверена в обе стороны на этом же скрипте (см.
// docs/changelog/CHANGES_APPLIED_HTF_RESAMPLE_ALIGNMENT_20260912.md):
// с откаченным фиксом (resampleCandles без alignToAbsoluteTime) даёт 5-6
// РАЗНЫХ представлений с отличающимися time И top/bottom для одного и того
// же диапазона; с фиксом — ровно одно представление на всех сдвигах.
// ─────────────────────────────────────────────────────────────────────────

const HTF_FACTOR = 5; // должен совпадать с HTF_FACTOR в order-block-nested.ts/fvg-nested.ts
const WINDOW_SIZE = 500; // тот же порядок, что windowSize в backtest/config.ts
const N_CONSECUTIVE_SHIFTS = 25;
// Граница диапазона "устоявшейся" истории — подобрана вручную под
// buildRealisticSeries() ниже так, чтобы не попасть на зону, чей
// broken-статус ещё может измениться в пределах N_CONSECUTIVE_SHIFTS
// (см. комментарий выше). Если изменить генератор данных/сид/размер
// окна — нужно заново подобрать (см. docs/changelog).
const STABLE_HORIZON_TIME = Date.UTC(2025, 0, 1, 0, 0, 0) / 1000 + 11400; // ≈ индекс 190 сырых баров

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Реалистичный ряд M1 с периодическими импульсами (displacement для OB,
// 3-свечные гэпы для FVG) + шумовыми консолидациями между ними. Время —
// epoch-aligned (кратно 60 от начала минуты, как реальные M1-бары брокера
// — та же конвенция, что и в backtest/synthetic/harmonic-data.ts). Это
// существенно: alignToAbsoluteTime ищет свечу с `time % (factor*60) === 0`
// — при неэпохальном произвольном старте такая свеча может не встретиться
// вовсе (см. разбор в docs/changelog).
function buildRealisticSeries(bars: number, seed: number): Candle[] {
  const rnd = mulberry32(seed);
  const candles: Candle[] = [];
  let t = Date.UTC(2025, 0, 1, 0, 0, 0) / 1000;
  let price = 100;
  for (let i = 0; i < bars; i++) {
    const phase = i % 12;
    const move = phase < 4 ? (i % 24 < 12 ? 1 : -1) * (1.2 + rnd() * 0.6) : (rnd() - 0.5) * 0.3;
    const open = price;
    price += move;
    const close = price;
    const high = Math.max(open, close) + rnd() * 0.2;
    const low = Math.min(open, close) - rnd() * 0.2;
    candles.push({ time: t, open, high, low, close, volume: 100 + rnd() * 50 });
    t += 60;
  }
  return candles;
}

interface Zone {
  top: number;
  bottom: number;
  type: string;
  time: number;
}

function fmtZones(zones: Zone[]): string {
  return zones
    .slice()
    .sort((a, b) => a.time - b.time)
    .map((z) => `${z.type}[${z.bottom.toFixed(6)}-${z.top.toFixed(6)}]@${z.time}`)
    .join(' | ');
}

function runStabilityCheck(
  label: string,
  full: Candle[],
  detect: (c: Candle[]) => Zone[],
): { label: string; pass: boolean; uniqueSnapshots: string[] } {
  const snapshots = new Set<string>();
  for (let k = 0; k < N_CONSECUTIVE_SHIFTS; k++) {
    const i = WINDOW_SIZE + k;
    const windowStart = i - WINDOW_SIZE + 1;
    const window = full.slice(windowStart, i + 1);
    const zones = detect(window).filter((z) => z.time < STABLE_HORIZON_TIME);
    snapshots.add(fmtZones(zones));
  }
  return { label, pass: snapshots.size === 1, uniqueSnapshots: [...snapshots] };
}

function main(): void {
  const full = buildRealisticSeries(1200, 42);
  const checks = [
    runStabilityCheck('detectHtfObZones (order-block-nested.ts)', full, detectHtfObZones),
    runStabilityCheck('detectHtfFvgZones (fvg-nested.ts)', full, detectHtfFvgZones),
  ];

  console.log('\n' + '═'.repeat(90));
  console.log('  HTF RESAMPLE ALIGNMENT STABILITY AUDIT (Рекомендации 1 и 3, docs/audit)');
  console.log('═'.repeat(90));
  console.log(
    `Скользящее окно ${WINDOW_SIZE} баров, ${N_CONSECUTIVE_SHIFTS} последовательных сдвигов на 1 бар,` +
      ` диапазон проверки: свечи старше ${STABLE_HORIZON_TIME}.\n`,
  );

  let allPass = true;
  for (const c of checks) {
    const status = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) allPass = false;
    console.log(`[${status}] ${c.label} — уникальных снимков зон на ${N_CONSECUTIVE_SHIFTS} сдвигах: ${c.uniqueSnapshots.length}`);
    if (!c.pass) {
      console.log('  Расхождения:');
      for (const snap of c.uniqueSnapshots) console.log(`    - ${snap || '(none)'}`);
    } else {
      console.log(`  снимок: ${c.uniqueSnapshots[0] || '(none)'}`);
    }
  }

  console.log('\n' + '─'.repeat(90));
  console.log(allPass ? 'ИТОГ: PASS — HTF-зоны стабильны на скользящем окне.' : 'ИТОГ: FAIL — обнаружен дрейф HTF-зон на скользящем окне.');
  console.log('─'.repeat(90) + '\n');

  if (!allPass) process.exitCode = 1;
}

main();
