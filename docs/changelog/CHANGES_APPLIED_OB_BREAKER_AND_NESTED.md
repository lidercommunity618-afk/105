# CHANGES_APPLIED_OB_BREAKER_AND_NESTED.md

Дата: 2026-08-28.

## Задача

Реализовать два пункта, ранее сознательно отложенные в
`CHANGES_APPLIED_ORDER_BLOCK_MERGE_AUDIT.md` («Что осознанно не
добавлялось») как отдельная задача уровня сигнального движка:

1. **OB Breaker Block** — инверсия роли зоны после полного пробоя
   (аналог уже реализованного Inversion FVG, но для Order Block).
2. **Nested OB** — мультитаймфреймовое вложение (аналог уже
   реализованной «Вложенный FVG», но для Order Block).

## Аудит перед реализацией (обязательное условие задачи)

Изучены `strong-order-block-reaction.ts` и `order-block-continuation.ts`.
Ключевая находка: **обе стратегии используют `super-order-block.ts` —
отдельный от `smart-money.ts` детектор Order Block**, с собственной
геометрией и скорингом. `smart-money.ts` (уже доработанный в прошлой
правке: `bodyTop/bodyBottom/meanThreshold`, `hasFvgConfluence`,
`hasLiquiditySweep`) в этих двух стратегиях не участвует вообще — они
читают из `smartMoney` только `obFvgConfluenceBonus` в
`pattern-context.ts`.

Следствие для архитектуры этой правки: **`strong-order-block-reaction.ts`
и `order-block-continuation.ts` не тронуты ни единой строкой** — они
физически не видят ни `orderBlocks`, ни новый `breakerBlocks` из
`smart-money.ts`, поэтому в них нечего аудировать на предмет «повлияет
ли новое поле». Обе новые фичи подключены как два новых независимых
паттерна-стратегии (`order-block-breaker`, `order-block-nested`),
читающие `smartMoney.breakerBlocks`/`smartMoney.orderBlocks` — по той же
модели, по которой уже сосуществуют `fvg-breaker-block.ts`/`fvg-nested.ts`
(источник — `smart-money.ts`) и `strong-order-block-reaction.ts` (источник
— `super-order-block.ts`) без конфликта.

**Если в будущем потребуется завести именно `super-order-block.ts` на эти
концепции** (Breaker/Nested в терминах уже используемой там стратегии) —
это отдельная задача с отдельным аудитом влияния на существующий
скоринг `strong-order-block-reaction.ts`/`order-block-continuation.ts`, вне
рамок текущей.

## 1. OB Breaker Block

### Геометрия и правило (smart-money.ts)

Новое поле `SmartMoneyResult.breakerBlocks`. Генерируется сразу после
основного цикла поиска Order Block, по каждому блоку со
`status === 'broken'`:

- **Инверсия полярности** — стандартное ICT-определение: пробитый
  bullish OB (несостоявшаяся поддержка) → bearish breaker
  (новое сопротивление); пробитый bearish OB → bullish breaker.
- **Геометрия зоны не меняется** — `top`/`bottom` и
  `bodyTop`/`bodyBottom`/`meanThreshold` копируются от источника: меняется
  только то, какая сторона считается «правильной» реакцией у зоны, а не
  сама зона.
- **Собственное отслеживание touch/break** — брейкер живёт своей
  реакцией начиная с момента инвалидации источника, реюзом
  `analyzeOBTouches` (та же функция, которой уже считается сам живой OB),
  не наследует `touchCount`/`rejections` источника — то же правило, по
  которому уже живёт Inversion FVG.
- **Флаги качества источника копируются** (`hasDisplacement`,
  `hasStructureConfluence`, `hasFvgConfluence`, `hasLiquiditySweep`) —
  брейкер от структурно подтверждённого OB считается более сильным, чем
  от пограничного.

### Отрисовка (ChartPanel.tsx)

Тот же жизненный цикл Fresh/Tested/Invalidated и та же mean-threshold
линия, что и у обычного OB, но **новая, третья цветовая пара**
(индиго/розовый), которую нельзя перепутать ни с OB (зелёный/красный),
ни с FVG (циан/оранжевый) — брейкер это структурно другая сущность
(бывший OB, торгуемый в противоположную сторону), а не ещё один OB.
Пунктирная рамка всегда (даже во «fresh»-состоянии) — визуальный маркер
«это производная зона», аналогично тому, как IFVG уже отличается от
FVG. Никакой новой настройки/легенды не заведено — брейкер идёт под тем
же тумблером `showOrderBlocks` и той же легендой «OB», как IFVG уже идёт
под `showImbalances`/«FVG».

