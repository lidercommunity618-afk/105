// Вынесено из decision/trade-levels.ts::computeLiquiditySweepTradeLevels при
// удалении файла (Фаза 1, "честный бинарный опцион" — структурные SL/TP
// убраны из движка целиком, т.к. бинарный опцион с фиксированной выплатой их
// не использует). Формула цены инвалидации (sweepBarLow/High ± buffer*ATR)
// сохранена БУКВАЛЬНО той же — только смысл изменился: раньше это была
// "куда ставить стоп", теперь это ЧИСТО диагностическое расстояние "на
// сколько цена должна была бы двинуться обратно, чтобы отменить саму идею
// свипа" — используется только как более строгий, специфичный для этого
// паттерна spread-гейт в signal-builder.ts (аудит #10/D3: общий
// spreadGateMultiplier=3 относительно ATR почти никогда не срабатывает
// именно там, где нужно). Никакой сделки на это расстояние не открывается
// и не резолвится — резолв всегда только по entryPrice vs цена закрытия на
// expiryBars (см. outcome-scheduler.ts).
export function sweepInvalidationDistance(
  entryPrice: number,
  direction: 'buy' | 'sell',
  sweepBarLow: number,
  sweepBarHigh: number,
  atrValue: number,
  buffer: number = 0.1,
): number {
  const invalidationPrice =
    direction === 'buy'
      ? sweepBarLow - atrValue * buffer
      : sweepBarHigh + atrValue * buffer;
  return Math.abs(entryPrice - invalidationPrice);
}
