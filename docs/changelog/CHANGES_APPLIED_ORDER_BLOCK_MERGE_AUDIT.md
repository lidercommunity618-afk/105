# CHANGES_APPLIED_ORDER_BLOCK_MERGE_AUDIT.md

Дата: 2026-08-27.

## Контекст

На вход поданы два приложения — оба ветки одного и того же коммита-предка,
независимо доработавшие Order Block (OB) поверх него:

- **`62-main-fvg-strategies-ob-unified-OB-FIXED.zip`** (далее **OB-FIXED**)
  — задокументирован в `CHANGES_APPLIED_ORDER_BLOCK_RENDER_FIX.md`. Только
  слой отрисовки: состояния Fresh/Tested/Invalidated, линия Mean Threshold
  (50% тела OB-свечи).
- **`62-main-fvg-strategies-ob-unified-FIXED-OB-UPDATE.zip`** (далее
  **FIXED-OB-UPDATE**) — задокументирован в
  `CHANGES_APPLIED_ORDER_BLOCK_SPEC.md`. Тот же слой отрисовки **плюс** два
  недостающих ICT-критерия валидности OB (FVG confluence, liquidity sweep)
  как opt-in информационные поля.

Обе ветки не трогали сам алгоритм поиска/инвалидации OB
(`smart-money.ts` цикл поиска, `super-order-block.ts`,
`order-block-strength.ts`) — он уже был корректен и прошёл более ранние
итерации аудита (см. `CHANGES_APPLIED_ORDER_BLOCK_RENDER_FIX.md`, раздел
«Проверено и подтверждено рабочим»). Расхождение между ветками — только в
двух местах: слое отрисовки (`ChartPanel.tsx`/`BoxOverlayPrimitive.ts`) и
наборе информационных полей на `SmartMoneyOrderBlock`.

## Найденные несоответствия и баги

### 1. БАГ в OB-FIXED: сборка проекта была красной (3 ошибки typecheck)

Проверено эмпирически: `npm install && tsc --noEmit -p tsconfig.app.json`
на OB-FIXED даёт **3 ошибки TS2739** в `src/compute/patterns.test.ts`
(строки 814, 1227, 1284) — три фикстуры `SmartMoneyOrderBlock`,
использующиеся в тестах паттернов (`Rising/Falling Three Methods` и др.),
не содержат обязательных (не-опциональных) полей `open`, `close`,
`meanThreshold`, которые сам же OB-FIXED добавил в интерфейс
`SmartMoneyOrderBlock`. Это значит: `npm run build` / `npm run typecheck`
/ `npm run ci` в OB-FIXED **падают**, несмотря на то что собственный
`CHANGES_APPLIED_ORDER_BLOCK_RENDER_FIX.md` заявляет о двух новых
регрессионных тестах в `smart-money.test.ts`, не упоминая, что старые
фикстуры в другом файле сломаны новыми обязательными полями. FIXED-OB-UPDATE
эту проблему уже не имеет — при добавлении полей его автор синхронно
обновил все три фикстуры (проверено: тот же `tsc --noEmit` на нём — 0
ошибок).

### 2. БАГ в OB-FIXED: код расходится с собственной документацией по отрисовке инвалидированного OB

`CHANGES_APPLIED_ORDER_BLOCK_RENDER_FIX.md` (документ, поставленный вместе
с OB-FIXED) прямо утверждает: у Invalidated-зоны «метка «iOB»», «линия mean
threshold не рисуется (реагировать больше не на что)». Фактический код
`ChartPanel.tsx` в OB-FIXED этого не делает:

```ts
label: isTested ? `OB×${ob.touchCount}` : 'OB',   // broken получает то же 'OB', что и fresh — не 'iOB'
...
midLine: true,
midLinePrice: ob.meanThreshold,                    // линия рисуется ВСЕГДА, включая broken
```

То есть сломанный (уже неторгуемый сигнальным движком) OB на графике
по-прежнему подписан как обычный `OB` и по-прежнему показывает точку
входа (Mean Threshold) — трейдер визуально не отличит мёртвую зону от
живой ни по подписи, ни по линии реакции, хотя именно это и было целью
правки. Ветка FIXED-OB-UPDATE это реализует корректно (label `iOB` для
broken, `mOB×N` для tested-hold, `midLinePrice: undefined` для broken —
проверено чтением кода и логики `BoxOverlayPrimitive`: строка рисуется
только когда `midLinePrice` передан).

### 3. Несоответствие в наборе учитываемых ICT-критериев валидности OB

