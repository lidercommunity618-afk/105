# Проверочный промт: модуль "гармонические паттерны"

Этот документ — самодостаточный чек-лист/промт для повторного аудита модуля
гармоник (человеком или другой LLM-сессией) без необходимости заново
исследовать кодовую базу с нуля. Используйте его как техническое задание:
"пройди по каждому пункту раздела 3, подтверди или опровергни инвариант,
сославшись на конкретную строку/функцию".

## 1. Контекст и цель

Модуль детектирует 5 типов гармонических паттернов (Gartley, Bat, Crab,
Butterfly, AB=CD) на основе ZigZag-разметки X-A-B-C-D поверх синтетического
HTF (5×M1 → синтетический M5), считает Potential Reversal Zone (PRZ),
структурные SL/TP и направление (buy/sell), а затем результат участвует в
общем pattern-selection → decision → signal-builder конвейере наравне с
остальными ~20+ детекторами паттернов.

Состояние на момент последнего аудита (2026-09): см.
`docs/audit/2026-09-harmonic-module-synthetic-audit.md` — там же инструмент
для эмпирической (не только юнит-тестовой) проверки:
`backtest/synthetic/harmonic-data.ts` + `backtest/harmonic-audit.ts`
(`npm run backtest:harmonic-audit`).

## 2. Карта затронутых файлов

### 2.1. Ядро детектора (прямая зона ответственности)

| Файл | Роль |
|---|---|
| `src/compute/indicators/zigzag.ts` | `computeZigZag()` — ATR-адаптивная разметка pivot-точек; `findHarmonicZigZagPoints()` — обёртка: HTF-ресэмплинг (`resampleCandles`, фактор 5) + `computeZigZag` + хвост из последних `tailCount` точек. Выравнивание HTF-границы теперь делегировано `resampleCandles(..., { alignToAbsoluteTime: true })` (фикс 2026-09, обновлено 2026-09-12 — централизовано, см. §4.1). |
| `src/compute/patterns/harmonic-pattern.ts` | `detectHarmonicPattern()` — основная точка входа. Внутри: `matchXabcd()` (проверка 4 коэффициентов для Gartley/Bat/Crab/Butterfly по `XABCD_RULES`), `matchAbCd()` (проверка AB=CD), `evaluateWindow()` (freshness-гейт, выбор `matchXabcd` vs `matchAbCd` по confidence, расчёт PRZ, `harmonicStop`/`harmonicTarget`, RR-фильтр, post-hoc инвалидация), `checkPrzConfluence()` (бонус от свежих OB/FVG внутри PRZ). |
| `src/decision/trade-levels.ts` | `computeHarmonicTradeLevels()` — обёртка над уже посчитанными в детекторе `harmonicStop`/`harmonicTarget`/PRZ для UI/decision-слоя. |

### 2.2. Общая инфраструктура, от которой зависит модуль

| Файл | Роль |
|---|---|
| `src/compute/patterns/fvg-strategies-shared.ts` | `resampleCandles(candles, factor, options?)` — используется ТАКЖЕ `order-block-nested.ts` и `fvg-nested.ts`; опциональный `{ alignToAbsoluteTime: true }` (добавлен 2026-09-12) устраняет риск §4.1 во всех трёх местах вызова централизованно. |
| `src/compute/patterns/index.ts` | `detectAllPatterns()` — вызывает `detectHarmonicPattern` (строка с `has('harmonic-pattern')`), передаёт `harmonicConfig`; `applyConfidenceHierarchy()` — harmonic-pattern НЕ входит в `PATTERN_CONFIDENCE_HIERARCHY`, использует свой `confidence` как есть. |
| `src/compute/full-snapshot.ts` | Собирает `harmonicConfig` из `IndicatorConfig` (`harmonicMinLegAtr`, `harmonicFibTolerancePct`, `harmonicHtfFactor`, `harmonicMinRR`) и передаёт в `detectAllPatterns`. |
| `src/types/domain.ts` | `HarmonicConfig`/`DEFAULT_HARMONIC_CONFIG` (в `harmonic-pattern.ts`, значения дублируются как дефолты `IndicatorConfig`), `PatternResult` (поля `harmonicType`, `przLow`, `przHigh`, `harmonicStop`, `harmonicTarget`), `FeatureName`/`ALL_FEATURES` (наличие `'harmonic-pattern'` в списке), `DEFAULT_INDICATOR_CONFIG`. |
| `src/lib/pattern-categories.ts` | `STRATEGY_BONUS_PATTERNS` — включает `'harmonic-pattern'` (даёт +0.5×confidence бонус вместо обычного trigger-скора; см. §4.2). |
| `src/decision/direction-prediction.ts` | Использует `STRATEGY_BONUS_PATTERNS`/`getReliabilityMultiplier` — здесь уже была исправлена (до этого аудита) проблема двойного учёта бонуса, см. комментарий "BUGFIX (аудит 2026-09-06, п.4)". |
| `src/decision/pattern-selection.ts` | `selectTopPattern()` — harmonic-pattern конкурирует с остальными "class 2" паттернами (SMC/ICT и т.п.) по приоритету/confidence при выборе топ-паттерна сигнала. |
| `src/decision/signal-builder.ts` | Финальная сборка `Signal` — здесь harmonic-pattern ничем не выделен относительно других паттернов (не имеет отдельной ветки), участвует через `topPattern`. |
| `src/stores/settingsStore.ts` | UI-переключатель фичи `'harmonic-pattern'` в `activeFeatures` (есть исторический комментарий про баг "toggle-list vs detectAllPatterns' has() filter" — см. §4.2, уже исправлено ранее). |
| `src/ui/ChartPanel.tsx` | Отрисовка X-A-B-C-D разметки и PRZ на графике. |
| `src/ui/SettingsPanel.tsx` | UI-контролы для `harmonicMinLegAtr`/`harmonicFibTolerancePct`/`harmonicHtfFactor`/`harmonicMinRR`. |
| `src/lib/reason-translations.ts` | Человекочитаемые описания причин сигнала, включая формулировки для harmonic-pattern. |

