import type { Candle, PatternResult, SignalStrength } from '@/types/domain';
import { clamp01, averageVolume } from '@/compute/indicators/helpers';
import type { PatternContext } from './pattern-context';
import {
  sessionBoost,
  htfAlignment,
  volumeFactor,
  obFvgConfluenceBonus,
  nextCandleConfirmation,
  isAsiaOrClosed,
  hasPrecedingBullish,
  hasPrecedingBearish,
  intervalSeconds,
} from './pattern-context';

const DOJI_BODY_RATIO = 0.01;
// BUGFIX (аудит 2026-09-12, §2.2): раньше 0.6 — только у Hammer, тогда как
// геометрически идентичные Hanging Man/Inverted Hammer/Shooting Star
// хардкодили 0.35 для той же роли (макс. доля тела в диапазоне). Порог 0.6
// был по факту мёртвой константой: геометрический гейт чуть ниже
// (lowerWick >= body * 2, т.е. тело+обе тени = range ⇒ body/range ≤ 1/3)
// уже не пропускал body/range выше ~0.333 задолго до достижения 0.6 — то
// есть 0.6 никогда не был реальным ограничивающим порогом, только
// вводящий в заблуждение след неполного переноса рефакторинга. Не меняет
// поведение (эффективный порог и так был ~0.333, близко к 0.35), но
// убирает ложное впечатление, что Hammer сознательно допускает более
// "толстые" тела, чем его геометрический близнец Hanging Man.
const BODY_RATIO_THRESHOLD = 0.35;
const MARUBOZU_BODY_RATIO = 0.9;
const SPINNING_BODY_RATIO = 0.3;

function strengthForConfidence(confidence: number): SignalStrength {
  if (confidence >= 0.75) return 'strong';
  if (confidence >= 0.5) return 'moderate';
  return 'weak';
}

