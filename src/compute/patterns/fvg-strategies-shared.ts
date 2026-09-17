import type { Candle, SignalDirection, SignalStrength } from '@/types/domain';
import type { SmartMoneyFVG } from '@/compute/indicators/smart-money';

// ─────────────────────────────────────────────────────────────────────────
// Shared helpers for the 4 "Strategies on FVG" detectors (fvg-return.ts,
// fvg-breaker-block.ts, fvg-nested.ts, fvg-rejection.ts). Centralized here
// so all four strategies score confluence factors identically instead of
// four independently-drifting copies of the same math — see source
// document §5 "Система скоринга сигнала".
// ─────────────────────────────────────────────────────────────────────────

export interface ResampleOptions {
  /**
   * BUGFIX (аудит модуля "гармоники", 2026-09, Рекомендация 1): по
   * умолчанию (false, поведение без изменений) группировка идёт блоками по
   * `factor` НАЧИНАЯ С ИНДЕКСА 0 переданного массива. Это безобидно для
   * фиксированного набора данных, но production/бэктест передают в
   * detectHarmonicPattern()/detectOrderBlockNested()/detectFvgNested()
   * СКОЛЬЗЯЩЕЕ окно (`candles.slice(i - windowSize + 1, i + 1)`, см.
   * backtest/simulator.ts / src/engine/analysisEngine.ts), у которого
   * начало сдвигается на 1 свечу каждый бар. Из-за этого граница
   * HTF-группировки для ОДНИХ И ТЕХ ЖЕ абсолютных свечей "гуляет" в
   * зависимости от `windowStart % factor` — эмпирически подтверждено (не
   * только для ZigZag/гармоник, но и для detectHtfObZones/
   * detectHtfFvgZones, см. docs/audit) как систематическое "гуляние"
   * top/bottom/time уже найденных HTF-зон от бара к бару без единого
   * реального изменения цены.
   *
   * `true` отбрасывает не более (factor-1) первых свечей переданного
   * массива, чтобы группировка была привязана к АБСОЛЮТНОМУ времени свечи
   * (кратности `factor × barSeconds` от эпохи), а не к позиции внутри
   * переданного среза — тогда для одной и той же исторической свечи
   * граница группы всегда одна и та же, независимо от того, где именно
   * "разрезали" окно.
   *
   * Централизовано здесь (а не продублировано в 3 местах вызова) по
   * итогам аудита — раньше это был локальный `alignToAbsoluteHtfBoundary()`
   * только в zigzag.ts. Значение по умолчанию (false) сохраняет прежнее
   * поведение везде, где параметр не передан явно (в т.ч. в уже
   * существующих тестах, рассчитанных на фиксированные массивы без
   * скользящего окна).
   */
  alignToAbsoluteTime?: boolean;
}

/**
 * Aggregates consecutive M1 candles into synthetic higher-timeframe candles.
 * HTF approximation on 1M data — the same technique already used elsewhere
 * in this codebase (e.g. computeStructure's wider-lookback HTF approximation
 * in full-snapshot.ts, mean-reversion.ts's htfStructure) rather than faking
 * a real multi-timeframe fetch that doesn't exist in this project.
 */
