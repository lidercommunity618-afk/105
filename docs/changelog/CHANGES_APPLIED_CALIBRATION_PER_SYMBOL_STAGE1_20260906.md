# CHANGES_APPLIED_CALIBRATION_PER_SYMBOL_STAGE1_20260906.md

Дата: 2026-09-06.

Промт: «Как в приложении организовать и наладить полноценную работу
модуля "КАЛИБРОВКА" совместно с данными "АНАЛИТИКА ПО ФАКТОРАМ" для
самообучения приложения, чтобы сигналы для входа в позицию были
максимально точными. Собери Этап 1 из рекомендаций, ничего не
сломав.»

## Аудит (подтверждено в коде)

- `calibrationModel` и `engine` в `useTickStore.ts` были module-level
  синглтонами, создаваемыми ОДИН раз за всё время жизни приложения и
  никогда не пересоздаваемыми при смене инструмента — одна логрегрессия
  обучалась на исходах ВСЕХ символов сразу.
- `calibration-model.ts`: `loadCalibrationState`/`persistCalibrationState`
  писали в единый фиксированный ключ localStorage (`terminal-calibration-v1`)
  без привязки к символу.
- `calibration_state` в Supabase — singleton-таблица с `CHECK (id =
  '00000000-...')`, одна строка на всё приложение.
- `useAnalyticsStore.ts`: `calibrationSampleCount`/`calibrationReady`
  перезаписывались ТРЕМЯ независимыми функциями с разными порогами
  готовности (`setCalibrationResult` — ATR-бэктест, `setCalibrationState`
  — реальный ML-семпл-каунт с хардкодом `>= 10` вместо `MIN_SAMPLES=100`,
  `recomputeStats` — просто счётчик резолвнутых сигналов).
- `CalibrationPanel.tsx`: `computeBuckets`/`computeFactorStats` получали
  ВЕСЬ `signals` без фильтра по инструменту.
- `engine.ts::recordOutcome`: `timeout` кодировался как `outcome = 0`
  (проигрыш) в обучающей выборке, хотя `recomputeStats()` корректно
  исключает timeout из знаменателя винрейта.

## Что сделано (Этап 1 — низкий риск, без ML-архитектурных изменений)

1. **Per-symbol калибровочная модель.**
   - `calibration-model.ts`: `loadCalibrationState`/`persistCalibrationState`
     принимают необязательный `symbolId` — с ним пишут в
     `terminal-calibration-v1:${symbolId}`, без него (юнит-тесты) ведут
     себя как раньше, один в один.
   - `engine.ts`: добавлен `DecisionEngine.setCalibration(model)` —
     позволяет подменить модель у уже существующего движка-синглтона, не
     пересоздавая его.
   - `useTickStore.ts`: `calibrationModelsBySymbol: Map<symbolId,
     CalibrationModel>` — по одной модели на каждый посещённый в сессии
     инструмент. Новая `switchCalibrationModel(symbolId)` вызывается из
     `start()` с ЦЕЛЕВЫМ символом и: синхронно достаёт модель из памяти
     или localStorage (или создаёт новую), подставляет её в движок и в
     `useAnalyticsStore`, затем асинхронно проверяет Supabase (может
     содержать более новое состояние с другого устройства), не блокируя
     переключение.
   - `signal-persistence.ts`: `saveCalibrationState`/
     `loadCalibrationStateFromDb` принимают `symbolId` (по умолчанию
     `'BTCUSDT'` для обратной совместимости вызовов без параметра),
     конфликт-ключ upsert'а — `symbol_id`, а не фиксированный `id`.
   - Новая миграция `20260906120000_calibration_state_per_symbol.sql`:
     добавляет `symbol_id text NOT NULL DEFAULT 'BTCUSDT'`, снимает
     singleton-`CHECK`, переносит PK с `id` на `symbol_id`. Существующая
     единственная строка (если была) становится записью BTCUSDT —
     накопленные веса/сэмплы не теряются.
   - `tick-store/outcomes.ts`: `OutcomeDeps.getCalibrationModel`/
     `triggerRetrain` теперь принимают `symbolId` — исход всегда
     обучает модель ИМЕННО того инструмента, по которому был сигнал
     (`signal.symbolId`), а не "текущую активную".

