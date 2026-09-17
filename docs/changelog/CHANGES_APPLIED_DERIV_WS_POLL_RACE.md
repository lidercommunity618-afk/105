# CHANGES_APPLIED_DERIV_WS_POLL_RACE.md — WS/polling гонка в DerivSource

Дата: 2026-08-30.

## Контекст

Аудит («Глубокий разбор: координация WebSocket + polling в DerivSource»)
нашёл, что `DerivSource` держит WS-стрим и REST fallback-polling запущенными
параллельно и безусловно (polling стартует в `connect()` сразу после
`subscribeStreams()`, без проверки, удался ли сабскрайб). Для форекс-
инструментов Deriv — ПЕРВИЧНЫЙ источник (см. `providers.config.ts` →
`ROUTING_CHAIN.forex`), поэтому в продакшен-конфигурации (не демо `app_id=1089`)
это не edge-case, а обычный рабочий режим.

Для закрытых свечей (`isClosed === true`) `ConnectionManager.emitCandleEvent()`
уже дедуплицирует по `lastClosedEmitTime`. Но апдейты ещё формирующейся
свечи (`isClosed === false`) сознательно не дедуплицируются — и именно
здесь оба потока (WS `msg.ohlc` на каждый тик и REST `poll()` раз в
3–120с, с собственной задержкой агрегации на стороне Deriv) присылали
разные снимки OHLC для одного и того же `candle.time`.

`useTickStore.handleCandle()` для повторного `candle.time` делал **полную
замену** объекта свечи (`candles[candles.length - 1] = candle`), тогда как
`handleTick()` (на каждый WS-тик) аккуратно расширял `high`/`low` через
`max`/`min`. Если между этими WS-тиками приходил устаревший REST-снимок с
более узким диапазоном, `handleCandle` целиком перезаписывал уже
накопленные `high`/`low` — видимая на графике регрессия фитиля свечи в
реальном времени, плюс лишний пересчёт индикаторов/сигнала на
заведомо худших данных.

## Что изменено

### 1. `src/data/sources/deriv.ts` — polling как health-watchdog

Добавлены `streamHealthy` / `lastStreamMessageAt`. `subscribeStreams()`
помечает стрим здоровым сразу после успешной подписки; `handleMessage()`
обновляет `lastStreamMessageAt` на каждый `msg.tick`/`msg.ohlc`;
`ws.onclose` сбрасывает `streamHealthy = false`. `startFallbackPolling()`
теперь пропускает реальный REST-запрос (`this.poll(...)`), если стрим
свежий (`streamHealthy && Date.now() - lastStreamMessageAt <= intervalMs * 2`).

Для публичного `app_id=1089` (без поддержки подписок) поведение не
меняется: `subscribeStreams()` всегда падает/не подтверждается, стрим
никогда не становится healthy, poll работает как раньше на каждом тике
таймера.

### 2. `src/stores/useTickStore.ts` — merge вместо полной замены

`handleCandle()` для повторного `candle.time` теперь мержит новый снимок
с уже накопленным вместо полной перезаписи:

```ts
candles[candles.length - 1] = {
  ...candle,
  open: last.open,               // open фиксирован первым снимком
  high: Math.max(last.high, candle.high),
  low: Math.min(last.low, candle.low),
};
```

Это защищает не только от WS/poll-рассинхрона в Deriv, но и от любого
другого источника «свежее, но с более узким диапазоном» апдейта одной и
той же формирующейся свечи.

## Тесты

- `src/data/sources/deriv.test.ts` — добавлены 2 теста: polling не
  запускает реальный REST-запрos, пока стрим свежий (heartbeat каждую
  секунду), и polling возобновляется, когда стрим замолкает дольше
  `intervalMs * 2`. Заодно в `MockWebSocket` добавлены статические
  константы `OPEN`/`CONNECTING`/`CLOSING`/`CLOSED` — без них
  `readyState !== WebSocket.OPEN` в проверках `send()`/`subscribeStreams()`
  сравнивался с `undefined` и всегда был `true`, из-за чего эти методы
  тихо ничего не отправляли в тестовом окружении (существующий тест этого
  не замечал, потому что `fetchHistory` был замокан целиком и не проходил
  через реальный `send()`). Существующий тест на fallback-polling обновлён,
  чтобы явно резолвить оба запроса подписки (`ticks`/`ohlc`), иначе он
  зависал бы на `requestTimeoutMs`.
- `src/stores/useTickStore.test.ts` — добавлены 2 теста: более узкий
  поздний апдейт не регрессирует `high`/`low` и не переписывает `open`;
  более широкий поздний апдейт по-прежнему расширяет `high`/`low` как
  раньше.

## Проверка

```
npx tsc --noEmit                      → без ошибок
npx vitest run                        → 48 файлов, 622 теста, всё зелёное
```
