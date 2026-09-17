# CHANGES_APPLIED_THRESHOLD_CALIBRATION_STAGE4_20260909.md

Дата: 2026-09-09.

Промт: реализовать Этап 4 плана калибровки (симметричный Этапу 2 контур
самообучения, но для ПОРОГА ВХОДА `priorityThreshold` вместо
`PATTERN_RELIABILITY_MULTIPLIER`) по подготовленному bolt.new-промту, плюс
предварительно проверить покрытие: реально ли все 14 стратегий из
`STRATEGY_PATTERNS` активны и участвуют на нужном инструменте/сессии.

## 0. Проверка покрытия стратегий (сделана первой, до Этапа 4 — п.4.4 промта)

Построчно проверены: `settingsStore.ts` (`ALL_PATTERNS`, `activePatterns`,
миграции `version < 9`/`< 12`), `compute/patterns/index.ts`
(`detectAllPatterns`, гейт `has(name)` на каждый из 14 паттернов),
`direction-prediction.ts`/`signal-builder.ts` (`STRATEGY_BONUS_PATTERNS`,
10 из 14 паттернов с персональным бонусом, оставшиеся 4 —
`consolidation-breakout`/`liquidity-sweep`/`mean-reversion`/
`strong-order-block-reaction` — участвуют через обычный `trigger`-вклад, это
не баг, а изначальный дизайн разделения STRATEGY_PATTERNS/
STRATEGY_BONUS_PATTERNS), детекторы всех 14 стратегий (сессия только
повышает уверенность — нет ни одного `return null` по сессии),
`DEFAULT_SESSION_FILTER` (все 5 сессий `true`), `SettingsPanel.tsx`/
`StrategiesModal.tsx` (оба берут список стратегий из `ALL_PATTERNS` через ту
же `patternCategory()`, что и сам детектор).

**Результат: баг не найден.** Все 14 стратегий активны по умолчанию для
любого инструмента и любой сессии, единственный способ отключить одну из
них — явный тумблер пользователя в Settings/StrategiesModal, который
дополнительно защищён от потери при апдейтах приложения (миграции
`activePatterns` — аддитивные). Изменений по этому пункту не вносилось.

## 1. Этап 4 — самообучение порога входа по частоте

### Найденный и закрытый конфликт (до реализации, не после)

`priorityThreshold` хранился только глобально (`settingsStore.ts`, один
слайдер на все инструменты), в отличие от калибровочной модели (Этап 1) и
`PATTERN_RELIABILITY_MULTIPLIER` (Этап 2), которые уже per-symbol. Наивное
"подобрать порог по данным BTCUSDT → `setPriorityThreshold()`" повторило бы
ровно тот же класс бага, что уже дважды находили и чинили в этом проекте
(калибровка одного инструмента молча утекает в остальные).

**Решение**: новый per-symbol override-слой, архитектурно идентичный
`pattern-categories.ts`.

### Новые файлы

- `src/lib/threshold-calibration.ts` — чистая функция
  `computeThresholdCandidates(signals, currentThreshold, baselineWinRate)`,
  строит таблицу "порог → частота/точность" по сетке 0.50…0.95 с шагом 0.05.
  Ключевые инварианты (все покрыты тестами):
  - `emittedCount` (все сигналы ≥ порога, факт эмиссии) и `decidedCount`
    (только резолвнутые win/loss) — РАЗНЫЕ множества, не путать
    (тот же класс бага, что уже находили в `computeFactorStats`/
    `computeBuckets`).
  - Только `calibrationSource === 'model'`; `'fallback'` полностью
    исключён — как из числителя/знаменателя, так и из временного окна
    для расчёта частоты.
  - `MIN_THRESHOLD_BACKTEST_SAMPLES = 20` — независимая константа (не
    производная от `MIN_SAMPLES` из `calibration-model.ts`); обоснование и
    история изменения — см. раздел 3, находка 2.
  - Допуск на потерю винрейта — константа `WINRATE_TOLERANCE = 0.03`.
  - Если ни один порог сетки не даёт частоту ≥1/5мин без потери точности —
    `recommendedThreshold: null` с человекочитаемой `reason`, не тихое
    снижение планки.
  - `src/lib/threshold-calibration.test.ts` — 9 тестов.

