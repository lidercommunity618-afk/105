import type { Candle, PatternResult, SignalStrength, SignalDirection, MarketStructure, IndicatorSnapshot } from '@/types/domain';
import { clamp01, averageVolume, averageBody } from '@/compute/indicators/helpers';
import { rsi as calcRsi } from '@/compute/indicators/rsi';
import type { SessionRegime } from '@/compute/session-regime';
import type { SmartMoneyResult } from '@/compute/indicators/smart-money';
import {
  sessionBoost,
  isAsiaOrClosed,
  hasPrecedingBullish,
  hasPrecedingBearish,
  nearEma21InTrend,
  isNearSwingLevel,
  obFvgConfluenceBonus,
  atrFactor,
  intervalSeconds,
  countPassedFilters,
  MIN_FILTERS_REQUIRED,
  MULTI_FACTOR_TOTAL,
  volumeClimaxFactor,
  rsiZoneFactor,
  htfAlignmentStrict,
  fourthCandleConfirmation,
  type MultiFactorFilters,
} from './pattern-context';

// Контекст для трёхсвечных паттернов. Свечи паттерна берутся как
// a = candles[length-4], b = candles[length-3], c = candles[length-2],
// а candles[length-1] — "4-я свеча" подтверждения (Model B из методичек).
export interface TripleContext {
  candles: Candle[];
  // M1-структура — только для локальных гейтов тренда внутри детекторов.
  structure: MarketStructure;
  // BUGFIX (аудит 2026-09-12, §1): настоящая ресэмплированная HTF-структура
  // (computeHtfStructure), независимая от M1 `structure` выше — используется
  // ИСКЛЮЧИТЕЛЬНО в htfAlignmentStrict (Abandoned Baby). См. подробности в
  // pattern-context.ts/htfAlignmentStrict.
  htfStructure: MarketStructure;
  session: SessionRegime;
  smartMoney: SmartMoneyResult;
  indicators: IndicatorSnapshot | undefined;
}

const TREND_LOOKBACK = 7;
const TREND_MIN_COUNT = 5;

// BUGFIX (аудит 2026-09-12, §3.1 "Abandoned Baby — жёсткий гэп не
// соответствует микроструктуре непрерывных рынков"): классический
// буквальный ценовой гэп (b.high < a.low между соседними закрытыми
// свечами) определён для рынков с настоящими ночными разрывами
// (акции/дневные графики). На форекс (24/5, без ночного гэпа внутри
// недели) и крипто (24/7) на внутридневных таймфреймах (1m-4h, см.
// src/types/domain.ts) такой буквальный разрыв практически никогда не
// встречается физически — паттерн логически корректен, но статистически
// почти никогда не проходит геометрию на реальных данных, что эквивалентно
// скрытому отключению фичи на большинстве целевых инструментов/ТФ
// приложения.
//
// Приводим к тому же ATR-масштабированному принципу, что уже используется
// в проекте для FVG-displacement (см. fvg-core.ts, MIN_DISPLACEMENT_ATR_MULTIPLE):
// "разрыв" засчитывается, если расстояние между тенями не меньше
// -ABANDONED_BABY_GAP_ATR_TOLERANCE × ATR — то есть либо это настоящий
// буквальный гэп (displacement > 0, всегда проходит), либо тени слегка
// перекрываются, но перекрытие мало относительно текущей волатильности
// инструмента. Это не сужение порога, а замена источника его нормировки
// (абсолютная цена → ATR), устраняющая системную непригодность гейта для
// форекс/крипто-таймфреймов, не трогая саму идею "резкое однонаправленное
// отделение от предыдущего диапазона".
//
// ВАЖНО: значение 0.10 — консервативная начальная константа (сознательно
// небольшая, а не откалиброванный на истории порог — в этой сессии нет
// доступа к npm run backtest — см. Аудит.docx §0/§3.1/§7). Специально
// выбрана достаточно малой, чтобы не "перетянуть" гейт в другую крайность
// (пропускать любое сколь угодно большое перекрытие как "гэп"), и при этом
// не совпадать с уже существующими в тестовом наборе граничными случаями
// "явно не-гэп" (см. patterns.test.ts: overlap ровно -0.15×ATR в обоих
// направлениях — сознательно остаётся отклонённым и при этой константе).
// Требует отдельного прогона на реальной истории форекс и крипто раздельно,
// прежде чем считать финальной — как и остальные калибруемые пороги в
// этом файле.
const ABANDONED_BABY_GAP_ATR_TOLERANCE = 0.10;

