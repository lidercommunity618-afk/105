import type { Candle, PatternResult, SignalStrength, IndicatorSnapshot, MarketStructure } from '@/types/domain';
import type { SessionRegime } from '@/compute/session-regime';
import { isHighLiquiditySession } from '@/compute/session-regime';
import { isAsiaOrClosed } from './pattern-context';

function strengthForConfidence(confidence: number): SignalStrength {
  if (confidence >= 0.75) return 'strong';
  if (confidence >= 0.5) return 'moderate';
  return 'weak';
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

const ENTRY_THRESHOLD = 0.65;
const ADX_HARD_BLOCK = 25;

// Mean reversion: close beyond BB + RSI(7) in extreme zone (>75/<25) + first
// reversal bar — see bolt-prompt-8-strategies-replacement.md Phase 3.1
// ("СТРАТЕГИЯ «ВОЗВРАТ К СРЕДНЕМУ»"). `htfStructure` is the HTF-approximated
// structure (computeStructure(candles, ~60), computed once by the caller —
// this detector no longer recomputes structure internally with a different
// lookback than the rest of the pipeline).
export function detectMeanReversion(
  candles: Candle[],
  snapshot: IndicatorSnapshot,
  rsiShort: number | null,
  session?: SessionRegime,
  htfStructure?: MarketStructure,
): PatternResult | null {
  if (candles.length < 5) return null;
  if (snapshot.bollingerUpper === null || snapshot.bollingerLower === null) return null;
  if (snapshot.bollingerMiddle === null) return null;
  if (snapshot.atr === null || snapshot.atr <= 0) return null;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const atrValue = snapshot.atr;

  // ПРИОРИТЕТ №1 — BOS-блокировка: если HTF-структура подтверждает тренд
  // в ТОМ ЖЕ направлении, что и исходный пробой BB (prev — бар выхода за
  // полосу), это уже не флэт-истощение, а продолжение тренда — mean
  // reversion полностью подавляется (×0), без исключений.
  // ВАЖНО: сравнение ведётся по prev.close (бар выхода), а не по last.close
  // (бар возврата) — last.close по определению паттерна уже вернулся внутрь
  // полос, поэтому сравнение entryPrice=last.close с границами BB здесь
  // почти никогда не сработало бы.
  if (htfStructure?.bos) {
    if (htfStructure.trend === 'up' && prev.close > snapshot.bollingerUpper) return null;
    if (htfStructure.trend === 'down' && prev.close < snapshot.bollingerLower) return null;
  }

  // Вторая линия обороны: сильный тренд по ADX запрещает вход в принципе,
  // даже если HTF BOS ещё не зафиксирован (более раннее предупреждение).
  if (snapshot.adx !== null && snapshot.adx > ADX_HARD_BLOCK) return null;

  const prevRange = prev.high - prev.low || 1e-9;
  const lastRange = last.high - last.low || 1e-9;
  const prevBody = Math.abs(prev.close - prev.open);
  const lastBody = Math.abs(last.close - last.open);

  // Геометрия баров: выходной бар должен быть решительным (не доджи), бар
  // возврата — ещё более решительным, оба — не мельче типичного бара по ATR.
  if (prevBody < prevRange * 0.4) return null;
  if (lastBody < lastRange * 0.5) return null;
  if (prevRange < atrValue) return null;
  if (lastRange < atrValue * 0.8) return null;

  const idealFlat = snapshot.adx !== null && snapshot.adx < 15;

  function finalizeConfidence(base: number, direction: 'buy' | 'sell'): PatternResult | null {
    let confidence = base;
    if (idealFlat) confidence *= 1.3;
    if (session && isHighLiquiditySession(session)) confidence *= 1.2;
    if (session && isAsiaOrClosed(session)) confidence *= 0.6;
    if (lastBody < lastRange * 0.3) confidence *= 0.7;

    confidence = clamp01(confidence);
    if (confidence < ENTRY_THRESHOLD) return null;

    return {
      name: 'mean-reversion',
      direction,
      confidence,
      strength: strengthForConfidence(confidence),
      time: last.time,
    };
  }

  // Bullish mean reversion: close was below lower BB, now reverses back inside
  if (prev.close < snapshot.bollingerLower && last.close > snapshot.bollingerLower) {
    if (rsiShort !== null && rsiShort < 25) {
      const depthBeyondBB = snapshot.bollingerLower - prev.close;
      const exitStrength = clamp01((depthBeyondBB / atrValue) / 2.0);
      const returnStrength = clamp01((lastBody / atrValue) / 1.5);
      const base = exitStrength * 0.5 + returnStrength * 0.5;
      const result = finalizeConfidence(base, 'buy');
      if (result) return result;
    }
  }

  // Bearish mean reversion: close was above upper BB, now reverses back inside
  if (prev.close > snapshot.bollingerUpper && last.close < snapshot.bollingerUpper) {
    if (rsiShort !== null && rsiShort > 75) {
      const depthBeyondBB = prev.close - snapshot.bollingerUpper;
      const exitStrength = clamp01((depthBeyondBB / atrValue) / 2.0);
      const returnStrength = clamp01((lastBody / atrValue) / 1.5);
      const base = exitStrength * 0.5 + returnStrength * 0.5;
      const result = finalizeConfidence(base, 'sell');
      if (result) return result;
    }
  }

  return null;
}
