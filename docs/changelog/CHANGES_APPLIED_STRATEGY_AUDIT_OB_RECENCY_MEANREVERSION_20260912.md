# Аудит торговых стратегий/паттернов/индикаторов — селекция order block по свежести + deadlock тумблера "Mean reversion" — 2026-09-12

Проведён широкий аудит `src/compute/patterns/`, `src/compute/indicators/`,
`src/decision/` по запросу «аудит всех торговых стратегий, свечных паттернов
и индикаторов … выяви ошибки, конфликты, неточности … которые влияют на
логику торговли и создают ложные данные для генерации сигналов». Исправления
сделаны через корректную логику построения (сортировка, устранение
неиспользуемого source-флага), а не сужением диапазонов весов/порогов —
как и требовалось.

## Баг 1 — order-block-strength: выбирался старейший, а не актуальный OB

**Файл:** `src/decision/direction-prediction.ts`, блок 2 ("Zones (OB
proximity)").

`orderBlockStrength()` возвращает зоны в хронологическом порядке
обнаружения (без сортировки — `for (let i = 1; i < slice.length - 1; ...)`,
`zones.push()` по возрастанию `i`). Цикл, начисляющий `components.zones`,
брал ПЕРВУЮ подходящую по цене зону через `break` — то есть при нескольких
валидных OB одного направления в пределах `proximity` (обычная ситуация на
рэйндже/консолидации, `lookback=50`) в score попадал `strengthScore`
**самого старого** совпавшего блока, а не самого актуального.

Расходится с тем, как уже устроены соседние по смыслу пути в том же файле:
FVG явно берёт `.slice(-3)` (последние = самые свежие), уровни S/R приходят
из `supportResistance()`, отсортированной по `strength`. Для order block'ов
в SMC-методологии релевантен именно самый свежий неотработанный блок —
старые в том же ценовом районе, как правило, уже "выработаны" даже если
формально не `broken`.

**Фикс:** `activeBullOB`/`activeBearOB` сортируются по `time` по убыванию
перед циклом (`byRecency`), так что `break` берёт самый свежий совпавший
блок. Риск регрессии низкий: ни один существующий тест не проверял порядок
выбора при НЕСКОЛЬКИХ одновременно подходящих OB (полный набор тестов
823→824 — без изменений в существующих, кроме нового теста ниже).

## Баг 2 — тумблер "Mean reversion" в "Компонентах сигнала" — фиктивный (deadlock того же класса, что и уже исправленный priorityThreshold)

**Файлы:** `src/decision/signal-builder.ts`, `src/decision/engine.ts`,
`src/ui/SettingsPanel.tsx`.

`components.meanReversion` (вес 1.0 в `featureCalibration.ts`, UI-тумблер
`toggles.meanReversion`) НИГДЕ в кодовой базе не получает ненулевого
значения — блок 7 ("Mean reversion (Bollinger + RSI)") в
`direction-prediction.ts` только логирует информационную заметку о касании
Bollinger с `contribution=0` (сознательно, по данным факторного анализа —
см. существующий комментарий), но никогда не пишет в
`components.meanReversion`. Реальная, полноценно реализованная стратегия
возврата к среднему (RSI(7) + Bollinger + ADX hard-block + HTF-BOS gate,
Phase 3.1 доки) — это отдельный паттерн `mean-reversion.ts`, идущий через
`toggles.trigger`/`activeFeatures`, а не через этот тумблер.

Тем не менее `signalToggles.meanReversion` входил в OR-цепочку
`hasEnabledSource` в ДВУХ местах (`buildSignal()` в signal-builder.ts и
`DecisionEngine`-метод в engine.ts). Итог: пользователь, включивший
**только** "Mean reversion" в UI и выключивший остальные компоненты,
получал `hasEnabledSource=true` (код считал конфигурацию рабочей) и **не
получал ни одного сигнала никогда**, без единого предупреждения — тот же
класс тихого тупика конфигурации, что и уже исправленный
`priorityThreshold`-deadlock
(`CHANGES_APPLIED_PRIORITY_THRESHOLD_DEADLOCK_20260905.md`), только на
уровне тумблеров компонентов вместо порога калибровки.