### Стратегия (order-block-breaker.ts — новый файл)

Торгует классическую ICT-схему «пробой → ретест новой роли → отбой»:
цена вокруг возвращается в зону брейкера, свеча прокалывает её тенью и
закрывается обратно на «правильной» (пост-инверсионной) стороне,
следующая свеча подтверждает продолжение. Использует ту же схему
скоринга и порог входа (`FVG_SCORE_MIN_ENTRY`/95-балльная шкала), что и
вся семья FVG-стратегий — намеренно, для предсказуемости системы:
confluence-бонус здесь = «источник был структурно валиден»
(`hasDisplacement && hasStructureConfluence` брейкера).

**Важно: это не то же самое, что уже существующий `fvg-breaker-block.ts`.**
Тот файл использует термин «Breaker Block» для другого паттерна
(свеча-тень пробивает обычный FVG и отскакивает) — не настоящей
ICT-инверсии роли. Здесь — впервые в проекте реализована именно
эталонная ICT-инверсия, только для Order Block, а не для FVG.

## 2. Nested OB

### Логика (order-block-nested.ts — новый файл)

Мультитаймфреймовое вложение: непробитый OB на старшем таймфрейме
(синтетический M5 из M1 через `resampleCandles`, тот же приём и тот же
коэффициент `HTF_FACTOR=5`, что уже используются в `fvg-nested.ts`),
содержащий непробитый M1 OB того же направления, и цена сейчас в зоне
их пересечения.

Для HTF-стороны реюзается `calcSmartMoney()` на ресемплированных
свечах — **не отдельная копипаста геометрии**, как в `fvg-nested.ts`
(там нет лёгкого эквивалента `detectFvgGeometry` для OB, поэтому
использован уже проверенный полный детектор). Displacement (импульс
≥ 1.2×ATR) остаётся обязательным — это и есть «это настоящий
институциональный импульс, а не любое направленное закрытие». Structure
confluence (BOS) на HTF-срезе **намеренно отключён**
(`requireStructureConfluence: false`): требовать полноценный
pivot-based BOS на грубой HTF-шкале, посчитанный по короткому
синтетическому ресемплу, хрупко и будет подавлять валидные вложенные
сетапы; M1-сторона (`smartMoney.orderBlocks`, который передаётся в
стратегию уже посчитанным с `requireStructureConfluence: true` по
умолчанию) продолжает требовать структурное подтверждение на основном
таймфрейме — так что структурное качество не теряется полностью, только
не дублируется дважды на двух масштабах. Та же асимметрия, которую уже
неявно допускает `fvg-nested.ts`, используя структурно-агностичную
`detectFvgGeometry` для своей HTF-стороны.

### Приоритет в сигнальном движке (signal-builder.ts)

У `fvg-nested` в исходном документе стратегии зафиксирован «Максимальный
приоритет» (бонус 0.65) — у `order-block-breaker`/`order-block-nested`
такого источника нет (это новые сущности, не из исходного документа), их
веса — инженерное решение, явно прокомментированное в коде: `order-block-
nested` = 0.45 (та же идея мультитаймфреймового confluence, что и
fvg-nested, но без документального «максимального» статуса),
`order-block-breaker` = 0.4 (сопоставимо с `fvg-rejection`).

## Полный список зарегистрированных точек

Оба новых имени паттерна (`order-block-breaker`, `order-block-nested`)
добавлены везде, где уже зарегистрирована пара `fvg-breaker-block`/
`fvg-nested`, по аналогии, без исключений:

- `src/types/domain.ts` — `PatternName`, оба списка строковых литералов
  (`PATTERN_NAMES`, `patternNameSchema`).
- `src/stores/settingsStore.ts` — `ALL_PATTERNS` (тумблеры в UI).
- `src/stores/settingsStore.test.ts` — exhaustiveness-guard
  `PATTERN_NAME_COVERAGE` (файл специально существует, чтобы `tsc`
  падал при добавлении нового `PatternName` без обновления этого списка
  — сработал по назначению во время этой правки, ошибка исправлена).
- `src/lib/pattern-categories.ts` — `STRATEGY_PATTERNS`,
  `PATTERN_LABELS_RU` (русские подписи в UI).
- `src/lib/reason-translations.ts` + `.test.ts` — перевод строк-обоснований
  сигнала («OB Nested strategy (+0.32)» → «Подтверждение стратегией
  "Вложенный ордер-блок"»); без этого добавления причина сигнала
  показывалась бы пользователю на английском как есть.
- `src/compute/patterns/index.ts` — импорт + вызов детекторов в
  `detectAllPatterns`.
