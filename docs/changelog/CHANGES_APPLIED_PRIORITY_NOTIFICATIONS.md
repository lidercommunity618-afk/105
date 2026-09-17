# CHANGES_APPLIED_PRIORITY_NOTIFICATIONS.md

Дата: 2026-08-24.

Промт: «Гарантированные приоритетные уведомления» (см. переписку —
задача на то, чтобы каждый сигнал зависел от порога из «Приоритетные
уведомления» и **всегда** вызывал приоритетный баннер и звук).

## Аудит перед изменениями

Полная трассировка `signal-builder.ts → engine.ts → useTickStore.ts /
pre-close.ts → tick-store/shared.ts → PriorityAlertBanner.tsx /
audio.ts` показала: базовое требование промта **уже было выполнено**
в коде на момент аудита —

- `buildSignal()` создаёт сигнал только если `calibratedProbability
  >= priorityThreshold` (сигналов ниже порога в приложении просто не
  существует);
- `notifySignal()` — единственная точка, которая одновременно
  показывает `PriorityAlertBanner` и играет `playPriorityAlert()`,
  синхронно, без условий, из обоих путей создания сигнала.

Изменения ниже — не переписывание этой логики, а точечное закрытие
найденных пробелов: отсутствие defense-in-depth, нерабочие тумблеры
звука в UI и отсутствие тест-покрытия.

## Задача 1 — Defense-in-depth в `notifySignal()`

**Файл:** `src/stores/tick-store/shared.ts`.

`SignalNotificationSettings` сужен до `{ priorityThreshold: number }`
(поля `soundPrioritySignal`/`soundNewSignal` удалены — они и раньше
игнорировались функцией). `notifySignal()` теперь сама пересчитывает
вероятность той же формулой, что и `buildSignal()`
(`calibratedProbability ?? sigmoidFallback(score)`), и если сигнал
всё же оказался ниже `priorityThreshold` (это не должно происходить
при штатной работе — сигнал уже обязан был пройти фильтр в
`buildSignal()`), вызывает `captureError(...)` с контекстом
`notifySignal.invariant`, но **не скрывает** баннер/звук — они всё
равно показываются. Это защищает требование «исключить сигнал без
баннера и звука» даже от гипотетического будущего бага, который бы
вызвал `notifySignal()` в обход `buildSignal()`.

Оба call-site'а (`pre-close.ts`, `useTickStore.ts`) передают в
`notifySignal` полный `useSettingsStore.getState()`, который уже
содержит `priorityThreshold` — изменений в самих вызовах не
потребовалось (структурная типизация TS).

## Задача 2 — Убраны нерабочие тумблеры звука

Тумблеры «Новый сигнал» / «Приоритетный сигнал» в Settings и
Onboarding ничего не делали ещё до этих изменений — звук всегда
играл независимо от их состояния. Это вводило пользователя в
заблуждение (обещало выбор, которого на самом деле нет). Убраны
полностью:

- **`src/stores/settingsStore.ts`** — поля `soundNewSignal` /
  `soundPrioritySignal`, их сеттеры и persist-ключи удалены из
  `SettingsState`. Добавлен шаг миграции `version < 11`, который
  вычищает эти ключи из уже сохранённого у пользователей стейта.
  `persist(...).version` поднят `10 → 11`.
- **`src/ui/SettingsPanel.tsx`** — секция «Звуковые уведомления»
  заменена статичным пояснением (звук+баннер обязательны, отключить
  нельзя). Текст под «Приоритетные уведомления» исправлен — раньше
  он подразумевал существование «неприоритетных» сигналов, которых в
  приложении не бывает.
- **`src/ui/Onboarding.tsx`** — шаг `sound` лишился интерактивных
  тумблеров (заменены на тот же текст), удалён более не используемый
  компонент `ToggleRow`.

## Задача 3 — Тест-покрытие

- **`src/decision/signal-builder.test.ts`** — новый блок
  `buildSignal — priorityThreshold gate`: включительная граница
  (`>=`, не `>`), фильтрация выше/ниже порога, отсутствие фильтра при
  `priorityThreshold: undefined`, тот же гейт при готовой калибровочной
  модели (не только на sigmoid-фолбэке).
- **`src/stores/tick-store/shared.test.ts`** — существовавший блок
  `describe('notifySignal', ...)` в этом файле тестировал поведение,
  которого в реальном коде никогда не было (гейтинг по
  `soundPrioritySignal`/`soundNewSignal`, отдельный `playSignalAlert`
  для сигналов ниже порога) — переписан полностью под реальное и
  теперь укреплённое поведение, включая новые тесты на
  defense-in-depth инвариант (`captureError` при аномалии, баннер и
  звук всё равно срабатывают).
- **`src/stores/useTickStore.test.ts`** — новый блок `settings
  subscription — reactive priorityThreshold propagation`: подтверждает,
  что изменение `priorityThreshold` в настройках вызывает
  `engine.setPriorityThreshold(...)`, а изменение других полей — нет.
  Заодно из мока `useSettingsStore.getState()` убраны удалённые поля.
- **`e2e/terminal.spec.ts`** — из фикстуры `skipOnboarding` убраны
  `soundNewSignal`/`soundPrioritySignal`; добавлен детерминированный
  тест, что тумблеры звука отсутствуют в UI и показан новый текст.
  Тест на реальное появление баннера/звука от живого сигнала **не
  добавлен** — эти e2e-тесты подключаются к живым котировкам
  (Binance WS), и ожидание реального сигнала в пределах таймаута
  теста было бы недетерминированным (флаки-тест), что само по себе
  является багом тестового набора.

## Не тронуто (по объёму задачи)

`direction-prediction.ts`, `signal-filters.ts`, `src/compute/**`,
`PriorityAlertBanner.tsx` (сам баннер, не логика его вызова),
`backtest/**`, миграции `version < 1 … < 10` в `settingsStore.ts`.

## Финальная проверка

**Важная оговорка:** в этом окружении (агент, применявший изменения)
сеть недоступна (`node_modules` не установлен, `npm install`
невозможен) — то же ограничение, что уже отмечено в
`CHANGES_APPLIED_PREVIOUS.md` для одной из прошлых доработок. Поэтому
`npm run typecheck` / `npm run lint` / `npm run test` / `npm run
build` **не были фактически прогнаны** в этом раунде — вся проверка
сделана вручную:

- построчный `grep` по всему `src/` и `e2e/` подтвердил отсутствие
  оставшихся ссылок на `soundNewSignal`/`soundPrioritySignal`/их
  сеттеры вне кода миграции;
- сверены сигнатуры (`captureError(error, context?)`,
  `sigmoidFallback(score): number`, поля `Signal.score` /
  `Signal.calibratedProbability`) с реальными объявлениями типов;
- проверено, что оба call-site'а `notifySignal()` передают переменную
  (не объектный литерал) — значит сужение типа
  `SignalNotificationSettings` не ломает вызов через TS excess-property
  check;
- построчно перечитаны все изменённые файлы целиком после правок.

**Перед деплоем обязательно прогнать локально:**
`npm run typecheck && npm run lint && npm run test && npm run build`.
