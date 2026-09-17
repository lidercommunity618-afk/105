import type { Candle, PatternResult, FeatureName, IndicatorSnapshot, MarketStructure } from '@/types/domain';
import { rsi as calcRsi } from '@/compute/indicators/rsi';
import { detectHammer, detectShootingStar, detectDoji, detectInvertedHammer, detectHangingMan, detectMarubozuBullish, detectMarubozuBearish, detectSpinningTop } from './single';
import {
  detectBullishEngulfing,
  detectBearishEngulfing,
  detectBullishHarami,
  detectBearishHarami,
  detectPiercingLine,
  detectDarkCloudCover,
  detectTweezerBottom,
  detectTweezerTop,
} from './double';
import {
  detectMorningStar,
  detectEveningStar,
  detectThreeWhiteSoldiers,
  detectThreeBlackCrows,
  detectAbandonedBabyBottom,
  detectAbandonedBabyTop,
  type TripleContext,
} from './triple';
import { detectRisingThreeMethods, detectFallingThreeMethods, type ContinuationContext } from './continuation';
import { detectPinBar } from './pin-bar';
import { detectInsideBar } from './inside-bar';
import { detectImpulseBreakout } from './impulse-breakout';
import { detectConsolidationBreakout } from './consolidation-breakout';
import { detectLiquiditySweep } from './liquidity-sweep';
import { detectLiquiditySweepReaction } from './liquidity-sweep-reaction';
import { detectMeanReversion } from './mean-reversion';
import { detectStrongOrderBlockReaction } from './strong-order-block-reaction';
import { detectOrderBlockContinuation } from './order-block-continuation';
import { detectMacdDecelerationContinuation } from './macd-deceleration-continuation';
import { detectFvgReturn } from './fvg-return';
import { detectFvgBreakerBlock } from './fvg-breaker-block';
import { detectFvgNested } from './fvg-nested';
import { detectFvgRejection } from './fvg-rejection';
import { detectOrderBlockBreaker } from './order-block-breaker';
import { detectOrderBlockNested } from './order-block-nested';
import { detectHarmonicPattern, type HarmonicConfig } from './harmonic-pattern';
import type { PatternContext } from './pattern-context';
import { getSessionRegime } from '@/compute/session-regime';
import type { SmartMoneyResult } from '@/compute/indicators/smart-money';
import { computeHtfStructure } from '@/compute/indicators/htf-structure';

