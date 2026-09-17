import type { Candle } from '@/types/domain';

// ─────────────────────────────────────────────────────────────────────────
// Синтетический генератор данных со встроенными гармоническими паттернами
// (Gartley / Bat / Crab / Butterfly / AB=CD) для аудита
// src/compute/patterns/harmonic-pattern.ts + src/compute/indicators/zigzag.ts.
//
// Идея: строим ЦЕНУ (не индикаторы) как последовательность прямолинейных
// "ног" X→A→B→C→D с ТОЧНО заданными коэффициентами Фибоначчи (внутри
// допуска fibTolerancePct детектора, с запасом — см. RATIO_TABLE ниже), а
// между паттернами вставляем: (1) "мост" — leg, который одновременно и
// подтверждает точку D предыдущего паттерна (переводя тренд в обратную
// сторону), и формирует точку X следующего, и (2) плоский шумовой
// консолидационный участок с амплитудой значительно ниже
// minLegAtr×ATR-порога ZigZag, чтобы не порождать паразитных pivot-точек.
//
// Ground truth (HarmonicGroundTruth[]) хранит точные индексы/цены/время
// X-A-B-C-D каждого внедрённого паттерна — backtest/harmonic-audit.ts
// сверяет с ним результат detectHarmonicPattern() (прямая проверка
// детектора) и результат полного simulate()-пайплайна (эффект на реальные
// сигналы/сделки).
// ─────────────────────────────────────────────────────────────────────────

export type XabcdType = 'gartley' | 'bat' | 'crab' | 'butterfly';
export type HarmonicKind = XabcdType | 'ab-cd';

export interface HarmonicGroundTruth {
  kind: HarmonicKind;
  /** +1 = bullish (X/B/D — минимумы, A/C — максимумы, ожидаемый сигнал buy). -1 = bearish (зеркально, sell). */
  orientation: 1 | -1;
  expectedDirection: 'buy' | 'sell';
  points: {
    x: { index: number; time: number; price: number };
    a: { index: number; time: number; price: number };
    b: { index: number; time: number; price: number };
    c: { index: number; time: number; price: number };
    d: { index: number; time: number; price: number };
  };
  /** Первый индекс свечи ПОСЛЕ D, на которой цена уже отошла от D достаточно, чтобы ZigZag мог его подтвердить (граница поиска для аудита). */
  confirmationSearchEnd: number;
}

export interface SyntheticHarmonicDataset {
  candles: Candle[];
  patterns: HarmonicGroundTruth[];
  /** Параметры генерации — нужны audit-скрипту (windowSize и т.п. должны быть с запасом больше maxSpanBars). */
  meta: {
    barSeconds: number;
    legBars: number;
    bridgeBars: number;
    maxSpanBars: number; // largest X..D distance across all patterns
  };
}

