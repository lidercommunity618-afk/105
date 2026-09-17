# Strategy bonus direction gate — fix (2026-09-06, follow-up to LOSS_STREAK_AUDIT_20260906)

## Баг A (серьёзный, подтверждён тестом)

Устраняя двойной учёт паттерна (см. `CHANGES_APPLIED_LOSS_STREAK_AUDIT_20260906.md`, п.4),
`components.trigger` был обнулён в `direction-prediction.ts` для всех 10
"strategy-бонусных" паттернов (`STRATEGY_BONUS_PATTERNS`) — их единственный
голос в определении итогового `direction` (structure + zones + liquidity +
indicator + bos + macd + meanReversion + trigger) исчез.

Блок начисления персонального strategy-бонуса в `signal-builder.ts`
(`evaluateEvidence`) при этом не проверял, что `topPattern.direction`
совпадает с уже вычисленным `direction` — бонус применялся, просто если
`topPattern` вообще был обнаружен и выбран `selectTopPattern`.

Результат: паттерн `order-block-continuation`, обнаруженный как BUY
(confidence 100%), мог достаться SELL-сигналу, если остальные компоненты
(structure/BOS/MACD/EMA) перетягивали `direction` в другую сторону:

```
signal.direction: 'sell'
signal.reason: '... OBC strategy (+0.55); ...'
```

До фикса двойного учёта это было маловероятным крайним случаем — `trigger`
(вес 1.5) обычно доминировал и сам тянул `direction` к стороне паттерна.
После обнуления `trigger` для этих 10 паттернов это стало системным риском
для каждого из них, а не редким исключением.

## Фикс

В `signal-builder.ts::evaluateEvidence` добавлена проверка направления перед
всем блоком из 10 strategy-бонусов:

```ts
if (topPattern && topPattern.direction === direction) {
  // ...10 веток бонусов (OBC, MDM, fvg-nested, fvg-breaker-block,
  // fvg-rejection, fvg-return, order-block-nested, order-block-breaker,
  // impulse-breakout, liquidity-sweep-reaction)
}
```

Если `topPattern.direction !== direction`, ни один из бонусов не
применяется — паттерн просто не голосует (не штрафуется в обратную
сторону; штраф за противоречащий паттерн — отдельный вопрос политики, не
входит в рамки этого фикса).

## Тесты

Добавлены в `signal-builder.test.ts`
(`describe('buildSignal — strategy bonus direction gate ...')`):

- Регрессионный тест, воспроизводящий баг: BUY `order-block-continuation`
  на явно медвежьем сетапе (structure=down+bos, EMA/MACD/RSI все sell) →
  итоговый `signal.direction === 'sell'`, `reason` НЕ содержит
  `'OBC strategy'`, и среди `factors` нет `kind: 'strategy'` для
  `order-block-continuation`.
- Контрольный тест на отсутствие регрессии: тот же BUY-паттерн на бычьем
  сетапе (structure=up+bos, EMA/MACD/RSI все buy) → `direction === 'buy'`,
  `reason` содержит `'OBC strategy'` как раньше.

## Прогон

- `tsc --noEmit --strict` — 0 ошибок.
- `vitest run` — 57/57 файлов, 723/723 теста (721 существовавших + 2 новых).
  Единственные 2 теста, которые падают без `VITE_SUPABASE_URL`/
  `VITE_SUPABASE_ANON_KEY` в окружении (`gemini-analysis.test.ts`), — заново
  подтверждены как чисто окружение: с фейковыми значениями оба зелёные,
  правки этого фикса на них не влияют.
- `vite build` — собирается без ошибок.
