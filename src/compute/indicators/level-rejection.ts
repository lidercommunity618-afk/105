import type { Candle } from '@/types/domain';
import { supportResistance } from './support-resistance';
import { atr } from './atr';
import { lastNonNull } from './helpers';

export interface LevelRejectionTouch {
  time: number;
  wickRatio: number;
  closedBackOutside: boolean;
}

export type LevelRejectionStatus = 'untested' | 'tested-hold' | 'broken';

export interface LevelRejectionZone {
  price: number;
  type: 'support' | 'resistance';
  direction: 'bullish' | 'bearish';
  zoneHigh: number;
  zoneLow: number;
  touchCount: number;
  rejections: LevelRejectionTouch[];
  status: LevelRejectionStatus;
  strengthScore: number;
  levelStrength: number;
}

const ZONE_WIDTH_ATR_MULT = 0.35;

export function analyzeLevelTouches(
  candles: Candle[],
  type: 'support' | 'resistance',
  zoneHigh: number,
  zoneLow: number,
): { touchCount: number; rejections: LevelRejectionTouch[]; status: LevelRejectionStatus; strengthScore: number } {
  const direction: 'bullish' | 'bearish' = type === 'support' ? 'bullish' : 'bearish';
  let touchCount = 0;
  let strengthScore = 0.5;
  let status: LevelRejectionStatus = 'untested';
  const rejections: LevelRejectionTouch[] = [];

  for (const candle of candles) {
    if (direction === 'bullish' && candle.close < zoneLow) { status = 'broken'; break; }
    if (direction === 'bearish' && candle.close > zoneHigh) { status = 'broken'; break; }

    const enteredZone = candle.low <= zoneHigh && candle.high >= zoneLow;
    if (!enteredZone) continue;

    touchCount += 1;
    const range = Math.max(candle.high - candle.low, Number.EPSILON);
    const wick = direction === 'bullish'
      ? Math.min(candle.open, candle.close) - candle.low
      : candle.high - Math.max(candle.open, candle.close);
    const wickRatio = Math.max(0, Math.min(1, wick / range));
    const closedBackOutside = direction === 'bullish'
      ? candle.close >= zoneHigh
      : candle.close <= zoneLow;

    rejections.push({ time: candle.time, wickRatio, closedBackOutside });
    if (!closedBackOutside) continue;

    status = 'tested-hold';
    if (wickRatio >= 0.5) {
      // BUGFIX (аудит 2026-09-05): раньше бонус рос с touchCount без верхней
      // границы (`0.15 + 0.1 * touchCount`), то есть уровень, который тестят
      // 5-й раз подряд, выглядел для движка СИЛЬНЕЕ, чем свежий уровень —
      // это перевёрнутая логика. На практике каждое повторное тестирование
      // без сильного импульсного ухода расходует стоящую за уровнем
      // ликвидность и повышает вероятность его пробоя на следующем тесте
      // (см. Wyckoff, SMC liquidity sweep). Теперь бонус за касание убывает
      // (эффект "свежести" исчезает к 3-4 касанию), а после 3 касаний без
      // пробоя уровень начинает терять силу — level rejection, где 5
      // touchCount раньше давал максимум confidence, теперь корректно
      // отражает истощение уровня.
      const freshnessBonus = Math.max(0, 0.25 - 0.08 * (touchCount - 1));
      strengthScore = Math.min(1, strengthScore + freshnessBonus);
      if (touchCount > 3) {
        strengthScore = Math.max(0.15, strengthScore - 0.1 * (touchCount - 3));
      }
    } else {
      strengthScore = Math.max(0.15, strengthScore - 0.15 * touchCount);
    }
  }

  return { touchCount, rejections, status, strengthScore };
}

export function levelRejection(candles: Candle[], lookback: number = 100, atrPeriod: number = 14): LevelRejectionZone[] {
  if (candles.length < 20) return [];

  const levels = supportResistance(candles, 14);
  if (levels.length === 0) return [];

  const atrArr = atr(candles, atrPeriod);
  const atrValue = lastNonNull(atrArr);
  if (atrValue === null || atrValue <= 0) return [];

  const slice = candles.slice(-lookback);
  const zoneHalfWidth = atrValue * ZONE_WIDTH_ATR_MULT;

  const zones: LevelRejectionZone[] = [];
  for (const level of levels) {
    const zoneHigh = level.price + zoneHalfWidth;
    const zoneLow = level.price - zoneHalfWidth;
    const analysis = analyzeLevelTouches(slice, level.type, zoneHigh, zoneLow);
    if (analysis.touchCount === 0) continue;

    zones.push({
      price: level.price, type: level.type,
      direction: level.type === 'support' ? 'bullish' : 'bearish',
      zoneHigh, zoneLow,
      touchCount: analysis.touchCount, rejections: analysis.rejections,
      status: analysis.status, strengthScore: analysis.strengthScore,
      levelStrength: level.strength,
    });
  }

  return zones.filter((zone) => zone.status !== 'broken');
}