// upperEdge/lowerEdge — края теней, между которыми ожидается разрыв
// (upperEdge выше lowerEdge при настоящем гэпе). Возвращает true и для
// буквального гэпа, и для ATR-эквивалента (небольшое перекрытие теней,
// малое относительно волатильности).
function hasAtrNormalizedGap(upperEdge: number, lowerEdge: number, atrValue: number | null): boolean {
  const displacement = upperEdge - lowerEdge; // > 0 = буквальный гэп, < 0 = перекрытие теней
  if (atrValue == null || atrValue <= 0) return displacement > 0; // нет ATR — прежнее строгое поведение
  return displacement >= -ABANDONED_BABY_GAP_ATR_TOLERANCE * atrValue;
}

function strengthForConfidence(confidence: number): SignalStrength {
  if (confidence >= 0.75) return 'strong';
  if (confidence >= 0.5) return 'moderate';
  return 'weak';
}

// Точный подсчёт медвежьих/бычьих свечей в окне [patternIndex - lookback, patternIndex),
// строже дефолтного порога (>=3 из N) в hasPrecedingBullish/Bearish.
function countBearish(candles: Candle[], patternIndex: number, lookback: number): number {
  const start = Math.max(0, patternIndex - lookback);
  let n = 0;
  for (let i = start; i < patternIndex; i++) {
    if (candles[i].close < candles[i].open) n++;
  }
  return n;
}

function countBullish(candles: Candle[], patternIndex: number, lookback: number): number {
  const start = Math.max(0, patternIndex - lookback);
  let n = 0;
  for (let i = start; i < patternIndex; i++) {
    if (candles[i].close > candles[i].open) n++;
  }
  return n;
}

function confluenceList(filters: MultiFactorFilters): string[] {
  return Object.entries(filters)
    .filter(([, v]) => v)
    .map(([k]) => k);
}

function macdTurn(indicators: IndicatorSnapshot | undefined, direction: SignalDirection): boolean {
  if (!indicators || indicators.macd == null || indicators.macdSignal == null) return false;
  return direction === 'buy' ? indicators.macd > indicators.macdSignal : indicators.macd < indicators.macdSignal;
}

function bollingerTouch(indicators: IndicatorSnapshot | undefined, candleA: Candle, direction: SignalDirection): boolean {
  if (!indicators) return false;
  if (direction === 'buy') return indicators.bollingerLower != null && candleA.low <= indicators.bollingerLower;
  return indicators.bollingerUpper != null && candleA.high >= indicators.bollingerUpper;
}

function structureShift(structure: MarketStructure, direction: SignalDirection): boolean {
  if (structure.choch) return true;
  return structure.bos && ((direction === 'buy' && structure.trend === 'up') || (direction === 'sell' && structure.trend === 'down'));
}