- `src/lib/priority-threshold-overrides.ts` — per-symbol override-слой:
  `effectivePriorityThresholdForSymbol`, `hasPriorityThresholdOverride`,
  `applyPriorityThresholdOverrideForSymbol`, `resetPriorityThresholdOverrideForSymbol`.
  In-memory `Map` + ленивая подгрузка из `localStorage`
  (`priority-threshold-symbol-v1:{symbolId}`), clamp к
  `[THRESHOLD_GRID_MIN, THRESHOLD_GRID_MAX]`, безопасные try/catch-обёртки
  вокруг `localStorage` — тот же паттерн, что уже используется для
  `PATTERN_RELIABILITY_MULTIPLIER` overrides.
  - `src/lib/priority-threshold-overrides.test.ts` — 5 тестов, включая
    прямую проверку "BTCUSDT override не течёт в EURUSD".

### Изменённые файлы

- `src/stores/useTickStore.ts`:
  - `ensureEngine(symbolId?)` — при первом создании движка (модульный
    синглтон) сразу подставляет per-symbol `priorityThreshold`, если
    `symbolId` известен на этот момент; все три вызова (`start()`,
    `maybeEvaluateSignal`, `maybeConsiderRevision`) теперь передают
    известный `activeSymbolId`.
  - `switchCalibrationModel(symbolId)` — сразу после
    `engine.setCalibration(model)` вызывает
    `engine.setPriorityThreshold(effectivePriorityThresholdForSymbol(symbolId, ...))`
    — порог переключается синхронно с моделью, в той же точке, что и раньше
    у калибровки, чтобы не заводить отдельную (и потенциально
    рассинхронизируемую) точку переключения.
  - Подписка на `priorityThreshold` (module-level `useSettingsStore.subscribe`)
    теперь резолвит новое значение слайдера через
    `effectivePriorityThresholdForSymbol(activeSymbolId, next)` перед
    пушем в движок — движение ГЛОБАЛЬНОГО слайдера продолжает работать как
    раньше для инструмента без собственного override, но больше не
    перекрывает откалиброванный per-symbol порог другого инструмента.
  - Добавлены два новых экшена стора: `applyPriorityThresholdForSymbol` /
    `resetPriorityThresholdForSymbol` — единственная точка входа из UI;
    делают одновременно (а) запись override и (б) немедленный
    `engine.setPriorityThreshold(...)`, но только если применяемый символ
    совпадает с `activeSymbolId` — иначе живой движок другого (текущего)
    инструмента не трогается. Это обязательно, т.к. в отличие от
    `PATTERN_RELIABILITY_MULTIPLIER` (читается read-through на каждый
    `evaluate()`), `priorityThreshold` — приватное push-based поле
    `DecisionEngine`.
  - `src/stores/useTickStore.test.ts` — 3 новых теста на эти экшены (пуш в
    движок только для активного символа; сброс возвращает к глобальному
    дефолту); все существующие 14 тестов (включая сценарии на
    `switchCalibrationModel`/подписку `priorityThreshold`) без изменений
    логики, продолжают проходить.

- `src/ui/CalibrationPanel.tsx` — новая секция "ПОРОГ ВХОДА (ЧАСТОТА)",
  вставлена сразу после "КАЛИБРОВКА НАДЁЖНОСТИ ПАТТЕРНОВ", тем же визуальным
  паттерном preview → apply/cancel → reset:
  - Кнопка "Подобрать порог" → `computeThresholdCandidates(signals,
    effectivePriorityThresholdForSymbol(symbolId, priorityThreshold), symbolWinRate)`,
    где `symbolWinRate` — винрейт, посчитанный из `signals`, уже
    отфильтрованных по `symbolId` (а не глобальный `useAnalyticsStore.winRate`).
    Обоснование — см. раздел 3, находка 1.
  - Таблица кандидатов: Порог / Частота / N / Винрейт; строка текущего
    порога и рекомендованного — подсвечены; непроходные строки приглушены,
    но не скрыты (та же прозрачность, что у таблицы надёжности паттернов).
  - Если рекомендации нет — вместо таблицы показывается `reason` текстом.
  - Строка "Порог: N% (общий, не откалиброван для этого инструмента)",
    когда `!hasPriorityThresholdOverride(symbolId)`.
  - `useEffect(() => { setThresholdPreview(null); setThresholdApplied(false); }, [symbolId])`
    — тот же самый класс бага, что и находка №2 аудита от 2026-09-08
    (`reliabilityPreview` не сбрасывался при смене символа), закрыт по
    аналогии для нового предпросмотра.
  - `src/ui/CalibrationPanel.test.tsx` — добавлен тест
    "closes an open threshold preview when the active symbol changes" по
    образцу существующего теста для `reliabilityPreview`; попутно
    исправлена одна preexisting типовая ошибка (`SignalFactor` без
    обязательного поля `argument` в тестовом фикстуре — не связана с
    Этапом 4, но блокировала `tsc --noEmit`).

