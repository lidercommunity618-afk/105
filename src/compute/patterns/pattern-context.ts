import type {
  Candle,
  MarketStructure,
  IndicatorSnapshot,
  SignalDirection,
} from '@/types/domain';
import type { SessionRegime } from '@/compute/session-regime';
import type { SmartMoneyResult } from '@/compute/indicators/smart-money';

export interface PatternContext {
  candles: Candle[];
  index: number;
  // M1 (native-timeframe) structure — used ONLY for local pattern gates
  // ("паттерн внутри локального тренда": hasPrecedingBearish/Bullish,
  // structure.trend/bos/choch checks inside the detectors themselves).
  structure: MarketStructure;
  // BUGFIX (аудит 2026-09-12, §1 "HTF-подтверждение — это не HTF, а тот же
  // таймфрейм, посчитанный дважды"): реально ресэмплированная M15+ структура
  // (computeHtfStructure, htf-structure.ts), независимая от `structure`
  // выше. Используется ИСКЛЮЧИТЕЛЬНО в htfAlignment/htfAlignmentStrict —
  // если сюда по ошибке передать `structure` (M1), гейт и "HTF"-бонус снова
  // станут одним и тем же измерением, посчитанным дважды, как и было до
  // фикса (см. подробное обоснование в htfAlignment ниже).
  htfStructure: MarketStructure;
  session: SessionRegime;
  smartMoney: SmartMoneyResult;
  indicators: IndicatorSnapshot | undefined;
}

export function sessionBoost(session: SessionRegime): number {
  if (session === 'overlap') return 1.15;
  if (session === 'london' || session === 'newyork') return 1.05;
  return 0.7;
}

// BUGFIX (аудит 2026-09-12, §1): этот параметр ДОЛЖЕН быть настоящей HTF-
// структурой (computeHtfStructure на ресэмплированных M15+ барах), а НЕ тем
// же M1 `structure`, что уже использован как хард-гейт тренда внутри каждого
// детектора (single.ts/double.ts: structure.trend !== 'down' и т.п.). До
// этого фикса оба места читали один и тот же M1 `structure`, поэтому
// "независимый HTF confluence-бонус" на практике был вторым чтением уже
// использованного гейта — см. полный разбор конкретного механизма ложных
// сигналов в full-snapshot.ts и patterns/index.ts. Шкала множителя (0.4 /
// 0.5 / 0.75 / 1.0) сознательно не меняется этим фиксом — меняется только
// источник данных, которым она параметризуется.
export function htfAlignment(htfStructure: MarketStructure, direction: SignalDirection): number {
  if (htfStructure.bos && ((direction === 'buy' && htfStructure.trend === 'up') || (direction === 'sell' && htfStructure.trend === 'down'))) return 1.0;
  if (htfStructure.choch) return 0.75;
  if (htfStructure.trend === 'range') return 0.4;
  return 0.5;
}

export function volumeFactor(ratio: number): number {
  if (ratio > 1.5) return 1.15;
  if (ratio >= 1.0) return 1.05;
  return 0.85;
}

const ATR_PROXIMITY_MULTIPLIER = 1.5;
const FRESH_OB_MAX_AGE = 20;
const FRESH_FVG_MAX_AGE = 20;

export function intervalSeconds(candles: { time: number }[]): number {
  if (candles.length < 2) return 60;
  const diff = candles[1].time - candles[0].time;
  return diff > 0 ? diff : 60;
}

export function obFvgConfluenceBonus(
  smartMoney: SmartMoneyResult,
  patternCandle: Candle,
  direction: SignalDirection,
  atrValue: number | null,
  intervalSec: number,
): number {
  const proximity = atrValue != null ? ATR_PROXIMITY_MULTIPLIER * atrValue : 0;
  const candleTime = patternCandle.time;

  const wantType = direction === 'buy' ? 'bullish' : 'bearish';

  for (const ob of smartMoney.orderBlocks) {
    if (ob.type !== wantType) continue;
    const ageInBars = intervalSec > 0 ? (candleTime - ob.time) / intervalSec : candleTime - ob.time;
    if (ageInBars < 0 || ageInBars > FRESH_OB_MAX_AGE) continue;
    const mid = (ob.top + ob.bottom) / 2;
    if (proximity > 0 && Math.abs(patternCandle.low - mid) <= proximity) return 0.1;
    if (proximity > 0 && Math.abs(patternCandle.high - mid) <= proximity) return 0.1;
  }

  for (const fvg of smartMoney.fvgs) {
    if (fvg.type !== wantType || fvg.broken) continue;
    const ageInBars = intervalSec > 0 ? (candleTime - fvg.time) / intervalSec : candleTime - fvg.time;
    if (ageInBars < 0 || ageInBars > FRESH_FVG_MAX_AGE) continue;
    const mid = (fvg.top + fvg.bottom) / 2;
    if (proximity > 0 && Math.abs(patternCandle.low - mid) <= proximity) return 0.05;
    if (proximity > 0 && Math.abs(patternCandle.high - mid) <= proximity) return 0.05;
  }

  return 0;
}

