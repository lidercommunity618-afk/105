# Fix: orphan-сделки резолвились по устаревшей цене сигнала, а не по реальной цене входа

## Симптом (со слов пользователя)

Демо-счёт и статистика внизу терминала показывают убыток по сделке,
хотя относительно сигнала (реального движения цены от точки входа)
сделка должна была закрыться в прибыль — и так несколько сделок
подряд.

Мартингейл-переключатель для демо-счёта при этом был проверен отдельно
(`resolveTrade()` в `useDemoAccountStore.ts` + 43 существующих теста в
`useDemoAccountStore.test.ts`) и работает корректно: при
`martingaleEnabled === false` любая убыточная сделка сбрасывает стадию
в 0, не повышая её — баг не в этом переключателе.

## Корневая причина

`useDemoAccountStore.ts` хранит для каждой сделки два разных источника
цены входа:

- `trade.entryPrice` — реальная цена открытия свечи входа,
  подтверждается **живьём**, через `confirmEntryPrice()`, вызываемую из
  `useTickStore.ts::handleCandle` в момент появления этой свечи в
  потоке.
- `trade.fallbackEntryPrice` — это `signal.entryPrice`, то есть цена
  **закрытия ещё формирующейся свечи в момент самого сигнала**
  (pre-close, см. комментарий в `tick-store/pre-close.ts`) — точка
  ДО того, как свеча входа вообще открылась.

`resolveTrade()` резолвит сделку по `trade.entryPrice ?? trade.fallbackEntryPrice`.
Если сделка "осиротела" — приложение не получило live-событие "новая
свеча" для candleTime этой сделки, пока она была открыта (свёрнутая/
выгруженная вкладка, reload, resync/reconnect — сценарии, под которые
в проекте отдельно есть Wake Lock и обработка stale-состояния),
`confirmEntryPrice()` так и не был вызван, и `trade.entryPrice`
остаётся `null` на момент, когда `resolveFromHistory()` подхватывает
эту сделку из загруженной истории свечей.

`resolveFromHistory()` **уже находит** правильную свечу входа
(`entryCandle`, по `trade.candleTime`) и использует `entryCandle.close`
как цену экспирации — но `entryCandle.open` (реальная цена входа)
никак не использовался: сделка резолвилась через
`trade.fallbackEntryPrice`, то есть по цене ДО открытия свечи входа.
Если цена успела заметно сдвинуться между этими двумя точками (что и
происходит за то время, что вкладка была неактивна), сделка,
объективно выигрышная относительно реального входа, могла резолвиться
как убыточная — то самое расхождение, о котором сообщил пользователь,
причём воспроизводимое пачкой (все сделки, "осиротевшие" за время
неактивности вкладки, резолвятся в этом же вызове `resolveFromHistory`).

## Исправление

В `useDemoAccountStore.ts::resolveFromHistory()`: если
`trade.entryPrice === null` на момент резолюции, подтверждаем его из
уже найденной `entryCandle.open` **до** вызова `resolveTrade()`, вместо
того чтобы позволить ему молча упасть на `fallbackEntryPrice`. Если
`entryPrice` уже был подтверждён живьём — поведение не меняется
(используется он, `entryCandle.open` не участвует).

```ts
const resolvedTrade: DemoTrade = trade.entryPrice === null
  ? { ...trade, entryPrice: entryCandle.open }
  : trade;

const result = resolveTrade(resolvedTrade, entryCandle.close, closedAtMs, currentState, state.martingaleEnabled);
```

`checkExpiries()` (резолюция "вживую", в рамках одной непрерывной
сессии) в этом фиксе не нуждается: там `confirmEntryPrice()` гарантированно
успевает отработать раньше, чем свеча входа успевает закрыться, — это
два последовательных события в одном и том же непрерывном потоке
свечей.

## Тесты

Добавлены в `useDemoAccountStore.test.ts`:

- `resolveFromHistory uses the real entry candle open (not the stale
  fallbackEntryPrice) when entryPrice was never confirmed live` —
  воспроизводит баг (без фикса тест падает: сделка резолвилась бы как
  win по устаревшей цене 100, вместо loss по реальной цене входа 105) и
  проверяет исправленное поведение.
- `resolveFromHistory still respects an already-confirmed entryPrice
  (does not override with entryCandle.open)` — гарантирует, что фикс не
  трогает уже подтверждённые вживую сделки.

`npm run typecheck` — чисто. `npm run test` — 683/683 (было 681/681 до
добавления двух новых тестов).