const PATTERN_CONFIDENCE_HIERARCHY: Record<string, number> = {
  // Triple-bar patterns: после апгрейда детекторы сами считают точный
  // мультифакторный confidence (см. triple.ts) — фиксированные полы 0.8/0.9
  // искусственно завышали бы слабые сигналы через Math.max ниже, поэтому
  // используем тот же низкий пол 0.35, что и у остальных context-aware
  // паттернов (pin-bar, engulfing и т.д.).
  'morning-star': 0.35,
  'evening-star': 0.35,
  'three-white-soldiers': 0.35,
  'three-black-crows': 0.35,
  'abandoned-baby-bottom': 0.35,
  'abandoned-baby-top': 0.35,
  // 6 context-aware patterns: lowered to floor so the multi-factor
  // confidence computed inside each detector is what actually applies.
  'pin-bar': 0.35,
  // BUGFIX (аудит 2026-09-12): раньше 0.6 — искусственный пол, оставшийся
  // от старой версии detectHammer(cur), которая не считала мультифакторный
  // confidence и всегда требовала подтяжки. Теперь detectHammer(ctx) сам
  // считает точный confidence (trend/RSI/сессия/объём/OB-confluence,
  // как inverted-hammer/hanging-man), поэтому пол снижен до того же 0.35,
  // что у остальных context-aware одиночных паттернов — иначе Math.max ниже
  // искусственно завышал бы слабые сигналы до "moderate".
  'hammer': 0.35,
  'shooting-star': 0.35,
  'inverted-hammer': 0.35,
  'hanging-man': 0.35,
  // 6 context-aware double-bar patterns: lowered to floor so the
  // multi-factor confidence computed inside each detector applies.
  'bullish-engulfing': 0.35,
  'bearish-engulfing': 0.35,
  'piercing-line': 0.35,
  'dark-cloud-cover': 0.35,
  'tweezer-bottom': 0.35,
  'tweezer-top': 0.35,
  // BUGFIX (аудит 2026-09-12): раньше 0.5 — искусственный пол под старую
  // detectBullishHarami/detectBearishHarami(prev, cur), которая была явно
  // помечена "UNCHANGED (out of scope)" и не имела вообще никакого
  // контекстного фильтра (тренд/сессия/объём/подтверждение). Теперь оба
  // детектора переведены на PatternContext с золотым правилом обязательного
  // подтверждения (как Tweezer) и сами считают мультифакторный confidence,
  // поэтому пол снижен до 0.35, как у остальных context-aware double-bar
  // паттернов.
  'bullish-harami': 0.35,
  'bearish-harami': 0.35,
  'inside-bar': 0.4,
  'doji': 0.3,
  'spinning-top': 0.25,
  'marubozu-bullish': 0.35,
  'marubozu-bearish': 0.35,
  // 8 M1-стратегии (liquidity sweep, OB, mean reversion, MACD, breakout):
  // НЕТ floor-значений здесь намеренно. Каждый детектор теперь сам считает
  // точный мультифакторный confidence (session boost, объёмные/ATR-мультипликаторы,
  // HTF-конфлюэнс, ADX-фильтры и т.д.) и сам возвращает null, если итоговый
  // confidence ниже порога входа из стратегии. Фиксированный floor здесь
  // (как было раньше: impulse-breakout 0.7, liquidity-sweep-reaction 0.75,
  // order-block-continuation 0.78 и т.д.) искусственно поднимал бы через
  // Math.max ниже confidence слабых сигналов до "strong"/"moderate", что
  // прямо противоречит новым формулам — поэтому полагаемся на fallback
  // `PATTERN_CONFIDENCE_HIERARCHY[p.name] ?? p.confidence` в
  // applyConfidenceHierarchy(), который в отсутствие записи здесь просто
  // пропускает confidence детектора как есть.
  // Continuation-паттерны (Rising/Falling Three Methods): после апгрейда на
  // ContinuationContext детекторы сами считают точный мультифакторный
  // confidence (см. continuation.ts) — тот же низкий пол 0.35, что и у
  // остальных context-aware паттернов выше, иначе Math.max ниже искусственно
  // завысил бы слабые сигналы фиксированным полом 0.7.
  'rising-three-methods': 0.35,
  'falling-three-methods': 0.35,
};

// BUGFIX (регрессия 2026-09-13): предыдущий фикс в этой сессии убрал
// volumeBonus целиком, аргументируя тем, что каждый детектор уже учитывает
// объём в своей confidence. Это верно для большинства паттернов, но НЕВЕРНО
// для трёх, где объём входит только как бинарный hard-gate, а единственной
// градацией между «прошёл порог» и «объём 2x/4x» был именно этот +0.1 бонус:
//
// 1. liquidity-sweep (liquidity-sweep.ts:149) — confidence = depthInAtr/1.5
//    * session * (1+confluenceBonus) * (setupType ? 0.9 : htfAlignment).
//    volRatio — только бинарный hard-gate на 1.5x (строка 120), в само
//    произведение не входит. volumeConfirmed (строка 165) использует строгий
//    порог 2.0x именно чтобы питать этот бонус.
// 2. rising-three-methods (continuation.ts:320-327) — confidence = base
//    * (0.6+0.4*filtersRatio) * sessionBoost * rsiZoneFactor * atrFactor
//    * volatilityBonus. Объёма в формуле нет. volumeConfirmed (строка 339)
//    с порогом 1.5x существует исключительно для этого бонуса (см. комментарий
//    на строках 336-338).
// 3. falling-three-methods (continuation.ts:447-454) — зеркально, строка 463.
const PATTERNS_WITHOUT_OWN_VOLUME_GRADATION = new Set<PatternResult['name']>([
  'liquidity-sweep',
  'rising-three-methods',
  'falling-three-methods',
]);