2. **Разделены три смысла `calibrationSampleCount`/`calibrationReady`.**
   Старые поля в `useAnalyticsStore.ts` оставлены КАК ЕСТЬ (не меняют
   поведение, существующие тесты не тронуты) — рядом добавлены честно
   названные, не конфликтующие поля:
   - `mlSampleCount` / `mlReady` — реальный ML-семпл-каунт
     `CalibrationModel.getSampleCount()` и готовность по
     импортированному `MIN_SAMPLES` (100), а не хардкоду `>= 10`.
   - `atrBacktestTrades` — число сделок ATR-бэктеста
     (`workerClient.calibrate`), отдельная фича от ML-калибровки.
   - `liveCompletedCount` — просто количество резолвнутых, реально
     проторгованных сигналов, без порога готовности.
   `CalibrationPanel.tsx` теперь показывает индикатор "Калибровка
   активна / Сбор данных (X из 100)" по `mlReady`/`mlSampleCount`, а не
   по старому смешанному полю. Блок результатов ATR-бэктеста явно
   подписан "ATR-бэктест (отдельно от ML-калибровки выше)", чтобы не
   читаться как та же самая готовность.

3. **`timeout` исключён из обучающей выборки.**
   `engine.ts::recordOutcome` теперь возвращает `null` для `outcome ===
   'timeout'` до добавления сэмпла — модель обучается на той же
   разметке (win/loss), что видит пользователь в винрейте, вместо того
   чтобы трактовать "не дождались решения" как проигрыш.

4. **"НАДЁЖНОСТЬ ПО УВЕРЕННОСТИ" и "АНАЛИТИКА ПО ФАКТОРАМ" — по
   инструменту.** `CalibrationPanel.tsx` фильтрует `signals` по
   `symbolId` активного инструмента ПЕРЕД передачей в
   `computeBuckets`/`computeFactorStats` — сами функции не менялись
   (их прямые юнит-тесты, вызывающие без фильтра, продолжают работать).

## Что осознанно НЕ делалось в Этапе 1

- Логрегрессия по-прежнему обучается на 8-компонентном агрегированном
  `featureVector` (см. `signal-builder.ts`) — паттерны-триггеры
  (doji/inside-bar/...) всё ещё сворачиваются в один скаляр `trigger`
  перед попаданием в модель. Это Этап 3 (расширение featureVector,
  версионирование сэмплов, отдельный PR) — сознательно отложено до
  накопления 100+ per-symbol исходов на Этапе 1.
- `PATTERN_RELIABILITY_MULTIPLIER` (`pattern-categories.ts`) всё ещё
  правится вручную — автоматический пересчёт по формуле из
  `computeFactorStats()` (Этап 2) не реализован в этом проходе.

## Проверка

- `npm run typecheck` — 0 ошибок.
- `npm run lint` — чисто на всех изменённых файлах.
- `npx vitest run` — 723/725 тестов проходят. Единственные 2 падения
  (`src/lib/gemini-analysis.test.ts`) воспроизводятся на неизменённом
  коде и вызваны отсутствием `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`
  в окружении — не связаны с этим изменением.
- Один тест (`tick-store/outcomes.test.ts`, `triggerRetrain` теперь
  вызывается с `(model, symbolId)`) обновлён под новую, ожидаемую
  сигнатуру — сам факт передачи `symbolId` и есть цель Этапа 1, п.1–2.

## Следующий шаг

Этап 2 (см. промт): связать `computeFactorStats()` с
`PATTERN_RELIABILITY_MULTIPLIER` через кнопку "Калибровать" с
предпросмотром "было / станет" — по готовности продолжим.