// ─────────────────────────────────────────────────────────────────────────
// Hammer — context-aware (BUGFIX аудит 2026-09-12: раньше принимал только
// `cur: Candle` и не проверял ничего, кроме формы свечи — ни тренда, ни
// сессии, ни подтверждения, ни объёма. Molot и Hanging Man — одна и та же
// геометрия (маленькое тело сверху, длинная нижняя тень, короткая/нулевая
// верхняя), различие исключительно в контексте тренда: Hammer валиден
// только как разворотный сигнал ПОСЛЕ нисходящего импульса; без этой
// проверки паттерн триггерил "buy" на любой бычьей свече с длинной нижней
// тенью независимо от того, где она произошла — в середине аптренда, на
// сопротивлении или в отсутствие тренда вообще — генерируя ложные сигналы
// на покупку. Дополнительно PATTERN_CONFIDENCE_HIERARCHY принудительно
// поднимал confidence такого нефильтрованного сигнала до пола 0.6
// (Math.max), то есть каждое срабатывание автоматически получало минимум
// "moderate" силу вне зависимости от контекста. Теперь паттерн приведён к
// тому же уровню строгости, что Inverted Hammer / Hanging Man: обязательный
// предшествующий медвежий импульс/даунтренд, запрет Азии/закрытого рынка,
// RSI-фильтр перепроданности, обязательное подтверждение следующей свечой
// ("золотое правило" методички), объёмный и OB/FVG-confluence мультипликаторы.
// ─────────────────────────────────────────────────────────────────────────
export function detectHammer(ctx: PatternContext): PatternResult | null {
  const { candles, index, structure, htfStructure, session, smartMoney, indicators } = ctx;
  if (candles.length < 2) return null;
  const patternCandle = candles[index];
  const confirmCandle = candles[candles.length - 1];

  // Must have preceding bearish impulse or down structure — иначе это не
  // разворотный Hammer, а случайная свеча с длинной нижней тенью.
  if (!hasPrecedingBearish(candles, index, 5) && structure.trend !== 'down') return null;

  if (isAsiaOrClosed(session)) return null;

  // RSI <= 40 required (if available) — паттерн должен появляться в зоне
  // перепроданности, иначе теряет разворотный смысл.
  if (indicators && indicators.rsi != null && indicators.rsi > 40) return null;

  const body = Math.abs(patternCandle.close - patternCandle.open);
  const range = patternCandle.high - patternCandle.low || 1e-9;
  if (body / range > BODY_RATIO_THRESHOLD) return null;
  const upperWick = patternCandle.high - Math.max(patternCandle.close, patternCandle.open);
  const lowerWick = Math.min(patternCandle.close, patternCandle.open) - patternCandle.low;
  if (lowerWick < body * 2) return null;
  if (upperWick > body * 0.5) return null;
  // Тело должно лежать в верхней трети диапазона (как у Hanging Man —
  // одинаковая геометрия, разный трендовый контекст). ВНИМАНИЕ: не путать
  // с Inverted Hammer/Shooting Star, где тело у НИЖНЕЙ границы диапазона.
  const bodyBottom = Math.min(patternCandle.open, patternCandle.close);
  if (bodyBottom < patternCandle.high - range * 0.33) return null;

  // Mandatory confirmation — hard reject without it (симметрично Hanging
  // Man, зеркальному паттерну по геометрии).
  const conf = nextCandleConfirmation(patternCandle, confirmCandle, 'buy');
  if (!conf.confirmed || conf.contradicted) return null;

  const avgVol = averageVolume(candles, 20, index);
  const volumeRatio = avgVol > 0 ? patternCandle.volume / avgVol : 1;

  const isBullishClose = patternCandle.close > patternCandle.open;
  const base = clamp01(
    Math.min(0.25, (lowerWick / body) * 0.15) +
    Math.min(0.15, (1 - body / range) * 0.10) +
    (isBullishClose ? 0.05 : 0),
  );

  const rsi = indicators?.rsi ?? null;
  const rsiFactor = rsi == null ? 1.0 : rsi <= 30 ? 1.10 : rsi <= 50 ? 1.0 : 0.8;

  const sb = sessionBoost(session);
  const ha = htfAlignment(htfStructure, 'buy');
  const vf = volumeFactor(volumeRatio);
  const obBonus = obFvgConfluenceBonus(smartMoney, patternCandle, 'buy', indicators?.atr ?? null, intervalSeconds(candles));

  const factors: string[] = [];
  if (conf.confirmed) factors.push('confirmed');
  if (volumeRatio > 1.5) factors.push('volume>150%');
  if (obBonus > 0) factors.push('ob-confluence');

  const confidence = clamp01(
    base * ha * sb * conf.multiplier * vf * rsiFactor + obBonus,
  );

  if (confidence < 0.45) return null;

  return {
    name: 'hammer',
    direction: 'buy',
    confidence,
    strength: strengthForConfidence(confidence),
    time: confirmCandle.time,
    volumeConfirmed: volumeRatio > 1.0,
    confirmedByNextCandle: true,
    confluenceFactors: factors.length > 0 ? factors : undefined,
  };
}