export function applyConfidenceHierarchy(p: PatternResult): PatternResult {
  const volumeBonus = (p.volumeConfirmed && PATTERNS_WITHOUT_OWN_VOLUME_GRADATION.has(p.name)) ? 0.1 : 0;
  const baseConfidence = PATTERN_CONFIDENCE_HIERARCHY[p.name] ?? p.confidence;
  const confidence = Math.min(1, Math.max(p.confidence, baseConfidence) + volumeBonus);
  const strength: PatternResult['strength'] =
    confidence >= 0.75 ? 'strong' : confidence >= 0.5 ? 'moderate' : 'weak';
  return { ...p, confidence, strength };
}

const DEFAULT_STRUCTURE: MarketStructure = {
  trend: 'range',
  bos: false,
  choch: false,
  swingHigh: null,
  swingLow: null,
  provisional: false,
};

const EMPTY_SMART_MONEY: SmartMoneyResult = {
  orderBlocks: [],
  fvgs: [],
  inversionFvgs: [],
  breakerBlocks: [],
  rejectionBlocks: [],
  bosEvents: [],
};

export function detectAllPatterns(
  candles: Candle[],
  activeFeatures: FeatureName[],
  snapshot?: IndicatorSnapshot,
  structure?: MarketStructure,
  smartMoney?: SmartMoneyResult,
  atrPeriod: number = 14,
  macdConfig?: { fast: number; slow: number; signal: number },
  harmonicConfig?: HarmonicConfig,
  // Test-only override: when provided, skips the real computeHtfStructure()
  // call and uses this MarketStructure as the HTF confluence source for all
  // single/double/triple/mean-reversion/strong-OB-reaction detectors. In
  // production (full-snapshot.ts) this parameter is never passed — the real
  // M15-resampled structure from computeHtfStructure() is always used.
  htfStructureOverride?: MarketStructure,
): PatternResult[] {
  if (candles.length < 2) return [];

  // ВАЖНО: пустой activeFeatures означает «ничего не выбрано», а не «фильтра
  // нет — считать всё активным» (см. тот же фикс в IndicatorAggregator.ts,
  // direction-prediction.ts, signal-filters.ts, full-snapshot.ts).
  const has = (name: FeatureName) => activeFeatures.includes(name);

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const raw: PatternResult[] = [];

  // BUGFIX (аудит 2026-09-12, §1 "HTF-подтверждение — это не HTF, а тот же
  // таймфрейм, посчитанный дважды"): раньше htfAlignment/htfAlignmentStrict
  // во ВСЕХ single/double/triple-паттернах получали тот же M1 `structure`,
  // что уже использован как хард-гейт тренда в каждом детекторе — то есть
  // "независимый HTF confluence-бонус" на деле дважды читал один и тот же
  // M1-сигнал. Считаем настоящую HTF-структуру ОДИН РАЗ здесь (реальный
  // ресэмплинг M1→M15, computeHtfStructure — та же функция, что уже
  // используется для mean-reversion/strong-order-block-reaction ниже) и
  // прокидываем её как отдельное, независимое от M1 `structure` поле
  // PatternContext/TripleContext (continuation.ts намеренно не тронут — там
  // HTF-подобный фактор это отдельный, более мягкий structureShift() на
  // локальном M1 `structure`, не htfAlignment/htfAlignmentStrict, и аудит не
  // включает его в этот пункт действий, см. §4 отчёта). M1 `structure`
  // при этом остаётся как было — для локальных гейтов "паттерн внутри
  // текущего тренда" (hasPrecedingBearish/Bullish, structure.trend/bos/choch
  // внутри самих детекторов) — это два разных, теперь действительно
  // независимых измерения, а не одно и то же дважды.
  const htfStructure = htfStructureOverride ?? computeHtfStructure(candles, atrPeriod);

  // Build PatternContext for the 6 context-aware patterns.
  // patternCandle = candles[length - 2], confirmCandle = candles[length - 1].
  const patternCandle = candles[candles.length - 2];
  const ctx: PatternContext = {
    candles,
    index: candles.length - 2,
    structure: structure ?? DEFAULT_STRUCTURE,
    htfStructure,
    session: getSessionRegime(patternCandle.time * 1000),
    smartMoney: smartMoney ?? EMPTY_SMART_MONEY,
    indicators: snapshot,
  };

  // Single-bar patterns (context-aware)
  if (has('shooting-star')) { const p = detectShootingStar(ctx); if (p) raw.push(p); }
  if (has('pin-bar')) { const p = detectPinBar(ctx); if (p) raw.push(p); }
  // Marubozu is a self-contained trigger — no confirmation candle needed, so
  // evaluate it on the last closed candle (length - 1), not the pre-last one.
  if (has('marubozu-bullish')) { const p = detectMarubozuBullish({ ...ctx, index: candles.length - 1 }); if (p) raw.push(p); }
  if (has('marubozu-bearish')) { const p = detectMarubozuBearish({ ...ctx, index: candles.length - 1 }); if (p) raw.push(p); }
  if (has('inverted-hammer')) { const p = detectInvertedHammer(ctx); if (p) raw.push(p); }
  if (has('hanging-man')) { const p = detectHangingMan(ctx); if (p) raw.push(p); }

  // BUGFIX (аудит 2026-09-12): Hammer и Doji раньше вызывались на "голой"
  // свече без PatternContext (без проверки тренда/сессии/подтверждения) —
  // см. подробный комментарий в single.ts. Приведены к тому же
  // context-aware вызову, что Inverted Hammer/Hanging Man выше: `ctx`
  // (patternCandle = length-2, confirmCandle = length-1). Doji оценивает
  // саму последнюю закрытую свечу (нет отдельной подтверждающей свечи),
  // поэтому индекс сдвинут на length-1, как у Marubozu.
  if (has('hammer')) { const p = detectHammer(ctx); if (p) raw.push(p); }
  if (has('doji')) { const p = detectDoji({ ...ctx, index: candles.length - 1 }); if (p) raw.push(p); }
  if (has('spinning-top')) { const p = detectSpinningTop(last); if (p) raw.push(p); }

  // Double-bar patterns (context-aware) — BUGFIX (аудит 2026-09-12): Harami
  // раньше вызывался как detectBullishHarami(prev, last) вообще без
  // контекста (был явно помечен в double.ts как "UNCHANGED (out of scope
  // for this refactor)") — ни тренда, ни сессии, ни объёма, ни
  // подтверждения. Теперь использует doubleCtx (prevCandle=index-1,
  // curCandle=index, confirmCandle=index+1), см. подробности в double.ts.
  // Вызов перенесён ниже, после построения doubleCtx.
  // BUGFIX (аудит 2026-09-05): требуется 3 свечи — mother/inside/breakout —
  // паттерн больше не триггерит на закрытии самой inside-свечи (см.
  // inside-bar.ts).
  if (has('inside-bar') && candles.length >= 3) {
    const p = detectInsideBar(candles[candles.length - 3], prev, last);
    if (p) raw.push(p);
  }

  // Double-bar patterns (context-aware): Engulfing / Piercing Line / Dark
  // Cloud Cover / Tweezer Bottom / Tweezer Top. These are two-candle patterns
  // with an optional (Engulfing/Piercing/Dark Cloud) or mandatory (Tweezer)
  // 3rd-candle confirmation, so the window shifts one candle back relative
  // to the single-bar ctx above: prevCandle/curCandle form the pattern,
  // confirmCandle is the candle after it.
  if (candles.length >= 3) {
    const curCandle = candles[candles.length - 2];
    const doubleCtx: PatternContext = {
      ...ctx,
      index: candles.length - 2,
      session: getSessionRegime(curCandle.time * 1000),
    };
    if (has('bullish-engulfing')) { const p = detectBullishEngulfing(doubleCtx); if (p) raw.push(p); }
    if (has('bearish-engulfing')) { const p = detectBearishEngulfing(doubleCtx); if (p) raw.push(p); }
    if (has('piercing-line')) { const p = detectPiercingLine(doubleCtx); if (p) raw.push(p); }
    if (has('dark-cloud-cover')) { const p = detectDarkCloudCover(doubleCtx); if (p) raw.push(p); }
    if (has('tweezer-bottom')) { const p = detectTweezerBottom(doubleCtx); if (p) raw.push(p); }
    if (has('tweezer-top')) { const p = detectTweezerTop(doubleCtx); if (p) raw.push(p); }
    if (has('bullish-harami')) { const p = detectBullishHarami(doubleCtx); if (p) raw.push(p); }
    if (has('bearish-harami')) { const p = detectBearishHarami(doubleCtx); if (p) raw.push(p); }
  }

  // Triple-bar patterns (context-aware, требуют минимум 4 закрытых свечи:
  // a, b, c + свеча-подтверждение "4-я свеча" по методичкам Model B).
  if (candles.length >= 4) {
    const tripleCtx: TripleContext = {
      candles,
      structure: structure ?? DEFAULT_STRUCTURE,
      htfStructure,
      session: getSessionRegime(candles[candles.length - 2].time * 1000),
      smartMoney: smartMoney ?? EMPTY_SMART_MONEY,
      indicators: snapshot,
    };
    if (has('morning-star')) { const p = detectMorningStar(tripleCtx); if (p) raw.push(p); }
    if (has('evening-star')) { const p = detectEveningStar(tripleCtx); if (p) raw.push(p); }
    if (has('three-white-soldiers')) { const p = detectThreeWhiteSoldiers(tripleCtx); if (p) raw.push(p); }
    if (has('three-black-crows')) { const p = detectThreeBlackCrows(tripleCtx); if (p) raw.push(p); }
    if (has('abandoned-baby-bottom')) { const p = detectAbandonedBabyBottom(tripleCtx); if (p) raw.push(p); }
    if (has('abandoned-baby-top')) { const p = detectAbandonedBabyTop(tripleCtx); if (p) raw.push(p); }
  }

  // Continuation patterns (context-aware, требуют минимум 5 закрытых свечей:
  // импульс + 3 свечи консолидации + свеча-подтверждение "5-я свеча"; сам
  // детектор дополнительно требует TREND_LOOKBACK свечей тренда перед ними).
  // last здесь — это candles[length-1] (свеча 5), поэтому сессия считается
  // по её времени, а не по patternCandle/curCandle, как у double/triple-
  // паттернов выше, где паттерн заканчивается на candles[length-2].
  if (candles.length >= 5) {
    const continuationLast = candles[candles.length - 1];
    const continuationCtx: ContinuationContext = {
      candles,
      structure: structure ?? DEFAULT_STRUCTURE,
      session: getSessionRegime(continuationLast.time * 1000),
      smartMoney: smartMoney ?? EMPTY_SMART_MONEY,
      indicators: snapshot,
    };
    if (has('rising-three-methods')) { const p = detectRisingThreeMethods(continuationCtx); if (p) raw.push(p); }
    if (has('falling-three-methods')) { const p = detectFallingThreeMethods(continuationCtx); if (p) raw.push(p); }
  }

  // SMC / structure patterns
  if (has('impulse-breakout')) { const p = detectImpulseBreakout(candles, snapshot, ctx.structure, ctx.session, 20, atrPeriod); if (p) raw.push(p); }
  if (has('consolidation-breakout')) { const p = detectConsolidationBreakout(candles, ctx.structure, ctx.session, 10, atrPeriod); if (p) raw.push(p); }
  if (has('liquidity-sweep')) { const p = detectLiquiditySweep(candles, ctx.structure, ctx.session, ctx.smartMoney, 20, atrPeriod); if (p) raw.push(p); }
  if (has('liquidity-sweep-reaction')) { const p = detectLiquiditySweepReaction(candles, ctx.structure, ctx.session, ctx.smartMoney, atrPeriod); if (p) raw.push(p); }
  // BUGFIX (аудит 2026-09-06, п.3, и 2026-09-12 §1): htfStructure теперь
  // считается один раз в начале detectAllPatterns (см. выше) на реально
  // ресэмплированных M15-барах и переиспользуется единообразно всеми
  // context-aware паттернами — single/double/triple (через
  // htfAlignment/htfAlignmentStrict) и mean-reversion/strong-order-block-
  // reaction ниже — вместо отдельного локального вычисления здесь только
  // для двух последних детекторов.
  if (has('mean-reversion') && snapshot) {
    const rsiShortArr = calcRsi(candles.map((c) => c.close), 7);
    const rsiShort = rsiShortArr[rsiShortArr.length - 1];
    const p = detectMeanReversion(candles, snapshot, rsiShort, ctx.session, htfStructure);
    if (p) raw.push(p);
  }
  if (has('strong-order-block-reaction')) { const p = detectStrongOrderBlockReaction(candles, ctx.structure, ctx.session, ctx.smartMoney, atrPeriod, htfStructure); if (p) raw.push(p); }
  if (has('order-block-continuation')) { const p = detectOrderBlockContinuation(candles, snapshot, ctx.session, ctx.structure, ctx.smartMoney); if (p) raw.push(p); }
  if (has('macd-deceleration-continuation')) { const p = detectMacdDecelerationContinuation(candles, snapshot, ctx.session, macdConfig, ctx.smartMoney); if (p) raw.push(p); }

  // "Стратегии на FVG" — Strategies A-D (see fvg-strategies-shared.ts for
  // the shared scoring engine sourced from the strategy document).
  if (has('fvg-return')) { const p = detectFvgReturn(candles, snapshot, ctx.structure, ctx.session, ctx.smartMoney); if (p) raw.push(p); }
  if (has('fvg-breaker-block')) { const p = detectFvgBreakerBlock(candles, snapshot, ctx.session, ctx.smartMoney); if (p) raw.push(p); }
  if (has('fvg-nested')) { const p = detectFvgNested(candles, snapshot, ctx.session, ctx.smartMoney); if (p) raw.push(p); }
  if (has('fvg-rejection')) { const p = detectFvgRejection(candles, snapshot, ctx.session, ctx.smartMoney); if (p) raw.push(p); }

  // OB Breaker Block / Nested OB — same family, built on smart-money.ts's
  // `breakerBlocks`/`orderBlocks` instead of FVGs.
  if (has('order-block-breaker')) { const p = detectOrderBlockBreaker(candles, snapshot, ctx.session, ctx.smartMoney); if (p) raw.push(p); }
  if (has('order-block-nested')) { const p = detectOrderBlockNested(candles, snapshot, ctx.session, ctx.smartMoney); if (p) raw.push(p); }

  if (has('harmonic-pattern')) {
    const p = detectHarmonicPattern(candles, snapshot, ctx.session, ctx.structure, ctx.smartMoney, harmonicConfig);
    if (p) raw.push(p);
  }

  return raw.map(applyConfidenceHierarchy);
}

export function detectPatterns(candles: Candle[]): PatternResult[] {
  return detectAllPatterns(candles, [] as FeatureName[], undefined);
}


