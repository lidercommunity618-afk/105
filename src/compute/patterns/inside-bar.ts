import type { Candle, PatternResult, SignalStrength } from '@/types/domain';

function strengthForConfidence(confidence: number): SignalStrength {
  if (confidence >= 0.75) return 'strong';
  if (confidence >= 0.5) return 'moderate';
  return 'weak';
}

// BUGFIX (аудит 2026-09-05): старая версия принимала (prev, cur) и выдавала
// direction по цвету САМОЙ inside-свечи (`cur.close >= cur.open`) в момент
// её закрытия — то есть паттерн, название которого буквально означает
// "сжатие/нерешительность", торговался как немедленный триггер без
// какого-либо пробоя. На M1 внутри флэта/диапазона это ставка на случайный
// цвет микроскопической свечи, а не на реальное движение. Классическое
// прочтение price action: inside bar сам по себе — это ТОЛЬКО зона
// ожидания; торговый сигнал даёт следующая свеча, закрывшаяся ЗА пределами
// хая/лоу материнской свечи (подтверждённый пробой диапазона сжатия).
//
// Теперь функция принимает три свечи: mother (материнская), inside
// (сжатая, целиком внутри mother) и breakout (свеча ПОСЛЕ inside, чьё
// закрытие подтверждает направление). Пока breakout ещё не пробил
// диапазон mother — паттерн возвращает null (сделка не открывается,
// движок остаётся в ожидании).
export function detectInsideBar(mother: Candle, inside: Candle, breakout: Candle): PatternResult | null {
  const isInside = inside.high <= mother.high && inside.low >= mother.low;
  if (!isInside) return null;

  const motherRange = mother.high - mother.low || 1e-9;
  const insideRange = inside.high - inside.low || 1e-9;
  // Насколько сильно сжалась inside-свеча относительно материнской — чем
  // туже сжатие, тем более значим последующий пробой.
  const compression = Math.max(0, Math.min(1, 1 - insideRange / motherRange));

  const brokeUp = breakout.close > mother.high;
  const brokeDown = breakout.close < mother.low;
  if (!brokeUp && !brokeDown) return null; // всё ещё в сжатии — валидного триггера нет

  const direction = brokeUp ? 'buy' : 'sell';
  // Насколько решительно breakout-свеча прошла за границу mother — слабый
  // "прокол" на пару тиков менее надёжен, чем закрытие с запасом.
  const breakoutDistance = brokeUp ? breakout.close - mother.high : mother.low - breakout.close;
  const breakoutStrength = Math.max(0, Math.min(1, breakoutDistance / motherRange));

  const confidence = Math.max(0.3, Math.min(0.7, 0.35 + 0.2 * compression + 0.15 * breakoutStrength));

  return {
    name: 'inside-bar',
    direction,
    confidence,
    strength: strengthForConfidence(confidence),
    time: breakout.time,
  };
}