Классическая ICT-методология перечисляет 4 критерия валидности Order
Block: displacement (импульс), structure confluence (BOS/CHoCH), **FVG
confluence** (импульс формирует Fair Value Gap) и **liquidity sweep**
(снятие ликвидности непосредственно перед импульсом). В обеих ветках уже
были первые два. OB-FIXED не добавляет оставшиеся два вообще.
FIXED-OB-UPDATE добавляет `hasFvgConfluence`/`hasLiquiditySweep` как
**information-only** флаги (не гейтят `status`/`validated` по умолчанию,
как и существующие `hasDisplacement`/`hasStructureConfluence`), с opt-in
строгими фильтрами `requireFvgConfluence`/`requireLiquiditySweep`
(по умолчанию `false`) — это не меняет текущий список блоков ни для
графика, ни для `pattern-context.ts`, ни для существующих тестов, но даёт
инфраструктуру для более строгой фильтрации там, где это нужно (например,
в будущей стратегии, которая торгует только «полные» ICT OB по всем 4
критериям).

## Решение

**За основу взята FIXED-OB-UPDATE** — она строго покрывает всё
содержимое OB-FIXED (то же самое разделение состояний Fresh/Tested/
Invalidated и Mean Threshold), но без двух вышеописанных багов, и
дополнительно закрывает методологический пробел (FVG confluence +
liquidity sweep). Единственное, что было в OB-FIXED и отсутствовало в
FIXED-OB-UPDATE — два регрессионных теста в `smart-money.test.ts`
(проверка, что `meanThreshold` — середина тела, а не геометрическая
середина бокса; проверка, что `broken` OB сохраняет `endTime`). Они,
по всей видимости, не попали в FIXED-OB-UPDATE, потому что эта ветка
переименовала поля `open`/`close` в `bodyTop`/`bodyBottom` и старые тесты
перестали бы собираться без адаптации.

## Что сделано в этой правке (над FIXED-OB-UPDATE)

1. **Восстановлены и адаптированы** оба регрессионных теста из OB-FIXED
   в `src/compute/indicators/smart-money.test.ts`, переписанные под
   актуальные поля `bodyTop`/`bodyBottom` вместо удалённых `open`/`close`.
2. **Добавлен новый тест** на инвариант opt-in фильтрации: строгий вызов
   (`requireFvgConfluence: true, requireLiquiditySweep: true`) никогда не
   должен возвращать больше блоков, чем обычный вызов — защищает именно
   то свойство («по умолчанию ничего не меняется для существующих
   потребителей»), на которое опирается вся FIXED-OB-UPDATE-доработка.
3. **Ничего в самой логике поиска/отрисовки не менялось** — код
   FIXED-OB-UPDATE для `smart-money.ts`, `BoxOverlayPrimitive.ts`,
   `ChartPanel.tsx` перенесён как есть; он уже прошёл проверку кодом (см.
   раздел «Найденные несоответствия» выше) и соответствует ICT-практике.

## Проверено

- `npm install` — 655 пакетов, чисто.
- `npm run typecheck` (`tsc --noEmit -p tsconfig.app.json`) — **0 ошибок**.
- `npx vitest run` для `smart-money.test.ts`, `patterns.test.ts`,
  `ob-geometry-consistency.test.ts` — **102/102 теста пройдено**.
- Контрольная проверка: тот же `tsc --noEmit` на исходном OB-FIXED
  воспроизводит ровно 3 заявленные выше ошибки TS2739 — подтверждает
  находку из раздела 1.

## Что осознанно не добавлялось (соответствует торговым нормам ICT/SMC)

- **Абсолютные pip-пороги** — не переносились ни в одной из веток и не
  добавлялись здесь: в проекте уже есть универсальный ATR-нормализованный
  порог (`minDisplacementAtrMultiple`), корректно работающий на любом
  инструменте/таймфрейме, в отличие от фиксированных пипсов.
- **OB Breaker Block** (инверсия роли зоны после пробоя) и **Nested OB**
  (мультитаймфреймовое вложение) — в кодовой базе для Order Block такой
  сущности нет вообще (в отличие от FVG, где Inversion FVG уже
  реализован). Это новые торговые сущности уровня сигнального движка
  (`src/decision/*`), а не точечный фикс поиска/отрисовки — требуют
  отдельного аудита влияния на существующие стратегии
  (`strong-order-block-reaction.ts`, `order-block-continuation.ts`),
  вне рамок этой задачи.
- Включение `requireFvgConfluence`/`requireLiquiditySweep` по умолчанию —
  сознательно не сделано: это ужесточит критерии валидности OB и незаметно
  сократит список блоков для всех существующих потребителей и стратегий
  без явного запроса на это.

## Изменённые файлы относительно FIXED-OB-UPDATE

- `src/compute/indicators/smart-money.test.ts` — 3 теста добавлены (см.
  выше), остальной файл не тронут.
- Этот файл (новый).

Ничего за пределами этого не менялось.