function buildFilters(
  ctx: TripleContext,
  candleA: Candle,
  candleC: Candle,
  direction: SignalDirection,
  rsiValue: number | null,
): MultiFactorFilters {
  const { structure, session, smartMoney, indicators, candles } = ctx;
  const atrValue = indicators?.atr ?? null;
  const obFvgBonus = obFvgConfluenceBonus(smartMoney, candleC, direction, atrValue, intervalSeconds(candles));
  return {
    smcOrderBlock: obFvgBonus >= 0.1,
    smcFvg: obFvgBonus > 0 && obFvgBonus < 0.1,
    liquiditySweep: isNearSwingLevel(structure, candleA, atrValue),
    rsiZone: direction === 'buy' ? (rsiValue != null && rsiValue < 35) : (rsiValue != null && rsiValue > 65),
    macdTurn: macdTurn(indicators, direction),
    emaZone: nearEma21InTrend(indicators, candleC, direction),
    bollingerTouch: bollingerTouch(indicators, candleA, direction),
    structureShift: structureShift(structure, direction),
    killZoneSession: sessionBoost(session) >= 1.05,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Morning Star / Evening Star
// ─────────────────────────────────────────────────────────────────────────

export function detectMorningStar(ctx: TripleContext): PatternResult | null {
  const { candles, session, indicators } = ctx;
  const n = candles.length;
  if (n < 4 + TREND_LOOKBACK) return null;
  const idx = n - 4;
  const a = candles[idx];
  const b = candles[idx + 1];
  const c = candles[idx + 2];

  if (countBearish(candles, idx, TREND_LOOKBACK) < TREND_MIN_COUNT) return null;
  if (!hasPrecedingBearish(candles, idx, TREND_LOOKBACK)) return null;

  const bodyA = Math.abs(a.close - a.open);
  const bodyB = Math.abs(b.close - b.open);
  const bodyC = Math.abs(c.close - c.open);
  const rangeA = a.high - a.low || 1e-9;
  const avgBody20 = averageBody(candles, 20, idx);

  if (a.close >= a.open) return null;
  if (avgBody20 > 0 && bodyA < 2 * avgBody20) return null;
  const lowerWickA = Math.min(a.open, a.close) - a.low;
  if (lowerWickA > 0.30 * rangeA) return null;

  if (bodyB > 0.5 * bodyA) return null;

  if (c.close <= c.open) return null;
  if (bodyC < 0.7 * bodyA) return null;
  const midpointA = (a.open + a.close) / 2;
  if (c.close <= midpointA) return null; // инвалидатор: обязательное закрытие выше 50% тела (a)

  if (isAsiaOrClosed(session)) return null;

  const volC = averageVolume(candles, 20, idx + 2);
  const volumeRatioC = volC > 0 ? c.volume / volC : 0;
  if (volumeRatioC < 1.3) return null;

  const rsiSeries = calcRsi(candles.map((cc) => cc.close), 14);
  const rsiValue = rsiSeries[idx + 2];

  const filters = buildFilters(ctx, a, c, 'buy', rsiValue);
  if (countPassedFilters(filters) < MIN_FILTERS_REQUIRED) return null;

  const closeDepthIntoBodyA = bodyA > 0 ? (c.close - a.close) / bodyA : 0;
  const base = clamp01(
    0.35
    + Math.min(0.20, Math.max(0, closeDepthIntoBodyA - 0.5) * 0.6)
    + Math.min(0.15, Math.max(0, bodyC / (bodyA || 1e-9) - 0.7) * 0.5),
  );
  const filtersRatio = countPassedFilters(filters) / MULTI_FACTOR_TOTAL;
  const confidence = clamp01(
    base
    * (0.6 + 0.4 * filtersRatio)
    * sessionBoost(session)
    * rsiZoneFactor('buy', rsiValue)
    * atrFactor(bodyC, indicators?.atr ?? null),
  );
  if (confidence < 0.5) return null;

  return {
    name: 'morning-star',
    direction: 'buy',
    confidence,
    strength: strengthForConfidence(confidence),
    time: c.time,
    volumeConfirmed: volumeRatioC >= 1.3,
    confluenceFactors: confluenceList(filters),
  };
}

export function detectEveningStar(ctx: TripleContext): PatternResult | null {
  const { candles, session, indicators } = ctx;
  const n = candles.length;
  if (n < 4 + TREND_LOOKBACK) return null;
  const idx = n - 4;
  const a = candles[idx];
  const b = candles[idx + 1];
  const c = candles[idx + 2];

  if (countBullish(candles, idx, TREND_LOOKBACK) < TREND_MIN_COUNT) return null;
  if (!hasPrecedingBullish(candles, idx, TREND_LOOKBACK)) return null;

  const bodyA = Math.abs(a.close - a.open);
  const bodyB = Math.abs(b.close - b.open);
  const bodyC = Math.abs(c.close - c.open);
  const rangeA = a.high - a.low || 1e-9;
  const avgBody20 = averageBody(candles, 20, idx);

  if (a.close <= a.open) return null;
  if (avgBody20 > 0 && bodyA < 2 * avgBody20) return null;
  const upperWickA = a.high - Math.max(a.open, a.close);
  if (upperWickA > 0.30 * rangeA) return null;

  if (bodyB > 0.5 * bodyA) return null;

  if (c.close >= c.open) return null;
  if (bodyC < 0.7 * bodyA) return null;
  const midpointA = (a.open + a.close) / 2;
  if (c.close >= midpointA) return null; // инвалидатор: обязательное закрытие ниже 50% тела (a)

  if (isAsiaOrClosed(session)) return null;

  const volC = averageVolume(candles, 20, idx + 2);
  const volumeRatioC = volC > 0 ? c.volume / volC : 0;
  if (volumeRatioC < 1.3) return null;

  const rsiSeries = calcRsi(candles.map((cc) => cc.close), 14);
  const rsiValue = rsiSeries[idx + 2];

  const filters = buildFilters(ctx, a, c, 'sell', rsiValue);
  if (countPassedFilters(filters) < MIN_FILTERS_REQUIRED) return null;

  const closeDepthIntoBodyA = bodyA > 0 ? (a.close - c.close) / bodyA : 0;
  const base = clamp01(
    0.35
    + Math.min(0.20, Math.max(0, closeDepthIntoBodyA - 0.5) * 0.6)
    + Math.min(0.15, Math.max(0, bodyC / (bodyA || 1e-9) - 0.7) * 0.5),
  );
  const filtersRatio = countPassedFilters(filters) / MULTI_FACTOR_TOTAL;
  const confidence = clamp01(
    base
    * (0.6 + 0.4 * filtersRatio)
    * sessionBoost(session)
    * rsiZoneFactor('sell', rsiValue)
    * atrFactor(bodyC, indicators?.atr ?? null),
  );
  if (confidence < 0.5) return null;

  return {
    name: 'evening-star',
    direction: 'sell',
    confidence,
    strength: strengthForConfidence(confidence),
    time: c.time,
    volumeConfirmed: volumeRatioC >= 1.3,
    confluenceFactors: confluenceList(filters),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Three White Soldiers / Three Black Crows
// ─────────────────────────────────────────────────────────────────────────

export function detectThreeWhiteSoldiers(ctx: TripleContext): PatternResult | null {
  const { candles, session, indicators } = ctx;
  const n = candles.length;
  if (n < 4 + TREND_LOOKBACK) return null;
  const idx = n - 4;
  const a = candles[idx];
  const b = candles[idx + 1];
  const c = candles[idx + 2];

  if (countBearish(candles, idx, TREND_LOOKBACK) < TREND_MIN_COUNT) return null;
  if (!hasPrecedingBearish(candles, idx, TREND_LOOKBACK)) return null;

  if (a.close <= a.open || b.close <= b.open || c.close <= c.open) return null;
  if (b.open < Math.min(a.open, a.close) || b.open > Math.max(a.open, a.close)) return null;
  if (c.open < Math.min(b.open, b.close) || c.open > Math.max(b.open, b.close)) return null;
  if (b.close <= a.close || c.close <= b.close) return null;

  const bodyA = Math.abs(a.close - a.open);
  const bodyB = Math.abs(b.close - b.open);
  const bodyC = Math.abs(c.close - c.open);
  const rangeA = a.high - a.low || 1e-9;
  const rangeB = b.high - b.low || 1e-9;
  const rangeC = c.high - c.low || 1e-9;

  const upperWickA = a.high - Math.max(a.open, a.close);
  const upperWickB = b.high - Math.max(b.open, b.close);
  if (upperWickA > 0.30 * bodyA || upperWickB > 0.30 * bodyB) return null;
  if ((c.high - c.close) > 0.10 * rangeC) return null; // закрытие (c) в верхних 10% диапазона
  if (upperWickA > 0.15 * bodyA && upperWickB > 0.15 * bodyB) return null;

  // Climax/exhaustion фильтр
  const atrValue = indicators?.atr ?? null;
  const climaxThreshold = atrValue ?? ((rangeA + rangeB + rangeC) / 3);
  const isClimax = bodyA >= 3 * climaxThreshold && bodyB >= 3 * climaxThreshold && bodyC >= 3 * climaxThreshold
    && (rangeA - bodyA) < 0.05 * bodyA && (rangeB - bodyB) < 0.05 * bodyB && (rangeC - bodyC) < 0.05 * bodyC;
  if (isClimax) return null;

  const avgBody20 = averageBody(candles, 20, idx);
  if (avgBody20 > 0 && bodyA < 1.5 * avgBody20) return null;

  const volA = averageVolume(candles, 20, idx);
  const volB = averageVolume(candles, 20, idx + 1);
  const volC = averageVolume(candles, 20, idx + 2);
  const ratioA = volA > 0 ? a.volume / volA : 0;
  const ratioB = volB > 0 ? b.volume / volB : 0;
  const ratioC = volC > 0 ? c.volume / volC : 0;
  // BUGFIX (аудит 2026-09-12, §3.2): раньше здесь были две дословно
  // задублированные строки — первая уже подразумевает связку a->b->c,
  // вторая добавляла лишь c >= 0.95*a, что несущественно строже уже
  // выводимого из первой строки c >= 0.9025*a (0.95²). Разница в эффекте
  // исчезающе мала и с высокой вероятностью была copy-paste-артефактом, а
  // не осознанным двойным требованием. Сведено к единому условию
  // "неубывающий объём по всем трём свечам одновременно", без изменения
  // проходного порога.
  if (!(b.volume >= a.volume * 0.95 && c.volume >= a.volume * 0.95 && c.volume >= b.volume * 0.95)) return null;

  if (isAsiaOrClosed(session)) return null;

  const rsiSeries = calcRsi(candles.map((cc) => cc.close), 14);
  const rsiValue = rsiSeries[idx + 2];
  if (rsiValue != null && rsiValue > 70) return null; // exhaustion, не разворот

  const filters = buildFilters(ctx, a, c, 'buy', rsiValue);
  if (countPassedFilters(filters) < MIN_FILTERS_REQUIRED) return null;

  const avgBody = (bodyA + bodyB + bodyC) / 3;
  const lastRange = (candles[n - 1].high - candles[n - 1].low) || 1e-9;
  const base = clamp01(0.5 + Math.min(0.25, (avgBody / lastRange) * 0.25));
  const filtersRatio = countPassedFilters(filters) / MULTI_FACTOR_TOTAL;
  const confidence = clamp01(
    base
    * (0.6 + 0.4 * filtersRatio)
    * sessionBoost(session)
    * rsiZoneFactor('buy', rsiValue)
    * atrFactor(avgBody, atrValue),
  );
  if (confidence < 0.5) return null;

  return {
    name: 'three-white-soldiers',
    direction: 'buy',
    confidence,
    strength: strengthForConfidence(confidence),
    time: c.time,
    volumeConfirmed: ratioA >= 1.0 && ratioB >= 1.0 && ratioC >= 1.0,
    confluenceFactors: confluenceList(filters),
  };
}

export function detectThreeBlackCrows(ctx: TripleContext): PatternResult | null {
  const { candles, session, indicators } = ctx;
  const n = candles.length;
  if (n < 4 + TREND_LOOKBACK) return null;
  const idx = n - 4;
  const a = candles[idx];
  const b = candles[idx + 1];
  const c = candles[idx + 2];

  if (countBullish(candles, idx, TREND_LOOKBACK) < TREND_MIN_COUNT) return null;
  if (!hasPrecedingBullish(candles, idx, TREND_LOOKBACK)) return null;

  if (a.close >= a.open || b.close >= b.open || c.close >= c.open) return null;
  if (b.open < Math.min(a.open, a.close) || b.open > Math.max(a.open, a.close)) return null;
  if (c.open < Math.min(b.open, b.close) || c.open > Math.max(b.open, b.close)) return null;
  if (b.close >= a.close || c.close >= b.close) return null;

  const bodyA = Math.abs(a.close - a.open);
  const bodyB = Math.abs(b.close - b.open);
  const bodyC = Math.abs(c.close - c.open);
  const rangeA = a.high - a.low || 1e-9;
  const rangeB = b.high - b.low || 1e-9;
  const rangeC = c.high - c.low || 1e-9;

  const lowerWickA = Math.min(a.open, a.close) - a.low;
  const lowerWickB = Math.min(b.open, b.close) - b.low;
  if (lowerWickA > 0.30 * bodyA || lowerWickB > 0.30 * bodyB) return null;
  if ((c.close - c.low) > 0.10 * rangeC) return null; // закрытие (c) в нижних 10% диапазона
  if (lowerWickA > 0.15 * bodyA && lowerWickB > 0.15 * bodyB) return null;

  const atrValue = indicators?.atr ?? null;
  const climaxThreshold = atrValue ?? ((rangeA + rangeB + rangeC) / 3);
  const isClimax = bodyA >= 3 * climaxThreshold && bodyB >= 3 * climaxThreshold && bodyC >= 3 * climaxThreshold
    && (rangeA - bodyA) < 0.05 * bodyA && (rangeB - bodyB) < 0.05 * bodyB && (rangeC - bodyC) < 0.05 * bodyC;
  if (isClimax) return null;

  const avgBody20 = averageBody(candles, 20, idx);
  if (avgBody20 > 0 && bodyA < 1.5 * avgBody20) return null;

  const volA = averageVolume(candles, 20, idx);
  const volB = averageVolume(candles, 20, idx + 1);
  const volC = averageVolume(candles, 20, idx + 2);
  const ratioA = volA > 0 ? a.volume / volA : 0;
  const ratioB = volB > 0 ? b.volume / volB : 0;
  const ratioC = volC > 0 ? c.volume / volC : 0;
  // BUGFIX (аудит 2026-09-12, §3.2): раньше здесь были две дословно
  // задублированные строки — первая уже подразумевает связку a->b->c,
  // вторая добавляла лишь c >= 0.95*a, что несущественно строже уже
  // выводимого из первой строки c >= 0.9025*a (0.95²). Разница в эффекте
  // исчезающе мала и с высокой вероятностью была copy-paste-артефактом, а
  // не осознанным двойным требованием. Сведено к единому условию
  // "неубывающий объём по всем трём свечам одновременно", без изменения
  // проходного порога.
  if (!(b.volume >= a.volume * 0.95 && c.volume >= a.volume * 0.95 && c.volume >= b.volume * 0.95)) return null;

  if (isAsiaOrClosed(session)) return null;

  const rsiSeries = calcRsi(candles.map((cc) => cc.close), 14);
  const rsiValue = rsiSeries[idx + 2];
  if (rsiValue != null && rsiValue < 30) return null; // exhaustion, не разворот

  const filters = buildFilters(ctx, a, c, 'sell', rsiValue);
  if (countPassedFilters(filters) < MIN_FILTERS_REQUIRED) return null;

  const avgBody = (bodyA + bodyB + bodyC) / 3;
  const lastRange = (candles[n - 1].high - candles[n - 1].low) || 1e-9;
  const base = clamp01(0.5 + Math.min(0.25, (avgBody / lastRange) * 0.25));
  const filtersRatio = countPassedFilters(filters) / MULTI_FACTOR_TOTAL;
  const confidence = clamp01(
    base
    * (0.6 + 0.4 * filtersRatio)
    * sessionBoost(session)
    * rsiZoneFactor('sell', rsiValue)
    * atrFactor(avgBody, atrValue),
  );
  if (confidence < 0.5) return null;

  return {
    name: 'three-black-crows',
    direction: 'sell',
    confidence,
    strength: strengthForConfidence(confidence),
    time: c.time,
    volumeConfirmed: ratioA >= 1.0 && ratioB >= 1.0 && ratioC >= 1.0,
    confluenceFactors: confluenceList(filters),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Abandoned Baby (bottom / top) — строгая изоляция doji по теням,
// точная мультипликативная формула confidence по методичке.
// ─────────────────────────────────────────────────────────────────────────

export function detectAbandonedBabyBottom(ctx: TripleContext): PatternResult | null {
  // NB: M1 `structure` не деструктурируется здесь намеренно — Abandoned
  // Baby не использует его ни для одного локального гейта (в отличие от
  // single.ts/double.ts), только htfStructure для htfAlignmentStrict.
  const { candles, htfStructure, session, indicators } = ctx;
  const n = candles.length;
  if (n < 4 + TREND_LOOKBACK) return null;
  const idx = n - 4;
  const a = candles[idx];
  const b = candles[idx + 1];
  const c = candles[idx + 2];
  const fourth = candles[idx + 3];

  if (countBearish(candles, idx, TREND_LOOKBACK) < TREND_MIN_COUNT) return null;
  if (!hasPrecedingBearish(candles, idx, TREND_LOOKBACK)) return null;

  if (a.close >= a.open) return null;
  const bodyA = Math.abs(a.close - a.open);
  const atrValue = indicators?.atr ?? null;
  if (atrValue != null && bodyA < 0.6 * atrValue) return null;

  const bodyB = Math.abs(b.close - b.open);
  const rangeB = b.high - b.low || 1e-9;
  if (bodyB / rangeB > 0.05) return null; // doji

  // BUGFIX (аудит 2026-09-12, §3.1): ATR-нормализованный гэп вместо
  // буквального неперекрытия теней — см. hasAtrNormalizedGap выше.
  if (!hasAtrNormalizedGap(a.low, b.high, atrValue)) return null; // "гэп" (a)->(b)
  if (!hasAtrNormalizedGap(c.low, b.high, atrValue)) return null; // "гэп" (b)->(c)

  if (c.close <= c.open) return null;
  const bodyC = Math.abs(c.close - c.open);
  if (bodyC < 0.8 * bodyA) return null;
  const depth = bodyA > 0 ? (c.close - a.close) / bodyA : 0;
  if (depth <= 0.5) return null;

  if (isAsiaOrClosed(session)) return null;

  const avgVolA = averageVolume(candles, 20, idx);
  const avgVolB = averageVolume(candles, 20, idx + 1);
  const avgVolC = averageVolume(candles, 20, idx + 2);
  const ratioA = avgVolA > 0 ? a.volume / avgVolA : 0;
  const ratioB = avgVolB > 0 ? b.volume / avgVolB : 0;
  const ratioC = avgVolC > 0 ? c.volume / avgVolC : 0;
  if (ratioA < 1.0 && ratioB < 1.0 && ratioC < 1.0) return null; // объём падает на всех трёх

  const rsiSeries = calcRsi(candles.map((cc) => cc.close), 14);
  const rsiValue = rsiSeries[idx + 2];

  const fourthResult = fourthCandleConfirmation(c, fourth, 'buy');
  if (fourthResult.cancelled) return null;

  const base = 0.50;
  const htf = htfAlignmentStrict(htfStructure, 'buy');
  const sessionFactor = sessionBoost(session);
  const volumeFactorValue = volumeClimaxFactor(ratioA, ratioB, ratioC);
  // BUGFIX (аудит 2026-09-12, §3.1): gapFactor теперь честно отражает
  // качество разрыва — полный бонус только для настоящего буквального гэпа
  // по обеим сторонам (a)->(b) и (b)->(c); ATR-эквивалент (тени слегка
  // перекрываются, но перекрытие мало относительно ATR) даёт более
  // консервативный бонус, т.к. это более слабый сигнал, чем реальный гэп.
  const literalGap = a.low > b.high && c.low > b.high;
  const gapFactor = literalGap ? 1.25 : 1.10;
  const rsiFactorValue = rsiZoneFactor('buy', rsiValue);

  const confidence = Math.min(0.95, clamp01(
    base * htf * sessionFactor * volumeFactorValue * gapFactor * fourthResult.multiplier * rsiFactorValue,
  ));
  if (confidence < 0.65) return null;

  return {
    name: 'abandoned-baby-bottom',
    direction: 'buy',
    confidence,
    strength: strengthForConfidence(confidence),
    time: c.time,
    volumeConfirmed: volumeFactorValue >= 1.15,
    confirmedByNextCandle: !fourthResult.cancelled && fourthResult.multiplier >= 1.05,
  };
}

export function detectAbandonedBabyTop(ctx: TripleContext): PatternResult | null {
  // NB: M1 `structure` не деструктурируется здесь намеренно — см. комментарий
  // в detectAbandonedBabyBottom выше.
  const { candles, htfStructure, session, indicators } = ctx;
  const n = candles.length;
  if (n < 4 + TREND_LOOKBACK) return null;
  const idx = n - 4;
  const a = candles[idx];
  const b = candles[idx + 1];
  const c = candles[idx + 2];
  const fourth = candles[idx + 3];

  if (countBullish(candles, idx, TREND_LOOKBACK) < TREND_MIN_COUNT) return null;
  if (!hasPrecedingBullish(candles, idx, TREND_LOOKBACK)) return null;

  if (a.close <= a.open) return null;
  const bodyA = Math.abs(a.close - a.open);
  const atrValue = indicators?.atr ?? null;
  if (atrValue != null && bodyA < 0.6 * atrValue) return null;

  const bodyB = Math.abs(b.close - b.open);
  const rangeB = b.high - b.low || 1e-9;
  if (bodyB / rangeB > 0.05) return null; // doji

  // BUGFIX (аудит 2026-09-12, §3.1): ATR-нормализованный гэп вместо
  // буквального неперекрытия теней — см. hasAtrNormalizedGap выше.
  if (!hasAtrNormalizedGap(b.low, a.high, atrValue)) return null; // "гэп" (a)->(b)
  if (!hasAtrNormalizedGap(b.low, c.high, atrValue)) return null; // "гэп" (b)->(c)

  if (c.close >= c.open) return null;
  const bodyC = Math.abs(c.close - c.open);
  if (bodyC < 0.8 * bodyA) return null;
  const depth = bodyA > 0 ? (a.close - c.close) / bodyA : 0;
  if (depth <= 0.5) return null;

  if (isAsiaOrClosed(session)) return null;

  const avgVolA = averageVolume(candles, 20, idx);
  const avgVolB = averageVolume(candles, 20, idx + 1);
  const avgVolC = averageVolume(candles, 20, idx + 2);
  const ratioA = avgVolA > 0 ? a.volume / avgVolA : 0;
  const ratioB = avgVolB > 0 ? b.volume / avgVolB : 0;
  const ratioC = avgVolC > 0 ? c.volume / avgVolC : 0;
  if (ratioA < 1.0 && ratioB < 1.0 && ratioC < 1.0) return null;

  const rsiSeries = calcRsi(candles.map((cc) => cc.close), 14);
  const rsiValue = rsiSeries[idx + 2];

  const fourthResult = fourthCandleConfirmation(c, fourth, 'sell');
  if (fourthResult.cancelled) return null;

  const base = 0.50;
  const htf = htfAlignmentStrict(htfStructure, 'sell');
  const sessionFactor = sessionBoost(session);
  const volumeFactorValue = volumeClimaxFactor(ratioA, ratioB, ratioC);
  // BUGFIX (аудит 2026-09-12, §3.1): см. симметричное обоснование в
  // detectAbandonedBabyBottom выше.
  const literalGap = b.low > a.high && b.low > c.high;
  const gapFactor = literalGap ? 1.25 : 1.10;
  const rsiFactorValue = rsiZoneFactor('sell', rsiValue);

  const confidence = Math.min(0.95, clamp01(
    base * htf * sessionFactor * volumeFactorValue * gapFactor * fourthResult.multiplier * rsiFactorValue,
  ));
  if (confidence < 0.65) return null;

  return {
    name: 'abandoned-baby-top',
    direction: 'sell',
    confidence,
    strength: strengthForConfidence(confidence),
    time: c.time,
    volumeConfirmed: volumeFactorValue >= 1.15,
    confirmedByNextCandle: !fourthResult.cancelled && fourthResult.multiplier >= 1.05,
  };
}