// ── Детерминированный PRNG (mulberry32) — воспроизводимость между запусками ──
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function random(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Коэффициенты Фибоначчи, подобранные так, чтобы ОДНОВРЕМЕННО (с запасом
// от границ допуска, см. docs/audit — числа получены решением
// cd = ad - ab + bc для целевого ad_xa каждого паттерна, затем bc_ab
// выбран так, чтобы и bc_ab, и результирующий cd_bc оставались внутри
// допустимого диапазона с запасом ≥ 30% ширины диапазона) удовлетворять
// всем 4 проверкам XABCD_RULES в harmonic-pattern.ts: ab_xa, bc_ab, cd_bc,
// ad_xa. Гарантирует confidence ≈ 1.0 на "идеальном" (безшумовом) паттерне.
const RATIO_TABLE: Record<XabcdType, { ab_xa: number; bc_ab: number; cd_bc: number; ad_xa: number }> = {
  gartley: { ab_xa: 0.618, bc_ab: 0.6718, cd_bc: 1.4047, ad_xa: 0.786 },
  bat: { ab_xa: 0.5, bc_ab: 0.6592, cd_bc: 2.1711, ad_xa: 0.886 },
  crab: { ab_xa: 0.618, bc_ab: 0.7348, cd_bc: 3.2021, ad_xa: 1.618 },
  butterfly: { ab_xa: 0.786, bc_ab: 0.6466, cd_bc: 1.9523, ad_xa: 1.27 },
};
// AB=CD: bc_ab в середине допустимого диапазона [0.382,0.886], cd/ab = 1.0
// (точное равенство длин AB и CD — определение паттерна).
const AB_CD_RATIOS = { bc_ab: 0.634, cd_ab: 1.0 };

interface LegPoint {
  index: number;
  time: number;
  price: number;
}

/**
 * Строит `bars` свечей, линейно (с малым шумом внутри бара, не выходящим
 * за пределы [startPrice, endPrice]) ведущих цену от startPrice к
 * endPrice. Последняя свеча заканчивается РОВНО в endPrice без верхнего/
 * нижнего "перехлёста" в направлении движения — это гарантирует, что
 * endPrice остаётся истинным экстремумом ноги (а не какая-то шумовая
 * свеча внутри), то есть ZigZag зарегистрирует pivot ровно там, где
 * заложено ground truth.
 */
function makeLegCandles(
  startPrice: number,
  endPrice: number,
  bars: number,
  startTime: number,
  barSeconds: number,
  rng: () => number,
): Candle[] {
  const candles: Candle[] = [];
  const step = (endPrice - startPrice) / bars;
  const goingUp = endPrice >= startPrice;
  let openP = startPrice;
  for (let i = 0; i < bars; i++) {
    const isLast = i === bars - 1;
    const closeP = isLast ? endPrice : startPrice + step * (i + 1);
    // Шум внутри бара — доля от размера шага, всегда << минимального
    // ATR-порога ZigZag (шаг ноги много меньше её общего размаха, а шум —
    // малая доля шага), поэтому не создаёт паразитных экстремумов внутри
    // ноги. На последней свече не даём шуму выйти ЗА endPrice в сторону
    // движения (иначе экстремум ноги сместился бы с endPrice на wick).
    const noiseAmp = Math.abs(step) * 0.12;
    const wickFwd = isLast ? 0 : rng() * noiseAmp;
    const wickBack = rng() * noiseAmp;
    const hi = Math.max(openP, closeP) + (goingUp ? wickFwd : wickBack);
    const lo = Math.min(openP, closeP) - (goingUp ? wickBack : wickFwd);
    candles.push({
      time: startTime + i * barSeconds,
      open: openP,
      high: hi,
      low: lo,
      close: closeP,
      volume: 80 + rng() * 40,
    });
    openP = closeP;
  }
  return candles;
}

/** Плоский шумовой (консолидационный) участок вокруг `price` — амплитуда сильно меньше ATR-порога ZigZag, pivot внутри не образуется. */
function makeFlatCandles(
  price: number,
  bars: number,
  startTime: number,
  barSeconds: number,
  amplitudeFrac: number,
  rng: () => number,
): Candle[] {
  const candles: Candle[] = [];
  let cur = price;
  const amp = price * amplitudeFrac;
  for (let i = 0; i < bars; i++) {
    const drift = (rng() - 0.5) * amp * 0.3;
    const next = price + drift; // возврат к базовой цене (не накопительное блуждание)
    const hi = Math.max(cur, next) + rng() * amp * 0.2;
    const lo = Math.min(cur, next) - rng() * amp * 0.2;
    candles.push({
      time: startTime + i * barSeconds,
      open: cur,
      high: hi,
      low: lo,
      close: next,
      volume: 60 + rng() * 30,
    });
    cur = next;
  }
  return candles;
}

export interface GenerateOptions {
  seed?: number;
  basePrice?: number;
  barSeconds?: number;
  legBars?: number;
  bridgeBars?: number;
  gapBars?: number;
  warmupBars?: number;
  trailingBars?: number;
  /** Размер ноги XA как доля от текущей цены. */
  xaFraction?: number;
  /** Порядок паттернов; по умолчанию — все 5 геометрий, bull затем bear. */
  sequence?: Array<{ kind: HarmonicKind; orientation: 1 | -1 }>;
}

const DEFAULT_SEQUENCE: Array<{ kind: HarmonicKind; orientation: 1 | -1 }> = [
  { kind: 'gartley', orientation: 1 },
  { kind: 'gartley', orientation: -1 },
  { kind: 'bat', orientation: 1 },
  { kind: 'bat', orientation: -1 },
  { kind: 'crab', orientation: 1 },
  { kind: 'crab', orientation: -1 },
  { kind: 'butterfly', orientation: 1 },
  { kind: 'butterfly', orientation: -1 },
  { kind: 'ab-cd', orientation: 1 },
  { kind: 'ab-cd', orientation: -1 },
];

export function generateSyntheticHarmonicDataset(opts: GenerateOptions = {}): SyntheticHarmonicDataset {
  const seed = opts.seed ?? 42;
  const basePrice = opts.basePrice ?? 50000;
  const barSeconds = opts.barSeconds ?? 60;
  const legBars = opts.legBars ?? 45;
  const bridgeBars = opts.bridgeBars ?? 35;
  // BUGFIX (аудит, см. backtest/harmonic-audit.ts): изначально здесь был
  // gapBars=15 (плоский шумовой участок ПОСЛЕ D, центрированный ровно на
  // цене D). Поскольку он центрирован точно на dPrice, а не смещён в
  // сторону уже начавшегося разворота, его шум мог случайным чиком
  // превысить саму точку D (пока ZigZag ещё не развернулся — extremePrice
  // всё ещё отслеживает пик), порождая ложную вторичную pivot-точку чуть
  // позже и чуть дальше настоящего D — что ломало сверку с ground truth
  // (детектор при этом находил ВАЛИДНУЮ геометрию, просто по этой
  // вторичной точке, а не по заложенной). Мост (bridge) сам по себе даёт
  // достаточное разделение между паттернами — отдельный gap не нужен.
  const gapBars = opts.gapBars ?? 0;
  const warmupBars = opts.warmupBars ?? 600;
  const trailingBars = opts.trailingBars ?? 200;
  const xaFraction = opts.xaFraction ?? 0.05;
  const sequence = opts.sequence ?? DEFAULT_SEQUENCE;

  const rng = mulberry32(seed);
  const startTime = Date.UTC(2025, 0, 1, 0, 0, 0) / 1000;

  const allCandles: Candle[] = [];
  const patterns: HarmonicGroundTruth[] = [];

  let cursorTime = startTime;
  let cursorPrice = basePrice;

  const pushCandles = (cs: Candle[]) => {
    allCandles.push(...cs);
    cursorTime += cs.length * barSeconds;
  };

  // Начальный "прогрев" — даёт индикаторам (ATR/EMA/MACD/...) и windowSize
  // достаточно истории до первого встроенного паттерна.
  pushCandles(makeFlatCandles(cursorPrice, warmupBars, cursorTime, barSeconds, 0.004, rng));

  let maxSpan = 0;

  for (const { kind, orientation } of sequence) {
    const xa = cursorPrice * xaFraction * (0.9 + rng() * 0.2); // ±10% вариативность масштаба ноги
    const bridgeTargetX = cursorPrice - orientation * xa * 0.9; // мост подходит к X С ПРОТИВОПОЛОЖНОЙ стороны от X→A

    // Мост: подтверждает D предыдущего паттерна (если был) и формирует X текущего.
    const bridge = makeLegCandles(cursorPrice, bridgeTargetX, bridgeBars, cursorTime, barSeconds, rng);
    pushCandles(bridge);
    cursorPrice = bridgeTargetX;

    const xPoint: LegPoint = { index: allCandles.length - 1, time: allCandles[allCandles.length - 1].time, price: cursorPrice };

    // ab_xa не используется для ab-cd (нет точки X-геометрии в matchAbCd);
    // cd для ab-cd считается напрямую как AB_CD_RATIOS.cd_ab * abLen ниже
    // (matchAbCd сравнивает cd/ab, а не cd/bc, в отличие от XABCD_RULES).
    const ab_xa = kind === 'ab-cd' ? 1 : RATIO_TABLE[kind].ab_xa;
    const bc_ab = kind === 'ab-cd' ? AB_CD_RATIOS.bc_ab : RATIO_TABLE[kind].bc_ab;
    const cd_bc = kind === 'ab-cd' ? 0 : RATIO_TABLE[kind].cd_bc;

    const abLen = ab_xa * xa;
    const aPrice = xPoint.price + orientation * xa;
    const bPrice = aPrice - orientation * abLen;
    const bcLen = bc_ab * abLen;
    const cPrice = bPrice + orientation * bcLen;
    const cdLen = kind === 'ab-cd' ? AB_CD_RATIOS.cd_ab * abLen : cd_bc * bcLen;
    const dPrice = cPrice - orientation * cdLen;

    const legXA = makeLegCandles(xPoint.price, aPrice, legBars, cursorTime, barSeconds, rng);
    pushCandles(legXA);
    const aPoint: LegPoint = { index: allCandles.length - 1, time: allCandles[allCandles.length - 1].time, price: aPrice };

    const legAB = makeLegCandles(aPrice, bPrice, legBars, cursorTime, barSeconds, rng);
    pushCandles(legAB);
    const bPoint: LegPoint = { index: allCandles.length - 1, time: allCandles[allCandles.length - 1].time, price: bPrice };

    const legBC = makeLegCandles(bPrice, cPrice, legBars, cursorTime, barSeconds, rng);
    pushCandles(legBC);
    const cPoint: LegPoint = { index: allCandles.length - 1, time: allCandles[allCandles.length - 1].time, price: cPrice };

    const legCD = makeLegCandles(cPrice, dPrice, legBars, cursorTime, barSeconds, rng);
    pushCandles(legCD);
    const dPoint: LegPoint = { index: allCandles.length - 1, time: allCandles[allCandles.length - 1].time, price: dPrice };

    maxSpan = Math.max(maxSpan, dPoint.index - xPoint.index);

    patterns.push({
      kind,
      orientation,
      expectedDirection: orientation === 1 ? 'buy' : 'sell',
      points: { x: xPoint, a: aPoint, b: bPoint, c: cPoint, d: dPoint },
      confirmationSearchEnd: dPoint.index + bridgeBars + gapBars,
    });

    cursorPrice = dPrice;

    // Небольшая пауза (плоский шум) перед следующим мостом — снижает шанс,
    // что скользящие окна детектора (evaluateWindow×3, см.
    // detectHarmonicPattern) случайно склеят хвост этого паттерна с
    // началом следующего.
    if (gapBars > 0) {
      pushCandles(makeFlatCandles(cursorPrice, gapBars, cursorTime, barSeconds, 0.003, rng));
    }
  }

  // Финальный "мост" подтверждает D последнего паттерна — направление
  // подтверждающего движения ДОЛЖНО совпадать со знаком orientation
  // последнего паттерна (не противоположно ему): нога C→D всегда идёт в
  // направлении `-orientation` (см. dPrice = cPrice - orientation*cdLen
  // выше), поэтому разворот, подтверждающий D как экстремум, идёт в
  // направлении `+orientation`. (BUGFIX, аудит: здесь стоял противоположный
  // знак — для последнего паттерна в DEFAULT_SEQUENCE, оканчивающегося на
  // orientation=-1 (ab-cd, sell), это давало движение ВВЕРХ от D-high вместо
  // вниз, то есть цена НЕ уходила от D в нужную сторону и ZigZag никогда не
  // подтверждал его как pivot — детектор корректно не находил паттерн,
  // потому что его геометрия в свечах была фактически не завершена.
  // Совпадающий знак не был замечен раньше для промежуточных мостов между
  // паттернами только потому, что DEFAULT_SEQUENCE строго чередует
  // orientation на каждом шаге, и формула для НИХ использует orientation
  // СЛЕДУЮЩЕГО паттерна, а не текущего — см. bridgeTargetX выше.)
  const lastOrientation = sequence[sequence.length - 1].orientation;
  const finalBridge = makeLegCandles(
    cursorPrice,
    cursorPrice + lastOrientation * cursorPrice * 0.03,
    bridgeBars,
    cursorTime,
    barSeconds,
    rng,
  );
  pushCandles(finalBridge);

  pushCandles(makeFlatCandles(allCandles[allCandles.length - 1].close, trailingBars, cursorTime, barSeconds, 0.004, rng));

  return {
    candles: allCandles,
    patterns,
    meta: { barSeconds, legBars, bridgeBars, maxSpanBars: maxSpan },
  };
}