- `src/decision/signal-builder.ts` — бонус к score (см. выше).
- `src/ui/ChartPanel.tsx` — отрисовка брейкер-зон.
- `src/compute/full-snapshot.ts`, `src/compute/patterns.test.ts`,
  `src/compute/patterns/strategies.test.ts`,
  `src/compute/patterns/fvg-strategies.test.ts` — новое обязательное поле
  `breakerBlocks` в каждом литерале `SmartMoneyResult`. Это ровно тот же
  класс правки, что и в прошлом аудите (см.
  `CHANGES_APPLIED_ORDER_BLOCK_MERGE_AUDIT.md`, «БАГ в OB-FIXED») — на
  этот раз пойман сразу через `tsc --noEmit`, до сдачи, а не оставлен
  сломанным.

## Новые файлы

- `src/compute/patterns/order-block-breaker.ts`
- `src/compute/patterns/order-block-nested.ts`
- `src/compute/patterns/order-block-strategies-shared.ts` — общий
  helper `pickFreshUnbrokenOrderBlocks` (OB-аналог уже существующего
  `pickFreshUnbrokenFvgs`), переиспользует `fvgAgeBars` как есть.
- `src/compute/patterns/order-block-strategies.test.ts` — 9 тестов:
  недостаточная история, отсутствие зон, геометрический
  негативный кейс (проход насквозь без отбоя для брейкера / отсутствие
  overlap для nested), возрастной фильтр, и по одному подтверждённому
  положительному сценарию на каждую стратегию, включая реальный (не
  замоканный) HTF-детект через ресемплинг для Nested OB.
- Регрессионные тесты `breakerBlocks` добавлены в
  `src/compute/indicators/smart-money.test.ts` (3 теста: инверсия
  полярности и геометрия, независимое отслеживание касаний, пустой
  список при отсутствии пробитых OB).

## Что осознанно не сделано

- **`super-order-block.ts` / `strong-order-block-reaction.ts` /
  `order-block-continuation.ts` не тронуты** — см. «Аудит перед
  реализацией» выше; это осознанное архитектурное решение, а не
  недосмотр.
- Отдельная легенда/настройка для брейкер-зон — не заведена, см. раздел
  «Отрисовка» выше (то же решение, что и для IFVG ранее).
- Никаких новых порогов в pip/абсолютных величинах — оба новых
  детектора целиком построены на уже существующих, ATR-нормализованных
  и document-derived правилах (`FVG_SCORE_*`, `HTF_FACTOR`,
  `MAX_AGE_BARS`), ничего нового не изобретено.

## Проверено

- `npm run typecheck` (`tsc --noEmit -p tsconfig.app.json`) — 0 ошибок.
- `npm run lint` (`eslint .`) — 0 ошибок/предупреждений.
- `npx vitest run` — **43 файла, 566 тестов, все пройдены** (было 232 в
  `src/compute` на момент прошлого аудита; полный прогон проекта на этот
  раз, включая UI/decision/data слои, чтобы поймать любые
  exhaustiveness-guard'ы за пределами `src/compute` — именно так и был
  найден `settingsStore.test.ts`).

## Изменённые файлы относительно предыдущей сборки (merge-audit)

```
src/compute/full-snapshot.ts                         (+1 поле)
src/compute/indicators/smart-money.ts                (+breakerBlocks generation)
src/compute/indicators/smart-money.test.ts            (+3 теста)
src/compute/patterns/index.ts                         (+2 детектора)
src/compute/patterns/order-block-breaker.ts            новый
src/compute/patterns/order-block-nested.ts             новый
src/compute/patterns/order-block-strategies-shared.ts  новый
src/compute/patterns/order-block-strategies.test.ts    новый (9 тестов)
src/compute/patterns/fvg-strategies.test.ts            (+1 поле в фикстурах)
src/compute/patterns/strategies.test.ts                (+1 поле в фикстурах)
src/compute/patterns.test.ts                           (+1 поле в фикстурах)
src/decision/signal-builder.ts                         (+2 бонуса к score)
src/lib/pattern-categories.ts                          (+2 паттерна)
src/lib/reason-translations.ts                         (+2 перевода)
src/lib/reason-translations.test.ts                    (+1 тест)
src/stores/settingsStore.ts                            (+2 паттерна)
src/stores/settingsStore.test.ts                       (+2 записи в guard)
src/types/domain.ts                                    (+2 имени паттерна)
src/ui/ChartPanel.tsx                                  (+рендер брейкер-зон)
```

`super-order-block.ts`, `strong-order-block-reaction.ts`,
`order-block-continuation.ts` — без изменений (подтверждено diff'ом).
