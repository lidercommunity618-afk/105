import type {
  Candle,
  PatternResult,
  SignalStrength,
  SignalDirection,
  MarketStructure,
  IndicatorSnapshot,
} from '@/types/domain';
import { clamp01, averageVolume, averageBody } from '@/compute/indicators/helpers';
import { rsi as calcRsi } from '@/compute/indicators/rsi';
import { macd as calcMacd } from '@/compute/indicators/macd';
import { bollinger } from '@/compute/indicators/bollinger';
import { atr as calcAtr } from '@/compute/indicators/atr';
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
  type MultiFactorFilters,
} from './pattern-context';

// ─────────────────────────────────────────────────────────────────────────
// Rising Three Methods / Falling Three Methods — пятисвечные continuation-
// паттерны (методички "Условия входа на M1 для форекс-пар"). Свечи паттерна:
//   first = candles[length-5]         — импульсная свеча 1
//   c2, c3, c4 = candles[length-4..2] — консолидация (свечи 2-4)
//   last = candles[length-1]          — свеча 5 (подтверждение)
// `last` совпадает с последней закрытой свечой всего потока, поэтому
// глобальный `indicators`-снэпшот (посчитанный по всему candles[] в
// full-snapshot.ts) соответствует именно ей — в отличие от triple.ts, где
// паттерн заканчивается на candles[length-2] и требует локального
// пересчёта RSI/MACD-серий отдельно от снэпшота. Тем не менее по методичке
// набор индикаторов (RSI/MACD/Bollinger/ATR) считается локально по всему
// candles[] тем же способом, что и в triple.ts — снэпшот берётся только для
// EMA21 (nearEma21InTrend), т.к. полной серии EMA в проекте нет.
// ─────────────────────────────────────────────────────────────────────────

export interface ContinuationContext {
  candles: Candle[];
  structure: MarketStructure;
  session: SessionRegime;
  smartMoney: SmartMoneyResult;
  indicators: IndicatorSnapshot | undefined;
}

const TREND_LOOKBACK = 7;
const TREND_MIN_COUNT = 5;
const AVG_PERIOD = 20;

function strengthForConfidence(confidence: number): SignalStrength {
  if (confidence >= 0.75) return 'strong';
  if (confidence >= 0.5) return 'moderate';
  return 'weak';
}

// Локальные аналоги countBullish/countBearish из triple.ts. По принятой в
// проекте конвенции такие узкоспециализированные счётчики (точнее дефолтного
// hasPrecedingBullish/Bearish порога ">=3 из N") не выносятся в общий
// pattern-context.ts, а дублируются в файле конкретного паттерна.
function countBullish(candles: Candle[], patternIndex: number, lookback: number): number {
  const start = Math.max(0, patternIndex - lookback);
  let n = 0;
  for (let i = start; i < patternIndex; i++) {
    if (candles[i].close > candles[i].open) n++;
  }
  return n;
}

function countBearish(candles: Candle[], patternIndex: number, lookback: number): number {
  const start = Math.max(0, patternIndex - lookback);
  let n = 0;
  for (let i = start; i < patternIndex; i++) {
    if (candles[i].close < candles[i].open) n++;
  }
  return n;
}

// Локальная копия structureShift из triple.ts (BOS/CHoCH в нужную сторону) —
// используется как прокси фазы Вайкоффа Markup/Markdown, т.к. в проекте нет
// отдельного модуля разметки фаз Вайкоффа (см. §"Что НЕЛЬЗЯ реализовывать").
function structureShift(structure: MarketStructure, direction: SignalDirection): boolean {
  if (structure.choch) return true;
  return structure.bos && ((direction === 'buy' && structure.trend === 'up') || (direction === 'sell' && structure.trend === 'down'));
}

function confluenceList(filters: MultiFactorFilters): string[] {
  return Object.entries(filters)
    .filter(([, v]) => v)
    .map(([k]) => k);
}

