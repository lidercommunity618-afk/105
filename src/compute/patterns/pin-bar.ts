import type { PatternResult, SignalStrength } from '@/types/domain';
import { clamp01, averageVolume } from '@/compute/indicators/helpers';
import type { PatternContext } from './pattern-context';
import {
  sessionBoost,
  htfAlignment,
  volumeFactor,
  obFvgConfluenceBonus,
  nextCandleConfirmation,
  isAsiaOrClosed,
  isNearSwingLevel,
  nearEma21InTrend,
  nearEma200,
  intervalSeconds,
} from './pattern-context';

const PIN_BAR_MAX_BODY_RATIO = 0.33;

function strengthForConfidence(confidence: number): SignalStrength {
  if (confidence >= 0.75) return 'strong';
  if (confidence >= 0.5) return 'moderate';
  return 'weak';
}

export function detectPinBar(ctx: PatternContext): PatternResult | null {
  const { candles, index, structure, session, smartMoney, indicators } = ctx;
  if (candles.length < 2) return null;
  const patternCandle = candles[index];
  const confirmCandle = candles[candles.length - 1];

  const body = Math.abs(patternCandle.close - patternCandle.open);
  const range = patternCandle.high - patternCandle.low || 1e-9;
  if (body > range * PIN_BAR_MAX_BODY_RATIO) return null;

  const upperWick = patternCandle.high - Math.max(patternCandle.close, patternCandle.open);
  const lowerWick = Math.min(patternCandle.close, patternCandle.open) - patternCandle.low;

  // Determine direction: bullish (long lower wick) or bearish (long upper wick)
  let direction: 'buy' | 'sell' | null = null;
  let dominantWick = 0;

  if (lowerWick > range * 0.6 && lowerWick >= body * 2) {
    direction = 'buy';
    dominantWick = lowerWick;
    // Body must be in the upper third (opposite the dominant wick)
    const bodyTop = Math.max(patternCandle.open, patternCandle.close);
    if (bodyTop < patternCandle.high - range * 0.33) return null;
  } else if (upperWick > range * 0.6 && upperWick >= body * 2) {
    direction = 'sell';
    dominantWick = upperWick;
    // Body must be in the lower third (opposite the dominant wick)
    const bodyBottom = Math.min(patternCandle.open, patternCandle.close);
    if (bodyBottom > patternCandle.low + range * 0.33) return null;
  } else {
    return null;
  }

  // Must be near a key zone: OB/FVG or swing level
  const atrValue = indicators?.atr ?? null;
  const intervalSec = intervalSeconds(candles);
  const nearOB = obFvgConfluenceBonus(smartMoney, patternCandle, direction, atrValue, intervalSec) > 0;
  const nearSwing = isNearSwingLevel(structure, patternCandle, atrValue);
  if (!nearOB && !nearSwing) return null;

  if (isAsiaOrClosed(session)) return null;

  const conf = nextCandleConfirmation(patternCandle, confirmCandle, direction);
  if (conf.contradicted) return null;

  // If no confirmation, use 0.9 multiplier only if structure alignment >= 0.75
  let confirmationMultiplier = conf.multiplier;
  if (!conf.confirmed && !conf.contradicted) {
    const alignment = htfAlignment(structure, direction);
    confirmationMultiplier = alignment >= 0.75 ? 0.9 : 0.85;
  }

  const avgVol = averageVolume(candles, 20, index);
  const volumeRatio = avgVol > 0 ? patternCandle.volume / avgVol : 1;

  const bodyAtNose = direction === 'buy'
    ? Math.max(patternCandle.open, patternCandle.close) > patternCandle.high - range * 0.33
    : Math.min(patternCandle.open, patternCandle.close) < patternCandle.low + range * 0.33;

  const base = clamp01(
    Math.min(0.25, (dominantWick / range) * 0.20) +
    Math.min(0.15, (1 - body / range) * 0.10) +
    (bodyAtNose ? 0.10 : 0.05),
  );

  const emaFactor = nearEma21InTrend(indicators, patternCandle, direction) ? 1.10 : nearEma200(indicators, patternCandle) ? 1.0 : 0.9;

  const sb = sessionBoost(session);
  const ha = htfAlignment(structure, direction);
  const vf = volumeFactor(volumeRatio);
  const obBonus = obFvgConfluenceBonus(smartMoney, patternCandle, direction, atrValue, intervalSec);

  const factors: string[] = [];
  if (nearOB) factors.push('ob-confluence');
  if (nearSwing) factors.push('swing-level');
  if (conf.confirmed) factors.push('confirmed');
  if (volumeRatio > 1.5) factors.push('volume>150%');
  if (session === 'overlap') factors.push('session:overlap');

  const confidence = clamp01(
    base * ha * sb * confirmationMultiplier * vf * emaFactor + obBonus,
  );

  if (confidence < 0.45) return null;

  return {
    name: 'pin-bar',
    direction,
    confidence,
    strength: strengthForConfidence(confidence),
    time: confirmCandle.time,
    volumeConfirmed: volumeRatio > 1.0,
    confirmedByNextCandle: conf.confirmed,
    confluenceFactors: factors.length > 0 ? factors : undefined,
  };
}