// Nearest opposite-side OB/FVG edge beyond entryPrice, in the direction of
// travel — used to place a structural take-profit for liquidity-sweep-
// reaction (ICT convention: TP on the next logical liquidity zone, not an
// arbitrary R:R multiple, see the strategy doc §8 and audit finding #6).
// "Opposite" here means opposite polarity to the *trade* direction, i.e. a
// bearish OB/FVG is the natural resistance a long trade would run into, and
// vice versa. Uses each zone's near edge (bottom for a buy target, top for a
// sell target) so the take-profit sits at the front of the zone rather than
// requiring price to close all the way through it.
//
// Deliberately does NOT apply obFvgConfluenceBonus's FRESH_OB_MAX_AGE/
// FRESH_FVG_MAX_AGE cutoff (~20 bars) here, even though it reuses the same
// zone lists. That cutoff answers a different question — "is this zone
// causally/contextually part of the setup that just fired, for a confidence
// bonus" — not "is this still a valid target". Per standard ICT/SMC theory,
// an unmitigated OB/FVG remains a legitimate draw-on-liquidity target
// regardless of how old it is; `ob.status === 'broken'`/`fvg.broken` already
// encode the thing that actually invalidates a zone as a target (price has
// since traded through it). Filtering this function by age too would
// silently exclude perfectly valid, still-live distant liquidity pools —
// this was considered and rejected during the "Реакция на снятие
// ликвидности" quality review, 2026-09-01.
export function nearestOppositeZonePrice(
  smartMoney: SmartMoneyResult,
  entryPrice: number,
  direction: SignalDirection,
): number | null {
  const wantType = direction === 'buy' ? 'bearish' : 'bullish';
  let nearest: number | null = null;
  let nearestDist = Infinity;

  const consider = (edge: number) => {
    const beyondEntry = direction === 'buy' ? edge > entryPrice : edge < entryPrice;
    if (!beyondEntry) return;
    const dist = Math.abs(edge - entryPrice);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = edge;
    }
  };

  for (const ob of smartMoney.orderBlocks) {
    if (ob.type !== wantType || ob.status === 'broken') continue;
    consider(direction === 'buy' ? ob.bottom : ob.top);
  }
  for (const fvg of smartMoney.fvgs) {
    if (fvg.type !== wantType || fvg.broken) continue;
    consider(direction === 'buy' ? fvg.bottom : fvg.top);
  }

  return nearest;
}

export interface ConfirmationResult {
  multiplier: number;
  confirmed: boolean;
  contradicted: boolean;
}

export function nextCandleConfirmation(
  patternCandle: Candle,
  confirmCandle: Candle,
  direction: SignalDirection,
): ConfirmationResult {
  const patternBodyTop = Math.max(patternCandle.open, patternCandle.close);
  const patternBodyBottom = Math.min(patternCandle.open, patternCandle.close);

  if (direction === 'buy') {
    const strongClose = confirmCandle.close > patternBodyTop;
    const weakClose = confirmCandle.close > patternCandle.high * 0.5 + patternBodyBottom * 0.5;
    const contradicted = confirmCandle.close < patternCandle.low;

    if (strongClose) return { multiplier: 1.25, confirmed: true, contradicted: false };
    if (contradicted) return { multiplier: 0, confirmed: false, contradicted: true };
    if (weakClose) return { multiplier: 1.10, confirmed: true, contradicted: false };
    return { multiplier: 0.85, confirmed: false, contradicted: false };
  }

  const strongClose = confirmCandle.close < patternBodyBottom;
  const weakClose = confirmCandle.close < patternBodyBottom * 0.5 + patternCandle.high * 0.5;
  const contradicted = confirmCandle.close > patternCandle.high;

  if (strongClose) return { multiplier: 1.25, confirmed: true, contradicted: false };
  if (contradicted) return { multiplier: 0, confirmed: false, contradicted: true };
  if (weakClose) return { multiplier: 1.10, confirmed: true, contradicted: false };
  return { multiplier: 0.85, confirmed: false, contradicted: false };
}

export function isAsiaOrClosed(session: SessionRegime): boolean {
  return session === 'sydney' || session === 'tokyo' || session === 'closed';
}

export function hasPrecedingBullish(candles: Candle[], patternIndex: number, count: number): boolean {
  let bullish = 0;
  const start = Math.max(0, patternIndex - count);
  for (let i = start; i < patternIndex; i++) {
    if (candles[i].close > candles[i].open) bullish++;
  }
  return bullish >= 3;
}