- `src/ui/SettingsPanel.tsx` — информационная строка под общим слайдером
  "Порог приоритета": если у активного символа есть override, показывается
  "Переопределено для {symbol}: {effective}%". Сам слайдер и `onChange` не
  менялись — он по-прежнему редактирует только глобальный дефолт. Это
  единственный случай во всём приложении, где для одного значения
  одновременно существует и глобальный UI (слайдер в Settings), и per-symbol
  UI (секция в CalibrationPanel) — у `PATTERN_RELIABILITY_MULTIPLIER` такой
  неоднозначности нет, поэтому там подобная строка не нужна.

## 2. Проверка регрессий

- `npm run ci` (`tsc --noEmit -p tsconfig.app.json && eslint . && vitest run`)
  — зелёный. 775 тестов, 773 пройдено; 2 непройденных теста
  (`src/lib/gemini-analysis.test.ts`) — preexisting, не связаны с этим
  изменением (падают из-за отсутствия `VITE_SUPABASE_URL`/
  `VITE_SUPABASE_ANON_KEY` в окружении, а не из-за кода).
- Файлы `signal-builder.ts`, `direction-prediction.ts`,
  `signal-cooldown.ts`, `signal-filters.ts`, `calibration-model.ts`,
  `pattern-categories.ts`, все детекторы паттернов — не тронуты; их тесты
  проходят без изменений.
- `ensureEngine`/`switchCalibrationModel` в `start()` используют явно
  переданный параметр `symbolId`, а не `useTickStore.getState().activeSymbolId`
  (который на этом этапе `start()` ещё не обновлён — `set({ activeSymbolId,
  ... })` происходит позже) — гонки между переключением символа и
  инициализацией порога нет.
- Изменение глобального `priorityThreshold` не перезаписывает существующий
  per-symbol override — проверено юнит-тестами
  (`priority-threshold-overrides.test.ts`, `useTickStore.test.ts`) и вручную
  прослежено по коду: `effectivePriorityThresholdForSymbol` всегда сначала
  проверяет override, глобальное значение — только fallback.

## 3. Независимый аудит того же дня (после первичной реализации) — 2 находки

### Находка 1 — `baselineWinRate` тёк между инструментами (severity: высокая)

`computeThresholdCandidates(signals, threshold, winRate)` вызывался с
`winRate` из `useAnalyticsStore` — глобальным агрегатом по ВСЕМ
инструментам сразу (`recomputeStats()` читает `signals` без фильтра по
`symbolId`), в то время как сам `signals`, передаваемый в тот же вызов,
уже был корректно отфильтрован по текущему символу. Тот же класс утечки
между инструментами, ради защиты от которого строился весь per-symbol
override-слой этого этапа — просто применительно к baseline-винрейту, а
не к самому порогу.

**Эффект**: инструмент со скромной, но честной статистикой мог получить
"недостижимо без потери точности" только потому, что другой, гораздо
более прибыльный инструмент задирал общий блендированный винрейт (и
наоборот — слабый инструмент мог занизить планку для сильного).

**Фикс**: в `CalibrationPanel.tsx` добавлен `symbolWinRate` — винрейт,
посчитанный из уже отфильтрованных по символу `signals`, той же формулой,
что `recomputeStats()` (`tradeOpened !== false`, только резолвнутые
win/loss). Именно он теперь передаётся как `baselineWinRate`. Глобальный
`winRate`/лейбл "Винрейт (лайв)" в верхней части панели НЕ трогали — это
отдельный, более широкий пре-существующий баг (затрагивает и
`StatusBar.tsx`, требует более крупного рефакторинга `recomputeStats()`
под per-symbol скоуп), не входящий в границы Этапа 4.