// RSI-множитель для continuation-паттернов. НЕ путать с rsiZoneFactor из
// pattern-context.ts: там зоны заточены под развороты (высокий множитель
// при RSI<30 для покупки), а здесь наоборот — сильный RSI (>50, но не
// экстремальный) хорош, а RSI<50 плох (см. §4 промта).
function rsiZoneFactorForContinuation(direction: SignalDirection, rsi: number | null): number {
  if (rsi == null) return 1.0; // нет данных — не штрафуем и не поощряем
  if (direction === 'buy') {
    if (rsi > 70) return 1.10;
    if (rsi > 50) return 1.00; // 50 < rsi <= 70
    return 0.70;
  }
  if (rsi < 30) return 1.10;
  if (rsi < 50) return 1.00; // 30 <= rsi < 50
  return 0.70;
}

// Мягкий бонус-множитель "сжатие волатильности перед импульсом свечи 5" —
// НЕ входит в MultiFactorFilters (чтобы не менять константу
// MULTI_FACTOR_TOTAL=9, общую с triple.ts), поэтому не участвует в подсчёте
// countPassedFilters/MIN_FILTERS_REQUIRED, а влияет только на confidence
// через volatilityBonus в §4.
function volatilityContraction(
  candles: Candle[],
  idx: number,
  consolidation: Candle[],
  range1: number,
): boolean {
  const atrSeries = calcAtr(candles, 14);
  const atrAtIdx = atrSeries[idx];
  const atrC2 = atrSeries[idx + 1];
  const atrC3 = atrSeries[idx + 2];
  const atrC4 = atrSeries[idx + 3];
  const atrCompressed = atrAtIdx != null && atrC2 != null && atrC3 != null && atrC4 != null
    && (atrC2 + atrC3 + atrC4) / 3 < atrAtIdx;

  const range234Sum = consolidation.reduce((sum, c) => sum + (c.high - c.low), 0);
  const rangeCompressed = range234Sum <= 0.8 * range1;

  return atrCompressed && rangeCompressed;
}