export function hasPrecedingBearish(candles: Candle[], patternIndex: number, count: number): boolean {
  let bearish = 0;
  const start = Math.max(0, patternIndex - count);
  for (let i = start; i < patternIndex; i++) {
    if (candles[i].close < candles[i].open) bearish++;
  }
  return bearish >= 3;
}

export function nearEma21InTrend(
  indicators: IndicatorSnapshot | undefined,
  candle: Candle,
  direction: SignalDirection,
): boolean {
  if (!indicators || indicators.emaFast == null) return false;
  const ema = indicators.emaFast;
  const range = candle.high - candle.low || 1e-9;
  if (direction === 'buy') {
    return Math.abs(candle.low - ema) < range * 0.3;
  }
  return Math.abs(candle.high - ema) < range * 0.3;
}

export function nearEma200(
  indicators: IndicatorSnapshot | undefined,
  candle: Candle,
): boolean {
  if (!indicators || indicators.emaSlow == null) return false;
  const range = candle.high - candle.low || 1e-9;
  return Math.abs(candle.close - indicators.emaSlow) < range * 0.5;
}

export function isNearSwingLevel(
  structure: MarketStructure,
  candle: Candle,
  atrValue: number | null,
): boolean {
  const proximity = atrValue != null ? ATR_PROXIMITY_MULTIPLIER * atrValue : 0;
  if (proximity <= 0) return false;
  if (structure.swingHigh != null && Math.abs(candle.high - structure.swingHigh) <= proximity) return true;
  if (structure.swingLow != null && Math.abs(candle.low - structure.swingLow) <= proximity) return true;
  return false;
}

// ATR-фактор: показывает, соответствует ли размах паттерна текущей волатильности.
export function atrFactor(rangeOrBody: number, atrValue: number | null): number {
  if (atrValue == null || atrValue <= 0) return 1.0; // нет данных — не штрафуем и не поощряем
  const ratio = rangeOrBody / atrValue;
  if (ratio >= 1.0) return 1.10;
  if (ratio >= 0.8) return 1.00;
  return 0.80;
}

// Фактор глубины проникновения — для Piercing Line / Dark Cloud Cover.
// penetrationRatio — доля проникновения Close Cur за середину тела Prev, в долях тела Prev
// (0.5 = минимально допустимо по геометрии, 1.0+ = близко к полному поглощению).
export function penetrationFactor(penetrationRatio: number): number {
  if (penetrationRatio > 0.75) return 1.20;
  if (penetrationRatio > 0.66) return 1.10;
  if (penetrationRatio >= 0.50) return 1.00;
  return 0.70; // < 50% не должно доходить сюда вообще — геометрия паттерна отклонит раньше
}

// Сравнение объёма второй свечи с первой — для Tweezer Bottom/Top (логика Spring/Upthrust).
export function tweezerVolumeFactor(curVolume: number, prevVolume: number): number {
  if (prevVolume <= 0) return 0.90;
  const ratio = curVolume / prevVolume;
  if (ratio > 3) return 0.75;   // возможный климакс, осторожно
  if (ratio > 1.3) return 1.15; // агрессивное поглощение
  if (ratio < 0.8) return 1.10; // истощение (Spring/Upthrust-логика)
  return 0.90;                  // объёмы примерно равны — нейтрально
}

// ─────────────────────────────────────────────────────────────────────────
// Хелперы для трёхсвечных паттернов (triple.ts): модель "минимум N из 9
// реализуемых фильтров" из методичек Morning/Evening Star и Three
// Soldiers/Crows, плюс объёмный климакс и HTF-выравнивание для Abandoned
// Baby. Fibonacci-гармоники (AB=CD/Gartley), волновая разметка Эллиотта и
// интермаркет-корреляции (DXY, кросс-пары, нефть/индексы) сознательно НЕ
// реализуются — в проекте нет данных по другим инструментам и нет модуля
// волновой разметки, а подделывать их запрещено правилами проекта (no
// mocks). Поэтому считаем только 9 реально вычислимых фильтров.
// ─────────────────────────────────────────────────────────────────────────

export interface MultiFactorFilters {
  smcOrderBlock: boolean;    // близость к свежему OB нужного типа
  smcFvg: boolean;           // близость к свежему FVG нужного типа
  liquiditySweep: boolean;   // цена вблизи structure.swingLow/swingHigh перед паттерном
  rsiZone: boolean;          // RSI в нужной зоне (<30 buy / >70 sell)
  macdTurn: boolean;         // MACD в нужную сторону относительно сигнальной линии
  emaZone: boolean;          // цена у EMA21 в нужную сторону (nearEma21InTrend)
  bollingerTouch: boolean;   // касание нужной полосы Боллинджера на свече (a)
  structureShift: boolean;   // structure.choch или structure.bos в нужном направлении
  killZoneSession: boolean;  // sessionBoost(session) >= 1.05 (Лондон/NY/overlap)
}