### 2.3. Тесты

| Файл | Покрытие |
|---|---|
| `src/compute/patterns/harmonic-pattern.test.ts` | 14 тестов — геометрия, freshness-гейт, RR-фильтр, PRZ-конфлюенс. Все фикстуры **симметричные** (AB≈BC по порядку величины) — НЕ покрывают асимметричный AB≠BC случай, из-за чего баг §4.3 не был обнаружен раньше. |
| `src/compute/indicators/zigzag.test.ts` | 5 тестов — `computeZigZag`/`findHarmonicZigZagPoints` на фиксированных (не скользящих) массивах — НЕ покрывают сценарий скользящего окна, из-за чего баг §4.1 не был обнаружен раньше. |
| `src/decision/trade-levels.test.ts` | 10 тестов — `computeHarmonicTradeLevels` как обёртка. |
| `src/decision/signal-builder.test.ts`, `src/decision/pattern-selection.test.ts`, `src/types/domain.test.ts`, `src/stores/settingsStore.test.ts` | Косвенное покрытие wiring (наличие в `ALL_FEATURES`, участие в приоритезации и т.д.). |

### 2.4. Новая аудит-инфраструктура (добавлена в ходе этого аудита)

| Файл | Роль |
|---|---|
| `backtest/synthetic/harmonic-data.ts` | Генератор OHLCV со встроенным ground truth (10 паттернов: 5 типов × 2 направления). Детерминированный PRNG (`mulberry32`, seed по умолчанию 42). |
| `backtest/harmonic-audit.ts` | `npm run backtest:harmonic-audit` — прямая проверка детектора + полный прогон `simulate → computeSplitMetrics → generateReport`. |

## 3. Чек-лист проверки (по разделам)

### A. Геометрия и коэффициенты Фибоначчи

- [ ] `XABCD_RULES` (Gartley/Bat/Crab/Butterfly): значения `ab_xa`/`bc_ab`/`cd_bc`/`ad_xa` соответствуют стандартной методологии (Carney). Сверить с независимым источником.
- [ ] `matchAbCd()`: проверяет `bc/ab` (диапазон 0.382–0.886) и `cd/ab` (точка ≈1.0) — НЕ `cd/bc`. Убедиться, что нигде дальше по коду это не перепутано (см. §4.3 — именно это и было перепутано в PRZ).
- [ ] Направление (`direction = D.type === 'low' ? 'buy' : 'sell'`) — соответствует конвенции "гармонический разворот": bullish-паттерн заканчивается минимумом D.
- [ ] Знаки `adSign`/`cdSign` в `evaluateWindow()` — проверить алгебраически для ОБЕИХ ориентаций (bullish и bearish), а не только на одном примере.
- [ ] Для КАЖДОЙ из 5 формул PRZ (`adProjection` × 4 типа + `cdProjectionLow/High`) явно выписать, от какой ноги (XA, AB или BC) берётся база, и сверить с тем, что реально проверяет `matchXabcd`/`matchAbCd` для этого коэффициента. Это ровно тот класс бага, что был найден в §4.3 — стоит перепроверить вручную на числах, а не полагаться на чтение кода "по смыслу".

