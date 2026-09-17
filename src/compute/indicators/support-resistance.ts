import type { Candle } from '@/types/domain';
import { lastNonNull } from './helpers';
import { atr } from './atr';

export interface SupportResistanceLevel {
  price: number;
  type: 'support' | 'resistance';
  touches: number;
  strength: number;
  isPsychological: boolean;
}

const FRACTAL_BARS = 2;
const MIN_TOUCHES = 2;

export function supportResistance(
  candles: Candle[],
  atrPeriod: number = 14,
): SupportResistanceLevel[] {
  if (candles.length < atrPeriod + FRACTAL_BARS * 2 + 1) return [];

  const atrArr = atr(candles, atrPeriod);
  const atrValue = lastNonNull(atrArr);
  const clusterThreshold = atrValue !== null ? atrValue * 0.5 : computeFallbackThreshold(candles);

  const fractalHighs = findFractals(candles, 'high');
  const fractalLows = findFractals(candles, 'low');

  const resistanceLevels = clusterLevels(fractalHighs, clusterThreshold, 'resistance');
  const supportLevels = clusterLevels(fractalLows, clusterThreshold, 'support');

  const all = [...resistanceLevels, ...supportLevels];
  const lastClose = candles[candles.length - 1].close;

  for (const level of all) {
    level.strength = computeStrength(level, lastClose, atrValue);
    level.isPsychological = isPsychologicalLevel(level.price);
  }

  return all.sort((a, b) => b.strength - a.strength);
}

function findFractals(candles: Candle[], type: 'high' | 'low'): number[] {
  const extremes: number[] = [];
  for (let i = FRACTAL_BARS; i < candles.length - FRACTAL_BARS; i++) {
    let isExtreme = true;
    for (let j = 1; j <= FRACTAL_BARS; j++) {
      if (type === 'high') {
        if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) {
          isExtreme = false;
          break;
        }
      } else {
        if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) {
          isExtreme = false;
          break;
        }
      }
    }
    if (isExtreme) extremes.push(type === 'high' ? candles[i].high : candles[i].low);
  }
  return extremes;
}

function clusterLevels(
  extremes: number[],
  threshold: number,
  type: 'support' | 'resistance',
): SupportResistanceLevel[] {
  if (extremes.length === 0) return [];

  const sorted = [...extremes].sort((a, b) => a - b);
  const clusters: number[][] = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    const lastCluster = clusters[clusters.length - 1];
    const avg = lastCluster.reduce((a, b) => a + b, 0) / lastCluster.length;
    if (Math.abs(sorted[i] - avg) < threshold) {
      lastCluster.push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }

  return clusters
    .filter((c) => c.length >= MIN_TOUCHES)
    .map((c) => {
      const avgPrice = c.reduce((a, b) => a + b, 0) / c.length;
      return {
        price: avgPrice,
        type,
        touches: c.length,
        strength: 0,
        isPsychological: false,
      };
    });
}

function computeStrength(
  level: SupportResistanceLevel,
  lastClose: number,
  atrValue: number | null,
): number {
  let strength = level.touches;
  if (level.isPsychological) strength += 1;
  if (level.touches >= 4) strength += 1;
  const distance = Math.abs(level.price - lastClose);
  if (atrValue !== null && distance < atrValue) strength += 0.5;
  return strength;
}

function isPsychologicalLevel(price: number): boolean {
  const logPrice = Math.log10(Math.abs(price));
  const majorRound = Math.pow(10, Math.floor(logPrice));
  const remainder = price % majorRound;
  return remainder < majorRound * 0.001 || remainder > majorRound * 0.999;
}

function computeFallbackThreshold(candles: Candle[]): number {
  const ranges = candles.slice(-20).map((c) => c.high - c.low);
  const avg = ranges.reduce((a, b) => a + b, 0) / Math.max(1, ranges.length);
  return avg * 0.5;
}