export function countPassedFilters(f: MultiFactorFilters): number {
  return Object.values(f).filter(Boolean).length;
}

export const MULTI_FACTOR_TOTAL = 9;
export const MIN_FILTERS_REQUIRED = 6; // порог валидности по методичке ("минимум 6 из 10", 9 из них реализуемы

// Климакс/всплеск объёма относительно SMA20 (методички "Брошенный младенец").
// ratioA/B/C = volume(candle) / averageVolume(candles, 20, indexOfCandle).
export function volumeClimaxFactor(ratioA: number, ratioB: number, ratioC: number): number {
  if (ratioA > 2.5 || ratioB > 2.0) return 1.20;
  if (ratioC > 1.5) return 1.15;
  if (ratioA < 1.0 && ratioB < 1.0 && ratioC < 1.0) return 0.70; // "объём падает на всех трёх" — не климакс
  return 0.90;
}

// RSI-фактор по зонам методичек. direction — куда торгуем.
export function rsiZoneFactor(direction: SignalDirection, rsiValue: number | null): number {
  if (rsiValue == null) return 1.0; // нет данных — не штрафуем и не поощряем
  if (direction === 'buy') {
    if (rsiValue < 30) return 1.10;
    if (rsiValue <= 35) return 1.00;
    if (rsiValue <= 50) return 0.85;
    return 0.70;
  }
  if (rsiValue > 70) return 1.10;
  if (rsiValue >= 65) return 1.00;
  if (rsiValue >= 50) return 0.85;
  return 0.70;
}

// HTF/структурный множитель по методичке "Брошенный младенец" (более строгая
// шкала, чем общий htfAlignment выше, который используют double-паттерны —
// не переиспользуем его напрямую, чтобы не менять поведение уже
// протестированных паттернов).
// BUGFIX (аудит 2026-09-12, §1): как и htfAlignment выше, этот параметр
// должен получать настоящую HTF-структуру (computeHtfStructure), а не M1
// `structure`, уже использованный в гейтах самого triple.ts.
export function htfAlignmentStrict(htfStructure: MarketStructure, direction: SignalDirection): number {
  const trendMatches = (direction === 'buy' && htfStructure.trend === 'up')
    || (direction === 'sell' && htfStructure.trend === 'down');
  if (htfStructure.bos && trendMatches) return 1.00;
  if (htfStructure.choch) return 0.90;
  if (trendMatches) return 0.70;
  return 0.45;
}

// Подтверждение "4-й свечой" (Model B из методичек Abandoned Baby) —
// отдельная от nextCandleConfirmation шкала множителей, т.к. таблицы
// Confirmation_Multiplier в методичках отличаются от логики, используемой
// double-паттернами. patternCandleC — свеча (c) паттерна.
export interface FourthCandleResult {
  multiplier: number;
  cancelled: boolean; // true => паттерн должен быть отменён (return null)
}

function isMarubozuLike(cc: Candle): boolean {
  const body = Math.abs(cc.close - cc.open);
  const range = cc.high - cc.low || 1e-9;
  return body / range >= 0.9;
}

export function fourthCandleConfirmation(
  patternCandleC: Candle,
  fourthCandle: Candle | undefined,
  direction: SignalDirection,
): FourthCandleResult {
  if (!fourthCandle) return { multiplier: 0.90, cancelled: false }; // 4-й свечи ещё нет — вход на закрытии (c), Model A
  if (direction === 'buy') {
    if (fourthCandle.close < fourthCandle.open) return { multiplier: 0, cancelled: true };
    if (fourthCandle.close > patternCandleC.high && isMarubozuLike(fourthCandle)) return { multiplier: 1.20, cancelled: false };
    if (fourthCandle.close > patternCandleC.high) return { multiplier: 1.15, cancelled: false };
    if (fourthCandle.close > patternCandleC.close) return { multiplier: 1.05, cancelled: false };
    return { multiplier: 0.90, cancelled: false };
  }
  if (fourthCandle.close > fourthCandle.open) return { multiplier: 0, cancelled: true };
  if (fourthCandle.close < patternCandleC.low && isMarubozuLike(fourthCandle)) return { multiplier: 1.20, cancelled: false };
  if (fourthCandle.close < patternCandleC.low) return { multiplier: 1.15, cancelled: false };
  if (fourthCandle.close < patternCandleC.close) return { multiplier: 1.05, cancelled: false };
  return { multiplier: 0.90, cancelled: false };
}