### B. ZigZag и HTF-ресэмплинг

- [ ] `findHarmonicZigZagPoints()` вызывается ТОЛЬКО со скользящим окном (`candles.slice(i - windowSize + 1, i + 1)`) во всех продакшен- и бэктест-путях — да (`backtest/simulator.ts`, `src/engine/analysisEngine.ts`).
- [ ] `alignToAbsoluteHtfBoundary()` действительно вызывается ПЕРЕД `resampleCandles()` внутри `findHarmonicZigZagPoints()` — проверить, что фикс не был случайно откачен/обойдён.
- [ ] Проверить эмпирически (не только по коду): взять один и тот же участок цены, прогнать детектор на 10+ последовательных барах подтверждения — время/цена/PRZ найденной точки D должны быть СТАБИЛЬНЫ (см. методику в `backtest/harmonic-audit.ts`, раздел "ПРЯМАЯ ПРОВЕРКА ДЕТЕКТОРА").
- [ ] `computeZigZag()`: ATR-порог (`minLegAtrMultiple × ATR(atrPeriod)`) пересчитывается на КАЖДОМ HTF-баре (адаптивный, не фиксированный) — подтвердить по коду.
- [ ] Достаточность истории: `candles.length < 40` → `null` в `detectHarmonicPattern` — проверить, что 40 барам действительно хватает для `atrPeriod=14` (HTF) × `htfFactor=5` = 70 сырых баров разогрева ATR + минимум 5 pivot-точек. (Есть подозрение на пограничный случай — стоит явно протестировать `candles.length` в диапазоне 40–70.)

### C. Freshness-гейт и множественные окна

- [ ] `ageBars = fvgAgeBars(D.time, lastCandle.time, intervalSec)` — `intervalSec` берётся из СЫРЫХ (не HTF) свечей корректно.
- [ ] `maxAgeBars = Math.max(30, htfFactor × 6)` — обоснование числа 30 и множителя 6 задокументировано в коде; убедиться, что оно по-прежнему актуально при нестандартных `htfFactor` (например, если пользователь в UI выставит `harmonicHtfFactor` сильно отличным от 5 — SettingsPanel.tsx позволяет это?).
- [ ] 3 скользящих окна (`tail.slice(-5)`, `tail.slice(-6,-1)`, `tail.slice(-7,-2)`) — подтвердить, что при `tail.length` от 5 до 7 логика не выходит за границы массива и не дублирует одно и то же окно.
- [ ] Post-hoc инвалидация (если она есть — проверить актуальный код `evaluateWindow` на предмет проверки "цена уже прошла мимо PRZ/TP до текущего момента") — сверить, что она не конфликтует с freshness-гейтом (не отбрасывает валидные свежие сетапы).

### D. PRZ-конфлюенс

- [ ] `checkPrzConfluence()` — проверить, использует ли она точное неравенство `>=`/`<=` без допуска для случаев, когда PRZ вырождается в точку (ab-cd, см. §4.3-фикс в тестовом скрипте — аналогичная проблема может быть и в самом приложении, не только в аудит-инструменте). Если да — рассмотреть добавление небольшого epsilon и в проде, не только в тестах.
- [ ] Источник `freshObs`/`freshFvgs`, с которыми сверяется PRZ — убедиться, что при `'smart-money'` не в `activeFeatures` функция получает `EMPTY_SMART_MONEY`, а не `undefined`/падает.

### E. Wiring и интеграция

- [ ] `'harmonic-pattern'` присутствует в `ALL_FEATURES` (`src/types/domain.ts`).
- [ ] `harmonicConfig`, переданный в `detectAllPatterns`, содержит ВСЕ 4 поля не-`undefined` (даже если конфиг задан частично) — проверить, что `DEFAULT_INDICATOR_CONFIG` действительно даёт дефолты для каждого поля по отдельности, а не полагается на `config ?? DEFAULT_HARMONIC_CONFIG` (которое сработает только если весь объект `undefined`, а не отдельные поля — см. как этот класс бага уже когда-то был там, судя по комментариям в коде).
- [ ] `STRATEGY_BONUS_PATTERNS` содержит `'harmonic-pattern'`, и `direction-prediction.ts` не начисляет по нему одновременно и обычный trigger-скор, и strategy-бонус (двойной учёт).
- [ ] `settingsStore.ts`: UI-тумблер `'harmonic-pattern'` действительно управляет тем же самым флагом, что читает `detectAllPatterns` (`has('harmonic-pattern')`) — не двумя разными списками.

### F. UI