Дополнительно подпись в UI над списком тумблеров — «Отключённые элементы не
влияют на результат» — для этого конкретного тумблера была ложной в обе
стороны (ни включение, ни отключение реально не влияет на score).

**Фикс:**
- `meanReversion` убран из OR-цепочки `hasEnabledSource` в обоих файлах —
  такая конфигурация теперь честно даёт `hasEnabledSource=false` и явный
  `null` вместо молчаливого вечного отсутствия сигналов.
- Лейбл в `SettingsPanel.tsx` дополнен пояснением: `'Mean reversion (инфо,
  см. Стратегии)'`, со ссылкой в комментарии на настоящий переключатель
  (паттерн "Mean Reversion" в секции «Стратегии»).
- Регрессионный тест добавлен в `signal-builder.test.ts` (конфигурация
  «включён только meanReversion» → `buildSignal` возвращает `null`).

Что НЕ было сделано (сознательно, вне минимального риска этой сессии):
полное удаление мёртвых `components.meanReversion`/веса/тумблера из
`DirectionComponents`/`SignalComponentToggles`/`featureCalibration.ts` —
более широкое изменение схемы, задевающее сохранённые пользовательские
настройки/калибровку; оставлено как отдельная рекомендация (см. ниже).

## Минорная находка — мёртвая ветка тернарного оператора

**Файл:** `src/compute/patterns/order-block-continuation.ts`,
`findTargetZone()`.

```ts
candidates.sort((a, b) =>
  direction === 'buy'
    ? Math.abs(a - currentPrice) - Math.abs(b - currentPrice)
    : Math.abs(a - currentPrice) - Math.abs(b - currentPrice),
);
```

Обе ветки идентичны — не влияет на результат (кандидаты уже односторонне
отфильтрованы по `direction` до сортировки, так что сортировка по
абсолютному расстоянию корректна в обоих случаях), но похоже на след
незавершённого рефакторинга и может ввести в заблуждение при будущих
правках. Упрощено до одного выражения без развилки.

## Проверено и признано корректным в этой сессии

- `rsi.ts` (Wilder-сглаживание), `adx.ts` (Wilder ADX, тщательно
  прокомментирован), `bollinger.ts` (population stddev — стандартная для
  большинства платформ конвенция) — стандартные, корректные реализации,
  расхождений не найдено.
- `liquidity-sweep.ts`, `fvg-return.ts`, `pattern-selection.ts` — прочитаны
  полностью; уже несут собственные развёрнутые аудит-комментарии
  (findings #1, #3, #4, #6, #7, #9, #10 из более раннего аудита "Реакция на
  снятие ликвидности") и не содержат новых расхождений.
- `direction-prediction.ts` — прочитан полностью; остальные блоки (BOS/
  CHoCH, FVG-proximity, liquidity-pools, RSI/Bollinger соло-контрибуции,
  MACD, EMA, strategy-bonus паттерны) уже несут документированные фиксы
  прошлых аудитов и новых расхождений не выявлено.

## Что осталось не проверено в этой сессии (см. `docs/audit/` для следующего прохода)

Кодовая база велика (≈28 файлов паттернов + ≈25 индикаторов + ≈20
decision-файлов) — за одну сессию не пройдены: `fvg-rejection.ts`,
`fvg-breaker-block.ts`, `order-block-breaker.ts`, `order-block-nested.ts`,
`fvg-nested.ts` (детально, после фикса выравнивания — см. предыдущую
запись), `strong-order-block-reaction.ts`, `impulse-breakout.ts`,
`consolidation-breakout.ts`, `macd-deceleration-continuation.ts`,
`inside-bar.ts`, `pin-bar.ts`, `single.ts`/`double.ts`/`triple.ts`,
`continuation.ts`, `macd.ts`, `ema.ts`, `atr.ts`, `vwap.ts`,
`volume-profile.ts`, `vsa-classifier.ts`, `market-regime.ts`,
`impulse-velocity.ts`, `htf-structure.ts`, `pivots.ts`,
`smart-money.ts`/`super-order-block.ts` (за пределами того, что уже
косвенно проверено через order-block-continuation.ts), `calibration-model.ts`,
`featureCalibration.ts`, `signal-filters.ts`, `trade-levels.ts`,
`outcome-scheduler.ts`, `recommended-expiry.ts`, `signal-cooldown.ts`.