export function detectShootingStar(ctx: PatternContext): PatternResult | null {
  const { candles, index, structure, htfStructure, session, smartMoney, indicators } = ctx;
  if (candles.length < 2) return null;
  const patternCandle = candles[index];
  const confirmCandle = candles[candles.length - 1];

  // Must have preceding bullish impulse or up structure
  if (!hasPrecedingBullish(candles, index, 5) && structure.trend !== 'up') return null;

  // Reject if at support in downtrend — that's an Inverted Hammer, not Shooting Star
  if (structure.trend === 'down' && structure.swingLow != null) {
    const range = patternCandle.high - patternCandle.low || 1e-9;
    if (Math.abs(patternCandle.low - structure.swingLow) < range) return null;
  }

  if (isAsiaOrClosed(session)) return null;

  const body = Math.abs(patternCandle.close - patternCandle.open);
  const range = patternCandle.high - patternCandle.low || 1e-9;
  if (body / range > BODY_RATIO_THRESHOLD) return null;
  const upperWick = patternCandle.high - Math.max(patternCandle.close, patternCandle.open);
  const lowerWick = Math.min(patternCandle.close, patternCandle.open) - patternCandle.low;
  if (upperWick < body * 2) return null;
  if (lowerWick > body * 0.5) return null;
  const bodyTop = Math.max(patternCandle.open, patternCandle.close);
  if (bodyTop > patternCandle.low + range * 0.33) return null;

  const isBearishClose = patternCandle.close < patternCandle.open;

  // BUGFIX (аудит 2026-09-12, §2.1): Shooting Star был единственным
  // одиночным паттерном без обязательного подтверждения — раньше требовал
  // только отсутствие противоречия (conf.contradicted), но не сам факт
  // подтверждения (conf.confirmed), в отличие от геометрического "близнеца"
  // Hanging Man (та же форма тела/теней, разный трендовый контекст) и от
  // Hammer/Inverted Hammer, которые все требуют
  // `!conf.confirmed || conf.contradicted`. На практике это позволяло
  // Shooting Star срабатывать на "нейтральной" следующей свече (слабое,
  // неопределённое закрытие — multiplier: 0.85, confirmed: false), которую
  // симметричный Hanging Man в той же ситуации уже бы отклонил — асимметрия
  // без задокументированного намерения, создающая лишние ложноположительные
  // сигналы именно там, где идентичная геометрия их бы отсеяла.
  const conf = nextCandleConfirmation(patternCandle, confirmCandle, 'sell');
  if (!conf.confirmed || conf.contradicted) return null;

  const avgVol = averageVolume(candles, 20, index);
  const volumeRatio = avgVol > 0 ? patternCandle.volume / avgVol : 1;

  const base = clamp01(
    Math.min(0.30, (upperWick / body) * 0.15) +
    Math.min(0.10, (1 - lowerWick / body) * 0.10) +
    (isBearishClose ? 0.10 : 0.05),
  );

  const factors: string[] = [];
  const sb = sessionBoost(session);
  const ha = htfAlignment(htfStructure, 'sell');
  const vf = volumeFactor(volumeRatio);
  const obBonus = obFvgConfluenceBonus(smartMoney, patternCandle, 'sell', indicators?.atr ?? null, intervalSeconds(candles));

  if (session === 'overlap') factors.push('session:overlap');
  else if (session === 'london' || session === 'newyork') factors.push(`session:${session}`);
  if (volumeRatio > 1.5) factors.push('volume>150%');
  if (obBonus > 0) factors.push('ob-confluence');
  if (conf.confirmed) factors.push('confirmed');

  const confidence = clamp01(
    base * ha * sb * conf.multiplier * vf + obBonus,
  );

  if (confidence < 0.5) return null;

  return {
    name: 'shooting-star',
    direction: 'sell',
    confidence,
    strength: strengthForConfidence(confidence),
    time: confirmCandle.time,
    volumeConfirmed: volumeRatio > 1.0,
    confirmedByNextCandle: conf.confirmed,
    confluenceFactors: factors.length > 0 ? factors : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Doji — context-aware (BUGFIX аудит 2026-09-12: раньше брал только
// `cur: Candle` и назначал направление по тому, чуть выше или чуть ниже
// open закрылось тело — при отношении тела к диапазону < 1% это шум
// округления цены, а не сигнал. Doji по сути — свеча нерешительности:
// собственного направления у неё нет, разворотный смысл появляется только
// в контексте предшествующего тренда (доджи на дне даунтренда — потенциальный
// разворот вверх, доджи на вершине аптренда — вниз; доджи в диапазоне не
// несёт торгового значения вообще). Раньше функция генерировала "buy"/"sell"
// на КАЖДОЙ свече с исчезающе малым телом независимо от тренда, создавая
// произвольный директивный сигнал там, где реальный смысл — "рынок в
// нерешительности, жди подтверждения".
// ─────────────────────────────────────────────────────────────────────────
export function detectDoji(ctx: PatternContext): PatternResult | null {
  const { candles, index, structure, session } = ctx;
  const cur = candles[index];
  const body = Math.abs(cur.close - cur.open);
  const range = cur.high - cur.low || 1e-9;
  if (body / range >= DOJI_BODY_RATIO) return null;

  if (isAsiaOrClosed(session)) return null;

  // Направление определяется исключительно предшествующим трендом
  // (ожидание разворота), а не микроскопическим смещением close от open.
  const downTrend = hasPrecedingBearish(candles, index, 5) || structure.trend === 'down';
  const upTrend = hasPrecedingBullish(candles, index, 5) || structure.trend === 'up';
  if (downTrend === upTrend) return null; // range/нет чёткого тренда — доджи без значения

  const direction = downTrend ? 'buy' : 'sell';
  return {
    name: 'doji',
    direction,
    confidence: 0.3,
    strength: strengthForConfidence(0.3),
    time: cur.time,
  };
}

export function detectInvertedHammer(ctx: PatternContext): PatternResult | null {
  const { candles, index, structure, htfStructure, session, smartMoney, indicators } = ctx;
  if (candles.length < 2) return null;
  const patternCandle = candles[index];
  const confirmCandle = candles[candles.length - 1];

  // Must have preceding bearish impulse or down structure
  if (!hasPrecedingBearish(candles, index, 5) && structure.trend !== 'down') return null;

  if (isAsiaOrClosed(session)) return null;

  // RSI <= 40 required (if available)
  if (indicators && indicators.rsi != null && indicators.rsi > 40) return null;

  const body = Math.abs(patternCandle.close - patternCandle.open);
  const range = patternCandle.high - patternCandle.low || 1e-9;
  if (body / range > BODY_RATIO_THRESHOLD) return null;
  const upperWick = patternCandle.high - Math.max(patternCandle.close, patternCandle.open);
  const lowerWick = Math.min(patternCandle.close, patternCandle.open) - patternCandle.low;
  if (upperWick < body * 2) return null;
  if (lowerWick > body * 0.5) return null;
  const bodyTop = Math.max(patternCandle.open, patternCandle.close);
  if (bodyTop > patternCandle.low + range * 0.33) return null;

  // Mandatory confirmation — hard reject without it
  const conf = nextCandleConfirmation(patternCandle, confirmCandle, 'buy');
  if (!conf.confirmed || conf.contradicted) return null;

  const avgVol = averageVolume(candles, 20, index);
  const volumeRatio = avgVol > 0 ? patternCandle.volume / avgVol : 1;

  const isBullishClose = patternCandle.close > patternCandle.open;
  const base = clamp01(
    Math.min(0.25, (upperWick / body) * 0.15) +
    Math.min(0.15, (1 - body / range) * 0.10) +
    (isBullishClose ? 0.05 : 0),
  );

  const rsi = indicators?.rsi ?? null;
  const rsiFactor = rsi == null ? 1.0 : rsi <= 30 ? 1.10 : rsi <= 50 ? 1.0 : 0.8;

  const sb = sessionBoost(session);
  const ha = htfAlignment(htfStructure, 'buy');
  const vf = volumeFactor(volumeRatio);
  const obBonus = obFvgConfluenceBonus(smartMoney, patternCandle, 'buy', indicators?.atr ?? null, intervalSeconds(candles));

  const factors: string[] = [];
  if (conf.confirmed) factors.push('confirmed');
  if (volumeRatio > 1.5) factors.push('volume>150%');
  if (obBonus > 0) factors.push('ob-confluence');

  const confidence = clamp01(
    base * ha * sb * conf.multiplier * vf * rsiFactor + obBonus,
  );

  if (confidence < 0.45) return null;

  return {
    name: 'inverted-hammer',
    direction: 'buy',
    confidence,
    strength: strengthForConfidence(confidence),
    time: confirmCandle.time,
    volumeConfirmed: volumeRatio > 1.0,
    confirmedByNextCandle: true,
    confluenceFactors: factors.length > 0 ? factors : undefined,
  };
}

export function detectHangingMan(ctx: PatternContext): PatternResult | null {
  const { candles, index, structure, htfStructure, session, smartMoney, indicators } = ctx;
  if (candles.length < 2) return null;
  const patternCandle = candles[index];
  const confirmCandle = candles[candles.length - 1];

  // Must have preceding bullish impulse or up structure
  if (!hasPrecedingBullish(candles, index, 5) && structure.trend !== 'up') return null;

  if (isAsiaOrClosed(session)) return null;

  // RSI >= 60 required (if available)
  if (indicators && indicators.rsi != null && indicators.rsi < 60) return null;

  const body = Math.abs(patternCandle.close - patternCandle.open);
  const range = patternCandle.high - patternCandle.low || 1e-9;
  if (body / range > BODY_RATIO_THRESHOLD) return null;
  const upperWick = patternCandle.high - Math.max(patternCandle.close, patternCandle.open);
  const lowerWick = Math.min(patternCandle.close, patternCandle.open) - patternCandle.low;
  if (lowerWick < body * 2) return null;
  if (upperWick > body * 0.5) return null;
  const bodyBottom = Math.min(patternCandle.open, patternCandle.close);
  if (bodyBottom < patternCandle.high - range * 0.33) return null;

  // Mandatory confirmation — hard reject without it
  const conf = nextCandleConfirmation(patternCandle, confirmCandle, 'sell');
  if (!conf.confirmed || conf.contradicted) return null;

  const avgVol = averageVolume(candles, 20, index);
  const volumeRatio = avgVol > 0 ? patternCandle.volume / avgVol : 1;

  const isBearishClose = patternCandle.close < patternCandle.open;
  const base = clamp01(
    Math.min(0.25, (lowerWick / body) * 0.15) +
    Math.min(0.15, (1 - body / range) * 0.10) +
    (isBearishClose ? 0.05 : 0),
  );

  const rsi = indicators?.rsi ?? null;
  const rsiFactor = rsi == null ? 1.0 : rsi >= 70 ? 1.10 : rsi >= 50 ? 1.0 : 0.8;

  const sb = sessionBoost(session);
  const ha = htfAlignment(htfStructure, 'sell');
  const vf = volumeFactor(volumeRatio);
  const obBonus = obFvgConfluenceBonus(smartMoney, patternCandle, 'sell', indicators?.atr ?? null, intervalSeconds(candles));

  const factors: string[] = [];
  if (conf.confirmed) factors.push('confirmed');
  if (volumeRatio > 1.5) factors.push('volume>150%');
  if (obBonus > 0) factors.push('ob-confluence');

  const confidence = clamp01(
    base * ha * sb * conf.multiplier * vf * rsiFactor + obBonus,
  );

  if (confidence < 0.45) return null;

  return {
    name: 'hanging-man',
    direction: 'sell',
    confidence,
    strength: strengthForConfidence(confidence),
    time: confirmCandle.time,
    volumeConfirmed: volumeRatio > 1.0,
    confirmedByNextCandle: true,
    confluenceFactors: factors.length > 0 ? factors : undefined,
  };
}

export function detectMarubozuBullish(ctx: PatternContext): PatternResult | null {
  const { candles, index, structure, htfStructure, session, smartMoney, indicators } = ctx;
  const patternCandle = candles[index];

  if (isAsiaOrClosed(session)) return null;

  if (structure.trend === 'range' && !structure.bos && !structure.choch) return null;

  const body = Math.abs(patternCandle.close - patternCandle.open);
  const range = patternCandle.high - patternCandle.low || 1e-9;
  if (body / range < MARUBOZU_BODY_RATIO) return null;
  if (patternCandle.close <= patternCandle.open) return null;
  const upperWick = patternCandle.high - patternCandle.close;
  const lowerWick = patternCandle.open - patternCandle.low;
  if (upperWick > body * 0.05 || lowerWick > body * 0.05) return null;

  const avgVol = averageVolume(candles, 20, index);
  const volumeRatio = avgVol > 0 ? patternCandle.volume / avgVol : 1;
  if (volumeRatio < 1.0) return null;

  const base = clamp01(body / range);
  const sb = sessionBoost(session);
  const ha = htfAlignment(htfStructure, 'buy');
  const volMul = volumeRatio > 1.5 ? 1.2 : volumeRatio > 1.0 ? 1.0 : 0.6;
  const obBonus = obFvgConfluenceBonus(smartMoney, patternCandle, 'buy', indicators?.atr ?? null, intervalSeconds(candles));

  const factors: string[] = [];
  if (session === 'overlap') factors.push('session:overlap');
  if (volumeRatio > 1.5) factors.push('volume>150%');
  if (obBonus > 0) factors.push('ob-confluence');

  const confidence = clamp01(base * ha * sb * volMul + obBonus);
  if (confidence < 0.55) return null;

  return {
    name: 'marubozu-bullish',
    direction: 'buy',
    confidence,
    strength: strengthForConfidence(confidence),
    time: patternCandle.time,
    volumeConfirmed: true,
    confluenceFactors: factors.length > 0 ? factors : undefined,
  };
}

export function detectMarubozuBearish(ctx: PatternContext): PatternResult | null {
  const { candles, index, structure, htfStructure, session, smartMoney, indicators } = ctx;
  const patternCandle = candles[index];

  if (isAsiaOrClosed(session)) return null;

  if (structure.trend === 'range' && !structure.bos && !structure.choch) return null;

  const body = Math.abs(patternCandle.close - patternCandle.open);
  const range = patternCandle.high - patternCandle.low || 1e-9;
  if (body / range < MARUBOZU_BODY_RATIO) return null;
  if (patternCandle.close >= patternCandle.open) return null;
  const upperWick = patternCandle.high - patternCandle.open;
  const lowerWick = patternCandle.close - patternCandle.low;
  if (upperWick > body * 0.05 || lowerWick > body * 0.05) return null;

  const avgVol = averageVolume(candles, 20, index);
  const volumeRatio = avgVol > 0 ? patternCandle.volume / avgVol : 1;
  if (volumeRatio < 1.0) return null;

  const base = clamp01(body / range);
  const sb = sessionBoost(session);
  const ha = htfAlignment(htfStructure, 'sell');
  const volMul = volumeRatio > 1.5 ? 1.2 : volumeRatio > 1.0 ? 1.0 : 0.6;
  const obBonus = obFvgConfluenceBonus(smartMoney, patternCandle, 'sell', indicators?.atr ?? null, intervalSeconds(candles));

  const factors: string[] = [];
  if (session === 'overlap') factors.push('session:overlap');
  if (volumeRatio > 1.5) factors.push('volume>150%');
  if (obBonus > 0) factors.push('ob-confluence');

  const confidence = clamp01(base * ha * sb * volMul + obBonus);
  if (confidence < 0.55) return null;

  return {
    name: 'marubozu-bearish',
    direction: 'sell',
    confidence,
    strength: strengthForConfidence(confidence),
    time: patternCandle.time,
    volumeConfirmed: true,
    confluenceFactors: factors.length > 0 ? factors : undefined,
  };
}

export function detectSpinningTop(cur: Candle): PatternResult | null {
  const body = Math.abs(cur.close - cur.open);
  const range = cur.high - cur.low || 1e-9;
  if (range <= 0) return null;
  const bodyRatio = body / range;
  if (bodyRatio >= SPINNING_BODY_RATIO) return null;
  if (bodyRatio < DOJI_BODY_RATIO) return null;
  const upperWick = cur.high - Math.max(cur.close, cur.open);
  const lowerWick = Math.min(cur.close, cur.open) - cur.low;
  if (Math.abs(upperWick - lowerWick) > body * 1.5) return null;
  const direction = cur.close >= cur.open ? 'buy' : 'sell';
  const confidence = 0.25;
  return {
    name: 'spinning-top',
    direction,
    confidence,
    strength: strengthForConfidence(confidence),
    time: cur.time,
  };
}