- [ ] `ChartPanel.tsx`: точки X/A/B/C/D и PRZ рисуются по актуальным (после фикса §4.1) стабильным координатам — визуально не должны "прыгать" от бара к бару на неизменной истории.
- [ ] `SettingsPanel.tsx`: диапазоны/валидация для `harmonicMinLegAtr`/`harmonicFibTolerancePct`/`harmonicHtfFactor`/`harmonicMinRR` — предотвращают заведомо некорректные значения (например, `htfFactor=0` или `1`, при которых логика ресэмплинга/выравнивания вырождается).
- [ ] `reason-translations.ts`: формулировки для harmonic-pattern корректно отражают тип паттерна (`harmonicType`) и направление.

### G. Регрессионное тестирование

- [ ] `npm run test` (815 тестов на момент аудита) — 100% pass.
- [ ] `npx tsc --noEmit -p tsconfig.app.json` и `-p backtest/tsconfig.json` — 0 ошибок.
- [ ] `npm run backtest:harmonic-audit` — таблица "ПРЯМАЯ ПРОВЕРКА ДЕТЕКТОРА" показывает 10/10 по всем 6 метрикам (Detected/Type match/Direction match/PRZ contains D/Stop correct side/Target correct side), 0 ложных срабатываний до D.
- [ ] Новые юнит-тесты добавлены под конкретно найденные баги (см. §5, "Рекомендации", п. 2) — сверить, что они присутствуют и падают на "старой" версии кода (при откате фикса), чтобы подтвердить их полезность как регрессионных.

## 4. Ссылка: уже найденные и исправленные баги (не переоткрывать без новых данных)

### 4.1. HTF-группировка ZigZag была привязана к позиции в массиве, а не к абсолютному времени
`src/compute/indicators/zigzag.ts`, `findHarmonicZigZagPoints()`. Исправлено добавлением `alignToAbsoluteHtfBoundary()`. См. `docs/audit/2026-09-harmonic-module-synthetic-audit.md`, раздел "1". **Тот же риск подтверждён эмпирически и ИСПРАВЛЕН (2026-09-12) в `order-block-nested.ts` (`detectHtfObZones`) и `fvg-nested.ts` (`detectHtfFvgZones`)** — по итогам последующего аудита (`docs/audit/recommendations-post-harmonic-audit.md`, Рекомендации 1 и 3) выравнивание централизовано в `resampleCandles(candles, factor, { alignToAbsoluteTime: true })` (`fvg-strategies-shared.ts`) и включено явно во всех трёх местах вызова (включая сам `zigzag.ts`, который теперь использует общий флаг вместо собственной копии функции). Регрессионное покрытие: `backtest/htf-resample-stability-audit.ts` (`npm run backtest:htf-resample-audit`) + постоянные тесты в `order-block-strategies.test.ts`/`fvg-strategies.test.ts`. См. `docs/changelog/CHANGES_APPLIED_HTF_RESAMPLE_ALIGNMENT_20260912.md`.

### 4.2. (Исправлено ранее, до этого аудита) Двойной учёт strategy-бонуса и toggle-list рассинхронизация
См. комментарии "BUGFIX (аудит 2026-09-06, п.4)" в `direction-prediction.ts` и комментарии в `settingsStore.ts` про "detectAllPatterns' has() filter". Не переоткрывать без конкретного нового наблюдения — уже исправлено.

### 4.3. PRZ для ab-cd считался от неверной ноги (BC вместо AB)
`src/compute/patterns/harmonic-pattern.ts`, `evaluateWindow()`. Систематическая ошибка ~1.8% цены. Исправлено. См. `docs/audit/2026-09-harmonic-module-synthetic-audit.md`, раздел "2". Регрессионное покрытие усилено 2026-09-12: `harmonic-pattern.test.ts` теперь содержит по одному асимметричному (BC на порядок отличается от AB, bc_ab у обеих границ диапазона [0.382, 0.886]) тесту на каждый из 5 типов паттерна с явной численной проверкой `przLow`/`przHigh` (Рекомендация 2, `docs/audit/recommendations-post-harmonic-audit.md`) — именно такой тест поймал бы этот баг; проверено вручную временным откатом фикса.

## 5. Как использовать этот промт

Скопируйте раздел 3 целиком в новый диалог/тикет вместе с текущим состоянием кода и попросите построчно подтвердить каждый пункт со ссылкой на файл/строку/функцию, либо явно указать расхождение. Для пунктов раздела B и G используйте `backtest/harmonic-audit.ts` как инструмент эмпирической (не только визуальной/логической) проверки — он детерминирован (фиксированный seed) и воспроизводим.