Тест `src/ui/CalibrationPanel.test.tsx` ("does not let a much stronger
sibling instrument inflate the baseline for a weaker one") — вручную
проверен в обе стороны (временный откат фикса → тест падает; фикс
восстановлен → тест проходит), чтобы не полагаться на тест, зелёный
независимо от бага.

### Находка 2 — `MIN_THRESHOLD_BACKTEST_SAMPLES = MIN_SAMPLES` был практически недостижим (severity: высокая)

Изначально `MIN_THRESHOLD_BACKTEST_SAMPLES` был приравнен `MIN_SAMPLES`
(100) из `calibration-model.ts` по аналогии "порог не активен, пока
`CalibrationModel.isReady()`". Аналогия была неверной: `isReady()`
проверяет ГОТОВНОСТЬ МОДЕЛИ — её собственный per-symbol буфер `samples`
(cap `MAX_SAMPLES=500`), а не то, сколько `'model'`-сигналов физически
может накопиться в источнике данных, который реально использует этот
модуль — `useAnalyticsStore.signals`, ГЛОБАЛЬНАЯ (across ALL инструментов)
история, жёстко ограниченная `MAX_SIGNALS=100` РЕЗОЛВНУТЫМИ сигналами
(`capSignals()`).

**Эффект**: 100 было не "минимально достаточной выборкой", а физическим
потолком того, что вообще может накопиться для ОДНОГО символа — и то
только если пользователь не торгует ничем другим и ни один сигнал не ушёл
в `'timeout'`/`'fallback'`. Для любого пользователя, торгующего больше чем
одним инструментом (то есть ровно той аудитории, ради которой строился
весь per-symbol слой Этапа 4), `decidedCount >= 100` для конкретного
символа был практически недостижим — секция "ПОРОГ ВХОДА (ЧАСТОТА)" почти
всегда показывала бы "недостаточно истории", не давая пользы.

**Фикс**: `MIN_THRESHOLD_BACKTEST_SAMPLES` понижен до 20 (собственная
независимая константа, больше не производная от `MIN_SAMPLES`) — заметно
выше `MIN_FACTOR_SAMPLES=5` (там надёжность ОДНОГО паттерна; здесь —
агрегат по всем `'model'`-сигналам одного инструмента и порога, решение с
более широкими последствиями), но реально достижимо в пределах общего
лимита в 100 сигналов на всех инструментах сразу. Комментарий у константы
переписан, чтобы явно разводить два РАЗНЫХ хранилища (per-symbol
`CalibrationModel.samples`, cap 500 — vs — глобальный
`useAnalyticsStore.signals`, cap 100) и не повторять эту ошибку в будущем.

Существующие тесты `threshold-calibration.test.ts`, которые строят серии
относительно `MIN_THRESHOLD_BACKTEST_SAMPLES + N`, отмасштабировались
автоматически (константа не захардкожена в тестах отдельно) и продолжают
проходить без изменений тестового кода.

### Проверено и сознательно НЕ фиксировалось

- **Реактивность override между одновременно открытыми панелями.** Если
  `CalibrationPanel` (постоянно в сайдбаре) и модалка `SettingsPanel`
  открыты одновременно, применение override в первой не форсирует
  немедленный ре-рендер второй (обе читают `priority-threshold-overrides.ts`
  напрямую из модульного `Map`, не из реактивного стора) — строка
  "Переопределено для..." обновится при следующем ре-рендере/ремаунте
  `SettingsPanel`, а не мгновенно. Сам движок при этом получает верное
  значение сразу — расходится только информационная подпись в другом,
  параллельно открытом окне. `SettingsPanel` монтируется заново при каждом
  открытии (`{open && <SettingsPanel />}` в `SettingsButton.tsx`), так что
  типичный сценарий (открыл Settings уже ПОСЛЕ применения) отображает
  актуальное состояние. Не фиксировалось — потребовало бы превращения
  override-слоя в реактивный zustand-стор, более широкий рефакторинг вне
  границ этого этапа.
- **Гонка `useSettingsStore.symbolId` (читает `CalibrationPanel`) vs
  `useTickStore.activeSymbolId` (проверяет guard в
  `applyPriorityThresholdForSymbol`) при быстром переключении символа.**
  Прослежено построчно: весь путь `start()` от `state.stop()` до
  `set({ activeSymbolId: symbolId, ... })` выполняется СИНХРОННО, без
  единого `await`, до какой-либо реальной асинхронной загрузки свечей —
  то есть `activeSymbolId` обновляется практически в тот же тик, что и
  сам `symbolId`, задолго до того, как пользователь физически успел бы
  кликнуть "Применить". Реального окна для гонки при обычном
  взаимодействии пользователя нет; в теоретическом худшем случае запись
  override не теряется (пишется в `Map`/`localStorage` независимо от
  guard'а) и подхватывается движком на ближайшем
  `switchCalibrationModel()` — самокорректируется.