export function resampleCandles(candles: Candle[], factor: number, options?: ResampleOptions): Candle[] {
  if (factor <= 1) return candles;
  const source = options?.alignToAbsoluteTime ? alignToAbsoluteHtfBoundary(candles, factor) : candles;
  const out: Candle[] = [];
  for (let i = 0; i + factor <= source.length; i += factor) {
    const chunk = source.slice(i, i + factor);
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return out;
}

/**
 * Отбрасывает не более (factor-1) первых свечей переданного массива, чтобы
 * следующая за ними группировка блоками по `factor` была привязана к
 * АБСОЛЮТНОМУ времени свечи, а не к позиции внутри среза — см.
 * `ResampleOptions.alignToAbsoluteTime` выше. Перенесено из zigzag.ts (было
 * module-private `alignToAbsoluteHtfBoundary`) без изменения логики.
 */
function alignToAbsoluteHtfBoundary(candles: Candle[], factor: number): Candle[] {
  if (factor <= 1 || candles.length < 2) return candles;
  const barSeconds = candles[1].time - candles[0].time;
  if (barSeconds <= 0) return candles;
  const groupSeconds = factor * barSeconds;
  // Ищем первую свечу, чьё время кратно groupSeconds — она станет началом
  // первой HTF-группы. Не найдено в пределах первых `factor` свечей (не
  // должно происходить на равномерной сетке свечей, но на случай
  // нестандартных данных) — не трогаем массив, чтобы не потерять больше
  // (factor-1) свечей и не обвалиться в пустой результат.
  for (let i = 0; i < factor && i < candles.length; i++) {
    if (candles[i].time % groupSeconds === 0) return i === 0 ? candles : candles.slice(i);
  }
  return candles;
}

export function fvgAgeBars(fvgTime: number, lastTime: number, intervalSec: number): number {
  if (intervalSec <= 0) return lastTime - fvgTime;
  return (lastTime - fvgTime) / intervalSec;
}

/** Unbroken, same-direction FVGs no older than maxAgeBars — doc's mandatory filter "Возраст FVG < 15 свечей". */
export function pickFreshUnbrokenFvgs(
  fvgs: SmartMoneyFVG[],
  direction: 'bullish' | 'bearish',
  lastTime: number,
  intervalSec: number,
  maxAgeBars: number,
): SmartMoneyFVG[] {
  return fvgs.filter((f) => {
    if (f.type !== direction || f.broken) return false;
    const age = fvgAgeBars(f.time, lastTime, intervalSec);
    return age >= 0 && age <= maxAgeBars;
  });
}

export function vwapSideOk(direction: SignalDirection, price: number, vwapValue: number | null): boolean {
  if (vwapValue == null) return false;
  return direction === 'buy' ? price > vwapValue : price < vwapValue;
}

/** RSI(7) confirmation zone per doc §4.2: "Bullish FVG + RSI < 40" / "Bearish FVG + RSI > 60". */
export function rsiConfirmOk(direction: SignalDirection, rsiFast: number | null): boolean {
  if (rsiFast == null) return false;
  return direction === 'buy' ? rsiFast < 40 : rsiFast > 60;
}

/** EMA50 alignment per doc §4.5. IndicatorSnapshot.emaSlow is driven by config.emaSlow (default 50). */
export function ema50AlignedOk(direction: SignalDirection, price: number, ema50: number | null): boolean {
  if (ema50 == null) return false;
  return direction === 'buy' ? price > ema50 : price < ema50;
}

/** ATR filter per doc §4.4: current bar's range should not be a volatility spike. */
export function atrNotSpiking(lastCandle: Candle, atrValue: number | null): boolean {
  if (atrValue == null || atrValue <= 0) return true; // no data — не штрафуем, но и не поощряем
  return lastCandle.high - lastCandle.low < atrValue * 2;
}

/** Ratio (0-1) of a candle's wick on the given side to its full range. */
export function wickRatio(c: Candle, side: 'lower' | 'upper'): number {
  const range = c.high - c.low || 1e-9;
  const bodyTop = Math.max(c.open, c.close);
  const bodyBottom = Math.min(c.open, c.close);
  const wick = side === 'lower' ? bodyBottom - c.low : c.high - bodyTop;
  return wick / range;
}

export interface FvgScoreInputs {
  /** Price on the correct side of EMA50 (doc §4.5). */
  emaAligned: boolean;
  /** Price on the correct side of session VWAP (doc §4.3). */
  vwapAligned: boolean;
  /** RSI(7) in the confirmation zone (doc §4.2). */
  rsiConfirmed: boolean;
  /** Strategy-specific volume confirmation (doc §4.1 / per-strategy rule). */
  volumeConfirmed: boolean;
  /** Structural/HTF/OB confluence — meaning is strategy-specific (doc §3, Strategy C priority factor). */
  confluenceBonus: boolean;
  /** ATR not spiking relative to its own average (doc §4.4). */
  atrNormal: boolean;
  /** Kill Zone session — London/NewYork/overlap (doc §"Сессионный аналитик"). */
  sessionBoosted: boolean;
}

// Doc §5 scoring model, adapted 1:1 except for the "Отсутствие близких
// новостей" (+10) component, which is intentionally omitted: this project
// has no economic-calendar data source, and fabricating one would violate
// the project's no-mock-data policy (see triple.ts's identical omission of
// Fibonacci/Elliott/intermarket factors for the same reason).
export const FVG_SCORE_WEIGHTS = {
  base: 20,
  ema: 15,
  vwap: 15,
  rsi: 10,
  volume: 10,
  confluence: 15,
  atr: 5,
  session: 5,
} as const;

export const FVG_SCORE_MAX =
  FVG_SCORE_WEIGHTS.base +
  FVG_SCORE_WEIGHTS.ema +
  FVG_SCORE_WEIGHTS.vwap +
  FVG_SCORE_WEIGHTS.rsi +
  FVG_SCORE_WEIGHTS.volume +
  FVG_SCORE_WEIGHTS.confluence +
  FVG_SCORE_WEIGHTS.atr +
  FVG_SCORE_WEIGHTS.session; // 95

// Doc §5: "Сигнал выдаётся при скоре >= 70" out of its 100-point scale
// (of which the omitted news component was worth 10) — 70/90 achievable
// points ≈ 78%, scaled onto our 95-point max (which adds the session
// factor doc §5 doesn't score explicitly but §"Сессионный аналитик"
// clearly treats as a quality gate elsewhere in the document).
export const FVG_SCORE_MIN_ENTRY = Math.round(FVG_SCORE_MAX * 0.7); // 67

export function scoreFvgSignal(inputs: FvgScoreInputs): number {
  let score = FVG_SCORE_WEIGHTS.base;
  if (inputs.emaAligned) score += FVG_SCORE_WEIGHTS.ema;
  if (inputs.vwapAligned) score += FVG_SCORE_WEIGHTS.vwap;
  if (inputs.rsiConfirmed) score += FVG_SCORE_WEIGHTS.rsi;
  if (inputs.volumeConfirmed) score += FVG_SCORE_WEIGHTS.volume;
  if (inputs.confluenceBonus) score += FVG_SCORE_WEIGHTS.confluence;
  if (inputs.atrNormal) score += FVG_SCORE_WEIGHTS.atr;
  if (inputs.sessionBoosted) score += FVG_SCORE_WEIGHTS.session;
  return score;
}

export function strengthForFvgScore(confidence: number): SignalStrength {
  if (confidence >= 0.75) return 'strong';
  if (confidence >= 0.5) return 'moderate';
  return 'weak';
}