// ─────────────────────────────────────────────────────────────────────────
// Мультифакторные confluence-фильтры (общий тип MultiFactorFilters из
// pattern-context.ts, переиспользуемый с triple.ts — минимум 6 из 9
// реализуемых направлений методички). Поля считаются на свече 1 (роль
// "candleA") и свече 5 (роль "candleC" по конвенции triple.ts), RSI берётся
// на свече 5 (rsi[idx+4]). Волновая разметка Эллиотта и интермаркет-
// корреляции (DXY/кросс-пары/нефть/золото) сознательно не реализуются — в
// проекте нет соответствующих модулей/данных, а подделывать их правилами
// проекта запрещено (no mocks). Точная фаза Вайкоффа не выделяется отдельно
// — её смысл (импульс → истощение объёма консолидации → возобновление)
// покрыт объёмными хард-фильтрами ниже и прокси structureShift.
// ─────────────────────────────────────────────────────────────────────────
function buildContinuationFilters(
  ctx: ContinuationContext,
  first: Candle,
  last: Candle,
  direction: SignalDirection,
  rsiAtC5: number | null,
): MultiFactorFilters {
  const { structure, session, smartMoney, indicators, candles } = ctx;
  const idx = candles.length - 5;
  const atrValue = indicators?.atr ?? null;

  // SMC-конфлюэнс считается относительно свечи 1 (импульса) — именно она
  // формирует Order Block/FVG, из которых "выстреливает" паттерн, а не
  // свеча 5 подтверждения.
  const obFvgBonus = obFvgConfluenceBonus(smartMoney, first, direction, atrValue, intervalSeconds(candles));

  // MACD-гистограмма (12,26,9) — локальный пересчёт по всем свечам, как и в
  // хард-гейте §2.7 детектора; здесь нужны только свечи 4 и 5 для мягкого
  // macdTurn (расширение гистограммы на свече 5 относительно свечи 4).
  const macdResult = calcMacd(candles.map((c) => c.close), 12, 26, 9);
  const histC4 = macdResult.histogram[idx + 3];
  const histC5 = macdResult.histogram[idx + 4];
  const macdTurn = histC4 != null && histC5 != null
    && (direction === 'buy' ? histC5 > histC4 : histC5 < histC4);

  // Bollinger(20,2) — локальный пересчёт; касание/пробитие полосы именно
  // свечой 1 (импульсной), как того требует методичка.
  const bb = bollinger(candles.map((c) => c.close), 20, 2);
  const upperAtC1 = bb.upper[idx];
  const lowerAtC1 = bb.lower[idx];
  const bollingerTouch = direction === 'buy'
    ? (upperAtC1 != null && first.high >= upperAtC1)
    : (lowerAtC1 != null && first.low <= lowerAtC1);

  // RSI-зона на свече 5: НЕ разворотная (не <30/>70), а зона продолжения
  // бычьего/медвежьего импульса (>50 но не экстремум / <50 но не экстремум).
  const rsiZone = direction === 'buy'
    ? (rsiAtC5 != null && rsiAtC5 > 50 && rsiAtC5 <= 80)
    : (rsiAtC5 != null && rsiAtC5 < 50 && rsiAtC5 >= 20);

  return {
    smcOrderBlock: obFvgBonus >= 0.1,
    smcFvg: obFvgBonus > 0 && obFvgBonus < 0.1,
    liquiditySweep: isNearSwingLevel(structure, first, atrValue),
    rsiZone,
    macdTurn,
    // EMA21 проверяется на свече 5 (закрытие паттерна), а не на свече 4 —
    // именно на её закрытии принимается решение о входе (см. §1).
    emaZone: nearEma21InTrend(indicators, last, direction),
    bollingerTouch,
    structureShift: structureShift(structure, direction),
    killZoneSession: sessionBoost(session) >= 1.05,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Rising Three Methods
// ─────────────────────────────────────────────────────────────────────────

export function detectRisingThreeMethods(ctx: ContinuationContext): PatternResult | null {
  const { candles, session, indicators } = ctx;
  const n = candles.length;
  if (n < 5 + TREND_LOOKBACK) return null;
  const idx = n - 5;
  const first = candles[idx];
  const c2 = candles[idx + 1];
  const c3 = candles[idx + 2];
  const c4 = candles[idx + 3];
  const last = candles[idx + 4];
  const consolidation = [c2, c3, c4];

  // 2.1 Тренд перед паттерном: минимум 5 из 7 бычьих свечей (Higher Highs/
  //     Higher Lows), паттерн формируется внутри импульса.
  if (countBullish(candles, idx, TREND_LOOKBACK) < TREND_MIN_COUNT) return null;
  if (!hasPrecedingBullish(candles, idx, TREND_LOOKBACK)) return null;

  // 2.8 Азиатская сессия — запретная зона по методичке ("флет", паттерн
  //     часто ломается), торговать "Три метода" на M1 только в Kill Zones.
  if (isAsiaOrClosed(session)) return null;

  // 2.2 Свеча 1 — длинный бычий импульс: тело >= 60% диапазона, >= 1.5x
  //     среднего тела за 20 свечей, закрытие в верхних 20% диапазона,
  //     нижняя тень <= 10%.
  if (first.close <= first.open) return null;
  const body1 = first.close - first.open;
  const range1 = (first.high - first.low) || 1e-9;
  if (body1 / range1 < 0.6) return null;
  const avgBody20 = averageBody(candles, AVG_PERIOD, idx);
  if (avgBody20 > 0 && body1 < 1.5 * avgBody20) return null;
  if ((first.high - first.close) / range1 > 0.20) return null;
  const lowerWick1 = Math.min(first.open, first.close) - first.low;
  if (lowerWick1 > 0.10 * range1) return null;

  // 2.3 Свечи 2-4 — малые (тело <= 40% среднего тела, <= 50% тела свечи 1),
  //     без пробоя High/Low свечи 1 даже тенью (инвалидатор). Направление
  //     тела намеренно не фиксируется хард-фильтром (методичка: "допустимы
  //     разнонаправленные, но чаще медвежьи") — только геометрия/контейнмент.
  for (const c of consolidation) {
    const body = Math.abs(c.close - c.open);
    if (avgBody20 > 0 && body > 0.4 * avgBody20) return null;
    if (body > 0.5 * body1) return null;
    if (c.high > first.high || c.low < first.low) return null;
  }

  // 2.4 Свеча 5 — длинная бычья (тело >= 70% диапазона), close строго выше
  //     close(1), тело >= тела свечи 1.
  if (last.close <= last.open) return null;
  const body5 = last.close - last.open;
  const range5 = (last.high - last.low) || 1e-9;
  if (body5 / range5 < 0.7) return null;
  if (last.close <= first.close) return null;
  if (body5 < body1) return null;

  // 2.5 Объём: свеча 1 > среднего, свечи 2-4 < среднего (истощение
  //     продавцов), свеча 5 > среднего, и — прямая цитата методички из
  //     раздела "⚠️ Не входить": "если свеча 5 имеет меньший объём, чем
  //     свеча 1" — это ЖЁСТКИЙ инвалидатор, а не мягкий бонус.
  const avgVol1 = averageVolume(candles, AVG_PERIOD, idx);
  const avgVol2 = averageVolume(candles, AVG_PERIOD, idx + 1);
  const avgVol3 = averageVolume(candles, AVG_PERIOD, idx + 2);
  const avgVol4 = averageVolume(candles, AVG_PERIOD, idx + 3);
  const avgVol5 = averageVolume(candles, AVG_PERIOD, idx + 4);
  if (avgVol1 > 0 && first.volume <= avgVol1) return null;
  if (avgVol2 > 0 && c2.volume >= avgVol2) return null;
  if (avgVol3 > 0 && c3.volume >= avgVol3) return null;
  if (avgVol4 > 0 && c4.volume >= avgVol4) return null;
  if (avgVol5 > 0 && last.volume <= avgVol5) return null;
  if (last.volume < first.volume) return null; // хард-инвалидатор "volume(5) >= volume(1)"

  // 2.6 RSI(14) должен оставаться > 50 на всей консолидации (2-4) —
  //     обязательный фильтр по методичке, поэтому в отличие от опционального
  //     rsiZone в triple.ts здесь null (недостаточно данных) трактуется как
  //     провал условия, а не нейтрально. Значение на свече 5 (rsi5) НЕ
  //     хард-гейтится и не сравнивается с rsi4 — по методичке разворот RSI
  //     на свече 5 является мягким confluence-фактором (rsiZone, §3), а не
  //     обязательным условием.
  const rsiSeries = calcRsi(candles.map((c) => c.close), 14);
  const rsi2 = rsiSeries[idx + 1];
  const rsi3 = rsiSeries[idx + 2];
  const rsi4 = rsiSeries[idx + 3];
  const rsi5 = rsiSeries[idx + 4];
  if (rsi2 == null || rsi3 == null || rsi4 == null) return null;
  if (rsi2 <= 50 || rsi3 <= 50 || rsi4 <= 50) return null;

  // 2.7 Гистограмма MACD(12,26,9) > 0 на свечах 2-4 — обязательный фильтр.
  //     Расширение гистограммы на свече 5 (hist5 > hist4) — мягкий
  //     confluence-фактор (macdTurn, §3), НЕ хард-гейт: методичка относит
  //     его к описательному разделу "Технический аналитик", а не к списку
  //     "Обязательные условия".
  const macdResult = calcMacd(candles.map((c) => c.close), 12, 26, 9);
  const hist2 = macdResult.histogram[idx + 1];
  const hist3 = macdResult.histogram[idx + 2];
  const hist4 = macdResult.histogram[idx + 3];
  if (hist2 == null || hist3 == null || hist4 == null) return null;
  if (hist2 <= 0 || hist3 <= 0 || hist4 <= 0) return null;

  // 2.9 Мягкие confluence-фильтры: минимум 6 из 9 реализуемых направлений.
  const filters = buildContinuationFilters(ctx, first, last, 'buy', rsi5);
  if (countPassedFilters(filters) < MIN_FILTERS_REQUIRED) return null;

  // §4 Формула уверенности.
  const extension = body1 > 0 ? body5 / body1 : 1;
  const base = clamp01(0.5 + Math.min(0.20, Math.max(0, extension - 1) * 0.4));
  const filtersRatio = countPassedFilters(filters) / MULTI_FACTOR_TOTAL;
  const volatilityBonus = volatilityContraction(candles, idx, consolidation, range1) ? 1.05 : 0.90;
  const confidence = clamp01(
    base
    * (0.6 + 0.4 * filtersRatio)
    * sessionBoost(session)
    * rsiZoneFactorForContinuation('buy', rsi5)
    * atrFactor(body5, indicators?.atr ?? null)
    * volatilityBonus,
  );
  if (confidence < 0.5) return null;

  return {
    name: 'rising-three-methods',
    direction: 'buy',
    confidence,
    strength: strengthForConfidence(confidence),
    time: last.time,
    // Порог строже базового хард-гейта (volume(5) > avgVol20) — иначе флаг
    // был бы всегда true и бессмысленно давал бы +0.1 в
    // applyConfidenceHierarchy на каждом сработавшем паттерне.
    volumeConfirmed: last.volume >= 1.5 * avgVol5,
    confluenceFactors: confluenceList(filters),
    // confirmedByNextCandle намеренно не заполняется: в этом шаблоне нет
    // подтверждающей свечи после 5-й — вход происходит на закрытии самой
    // свечи 5 (в отличие от Model B в triple.ts).
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Falling Three Methods
// ─────────────────────────────────────────────────────────────────────────

export function detectFallingThreeMethods(ctx: ContinuationContext): PatternResult | null {
  const { candles, session, indicators } = ctx;
  const n = candles.length;
  if (n < 5 + TREND_LOOKBACK) return null;
  const idx = n - 5;
  const first = candles[idx];
  const c2 = candles[idx + 1];
  const c3 = candles[idx + 2];
  const c4 = candles[idx + 3];
  const last = candles[idx + 4];
  const consolidation = [c2, c3, c4];

  // 2.1 Тренд перед паттерном: минимум 5 из 7 медвежьих свечей (Lower Lows/
  //     Lower Highs), паттерн формируется внутри импульса.
  if (countBearish(candles, idx, TREND_LOOKBACK) < TREND_MIN_COUNT) return null;
  if (!hasPrecedingBearish(candles, idx, TREND_LOOKBACK)) return null;

  // 2.8 Азиатская сессия — запретная зона по методичке.
  if (isAsiaOrClosed(session)) return null;

  // 2.2 Свеча 1 — длинный медвежий импульс: тело >= 60% диапазона, >= 1.5x
  //     среднего тела за 20 свечей, закрытие в нижних 20% диапазона,
  //     верхняя тень <= 10%.
  if (first.close >= first.open) return null;
  const body1 = first.open - first.close;
  const range1 = (first.high - first.low) || 1e-9;
  if (body1 / range1 < 0.6) return null;
  const avgBody20 = averageBody(candles, AVG_PERIOD, idx);
  if (avgBody20 > 0 && body1 < 1.5 * avgBody20) return null;
  if ((first.close - first.low) / range1 > 0.20) return null;
  const upperWick1 = first.high - Math.max(first.open, first.close);
  if (upperWick1 > 0.10 * range1) return null;

  // 2.3 Свечи 2-4 — малые (тело <= 40% среднего тела, <= 50% тела свечи 1),
  //     без пробоя High/Low свечи 1 даже тенью (инвалидатор).
  for (const c of consolidation) {
    const body = Math.abs(c.close - c.open);
    if (avgBody20 > 0 && body > 0.4 * avgBody20) return null;
    if (body > 0.5 * body1) return null;
    if (c.high > first.high || c.low < first.low) return null;
  }

  // 2.4 Свеча 5 — длинная медвежья (тело >= 70% диапазона), close строго
  //     ниже close(1), тело >= тела свечи 1.
  if (last.close >= last.open) return null;
  const body5 = last.open - last.close;
  const range5 = (last.high - last.low) || 1e-9;
  if (body5 / range5 < 0.7) return null;
  if (last.close >= first.close) return null;
  if (body5 < body1) return null;

  // 2.5 Объём: свеча 1 > среднего, свечи 2-4 < среднего (истощение
  //     покупателей), свеча 5 > среднего, и жёсткий инвалидатор
  //     "volume(5) >= volume(1)" — прямая цитата методички ("⚠️ Не входить").
  const avgVol1 = averageVolume(candles, AVG_PERIOD, idx);
  const avgVol2 = averageVolume(candles, AVG_PERIOD, idx + 1);
  const avgVol3 = averageVolume(candles, AVG_PERIOD, idx + 2);
  const avgVol4 = averageVolume(candles, AVG_PERIOD, idx + 3);
  const avgVol5 = averageVolume(candles, AVG_PERIOD, idx + 4);
  if (avgVol1 > 0 && first.volume <= avgVol1) return null;
  if (avgVol2 > 0 && c2.volume >= avgVol2) return null;
  if (avgVol3 > 0 && c3.volume >= avgVol3) return null;
  if (avgVol4 > 0 && c4.volume >= avgVol4) return null;
  if (avgVol5 > 0 && last.volume <= avgVol5) return null;
  if (last.volume < first.volume) return null; // хард-инвалидатор "volume(5) >= volume(1)"

  // 2.6 RSI(14) должен оставаться < 50 на всей консолидации (2-4) —
  //     обязательный фильтр. rsi5 не хард-гейтится и не сравнивается с
  //     rsi4 — это мягкий confluence-фактор (rsiZone, §3).
  const rsiSeries = calcRsi(candles.map((c) => c.close), 14);
  const rsi2 = rsiSeries[idx + 1];
  const rsi3 = rsiSeries[idx + 2];
  const rsi4 = rsiSeries[idx + 3];
  const rsi5 = rsiSeries[idx + 4];
  if (rsi2 == null || rsi3 == null || rsi4 == null) return null;
  if (rsi2 >= 50 || rsi3 >= 50 || rsi4 >= 50) return null;

  // 2.7 Гистограмма MACD(12,26,9) < 0 на свечах 2-4 — обязательный фильтр.
  //     Расширение гистограммы вниз на свече 5 (hist5 < hist4) — мягкий
  //     confluence-фактор (macdTurn, §3), НЕ хард-гейт.
  const macdResult = calcMacd(candles.map((c) => c.close), 12, 26, 9);
  const hist2 = macdResult.histogram[idx + 1];
  const hist3 = macdResult.histogram[idx + 2];
  const hist4 = macdResult.histogram[idx + 3];
  if (hist2 == null || hist3 == null || hist4 == null) return null;
  if (hist2 >= 0 || hist3 >= 0 || hist4 >= 0) return null;

  // 2.9 Мягкие confluence-фильтры: минимум 6 из 9 реализуемых направлений.
  const filters = buildContinuationFilters(ctx, first, last, 'sell', rsi5);
  if (countPassedFilters(filters) < MIN_FILTERS_REQUIRED) return null;

  // §4 Формула уверенности.
  const extension = body1 > 0 ? body5 / body1 : 1;
  const base = clamp01(0.5 + Math.min(0.20, Math.max(0, extension - 1) * 0.4));
  const filtersRatio = countPassedFilters(filters) / MULTI_FACTOR_TOTAL;
  const volatilityBonus = volatilityContraction(candles, idx, consolidation, range1) ? 1.05 : 0.90;
  const confidence = clamp01(
    base
    * (0.6 + 0.4 * filtersRatio)
    * sessionBoost(session)
    * rsiZoneFactorForContinuation('sell', rsi5)
    * atrFactor(body5, indicators?.atr ?? null)
    * volatilityBonus,
  );
  if (confidence < 0.5) return null;

  return {
    name: 'falling-three-methods',
    direction: 'sell',
    confidence,
    strength: strengthForConfidence(confidence),
    time: last.time,
    volumeConfirmed: last.volume >= 1.5 * avgVol5,
    confluenceFactors: confluenceList(filters),
  };
}
