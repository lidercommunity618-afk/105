# CHANGES_APPLIED_CALIBRATION_STAGE2_5_REVIEW_CLEANUP_20260908.md

Дата: 2026-09-08.

Промт: «Исправь всё по логической цепочке» — по итогам независимой
проверки качества реализации Этапов 1–3 плана калибровки (см. предыдущее
сообщение в этом чате; сама проверка не заводила отдельный файл, выводы
ниже воспроизводят её дословно перед описанием фикса). Проверка сама
переустановила зависимости и прогнала `tsc`/`eslint`/`vitest` независимо,
не полагаясь на цифры из более ранних `CHANGES_APPLIED_*.md`, и нашла две
вещи, обе не баги поведения, а расхождение кода с документацией/чистотой
API:

## Находка 1 — недокументированный per-symbol слой `PATTERN_RELIABILITY_MULTIPLIER`

`CHANGES_APPLIED_CALIBRATION_FACTOR_SELFLEARN_STAGE2_20260906.md` явно
указывал как известное ограничение: множитель надёжности паттернов — один
общий словарь на все инструменты, "калибровка на BTCUSDT искажает сигналы
по EURUSD тоже", кандидат на будущий "Этап 2.1". В проверенной сборке
этот "Этап 2.1" **уже был реализован в коде** —
`getSymbolOverrides`/`applyReliabilityMultiplierUpdatesForSymbol`/
`resetReliabilityOverridesForSymbol`/`effectiveReliabilityOverridesForSymbol`
в `pattern-categories.ts`, `symbolId` протянут через
`computeDirectionScore(...)` в `direction-prediction.ts` до
`getReliabilityMultiplier(name, symbolId)`, и `CalibrationPanel.tsx`
вызывает именно per-symbol версии — но **без единого слова в
changelog'е**. Сама реализация признана корректной (per-symbol override
не течёт между инструментами, per-symbol test suite это покрывает) —
задокументировать здесь, а не переписывать код заново.

**Это уже сделано** (не переделывалось в рамках этого прохода, только
задокументировано задним числом): калибровка `PATTERN_RELIABILITY_MULTIPLIER`
через кнопку "Калибровать" в `CalibrationPanel.tsx` применяется и
сохраняется (`localStorage`, ключ
`pattern-reliability-multiplier-symbol-v1:${symbolId}`) отдельно на
каждый инструмент. Не найден override для конкретного символа — действует
общий дефолт `PATTERN_RELIABILITY_MULTIPLIER` (как и раньше). Панель
показывает предпросмотр "было/станет" на основе
`effectiveReliabilityOverridesForSymbol(symbolId)` — то, что реально
применится к ТЕКУЩЕМУ инструменту, а не глобальный дефолт, который мог
быть перекрыт для другого символа ранее.

## Находка 2 — осиротевший глобальный API (устранена в этом проходе)

Глобальные (не per-symbol) `applyReliabilityMultiplierUpdates()` и
`resetReliabilityOverrides()` из исходного Этапа 2 остались в
`pattern-categories.ts` экспортированными, но с тех пор как
`CalibrationPanel.tsx` целиком переключился на per-symbol API (находка 1),
ни один продакшен-код их больше не вызывал — только их собственные тесты.
Два независимых, частично дублирующих друг друга публичных пути
применения одного и того же множителя вводят в заблуждение при чтении
кода: неочевидно, какой из них "настоящий".

### Что сделано

- **`src/lib/pattern-categories.ts`**: `applyReliabilityMultiplierUpdates()`,
  `resetReliabilityOverrides()` и вспомогательный снимок
  `HANDWRITTEN_PATTERN_RELIABILITY_MULTIPLIER` (нужен был только
  `resetReliabilityOverrides()`) — удалены. `PATTERN_RELIABILITY_MULTIPLIER`
  (сам словарь, экспортируемый и мутируемый на месте) — НЕ трогали, он
  по-прежнему единственный источник глобального дефолта, на который
  падает `getReliabilityMultiplier`, когда per-symbol override не задан.
  `loadPersistedReliabilityOverrides()` (чтение легаси-ключа
  `pattern-reliability-multiplier-v1` при импорте модуля) — сохранена
  НАВСЕГДА, не как временный мост: пользователи, которые уже нажимали
  "Применить" до появления per-symbol слоя, не должны молча терять
  сохранённую калибровку при следующей загрузке страницы.
- **`src/lib/pattern-categories.test.ts`**: тесты удалённых функций
  заменены на:
  - Новый `describe('legacy global reliability override (backward
    compatibility)', ...)` — через `vi.resetModules()` + динамический
    `import()` проверяет, что легаси-ключ в `localStorage` (сохранённый
    до-per-symbol версией) по-прежнему подхватывается как глобальный
    дефолт при переимпорте модуля, и что битый JSON в этом ключе не роняет
    импорт, а откатывается к ручному дефолту (`inside-bar: 0.1`).
  - Существующий `describe('per-symbol reliability overrides', ...)`
    оставлен как есть по сути (та же матрица сценариев: изоляция между
    символами, приоритет per-symbol над глобальным, клампинг, сброс,
    персистентность под symbol-scoped ключом) — только там, где тест
    выставлял "глобальный дефолт" через удалённую
    `applyReliabilityMultiplierUpdates()`, теперь используется прямая
    мутация экспортированного `PATTERN_RELIABILITY_MULTIPLIER` (тот же
    объект, что читает `getReliabilityMultiplier` в проде) со
    снимком/восстановлением в `beforeEach`/`afterEach`.
- **`src/lib/pattern-reliability-calibration.ts`**: два докстринга,
  ссылавшихся на удалённую `applyReliabilityMultiplierUpdates` как на
  следующий шаг после `toMultiplierUpdates`, поправлены на актуальную
  `applyReliabilityMultiplierUpdatesForSymbol`.

### Проверка (прогнано лично, не только заявлено)

- `npm install` — 665 пакетов, без ошибок.
- `npx tsc --noEmit -p tsconfig.app.json` — 0 ошибок.
- `npx eslint .` — чисто (весь репозиторий).
- `npx vitest run` — 753/755 тестов проходят (было 757/759 до чистки:
  −6 тестов удалённых глобальных функций, +2 новых теста обратной
  совместимости легаси-ключа = −4, ожидаемо). Те же 2 непричастных падения
  в `gemini-analysis.test.ts` (нет `VITE_SUPABASE_URL`/
  `VITE_SUPABASE_ANON_KEY` в окружении) — не связаны с этой правкой,
  видны и без неё.

### Что сознательно не менялось

- Сама логика per-symbol калибровки надёжности (находка 1) — уже
  корректна, трогать не стал, только задокументировал.
- `PATTERN_RELIABILITY_MULTIPLIER` как словарь и его начальные ручные
  значения (`'inside-bar': 0.1`) — не менялись.
- Этап 3 (расширение `featureVector`) — по-прежнему не начат, вне рамок
  этого прохода.
