# CHANGES_APPLIED_AUDIT_20260828.md — исправления по аудиту от 28.08.2026

Этот файл документирует все изменения, применённые по результатам
аудита «Аудит проекта «67-main» (Trading PWA Terminal)» (дата аудита:
28 августа 2026). Аудит основывался на реальном прогоне `tsc`,
`eslint`, `vitest` (566 тестов) и `vite build` поверх этого архива.

**Важно:** в окружении, где применялись исправления, недоступна сеть
(нельзя выполнить `npm install`/`tsc`/`eslint`/`vitest`/`vite build`).
Все правки сделаны построчным ревью кода и должны быть провалидированы
командой `npm run ci` (см. `AUDIT_BOLT_RECOMMENDATIONS.md`) сразу после
сборки в bolt.new/локально — это первое, что нужно сделать после
разворачивания этого архива.

---

## 1. [Критично] PWA-иконки физически отсутствовали

**Файлы:** `public/icon-192.png`, `public/icon-512.png`,
`public/icon-512-maskable.png`, `public/apple-touch-icon.png` (все
новые), `vite.config.ts`, `index.html`.

- Манифест (`vite.config.ts` → `VitePWA({ manifest: { icons: [...] } })`)
  ссылался на `icon-192.png`/`icon-512.png`/`apple-touch-icon.png`,
  которых не было в `public/` — при установке PWA на Android/iOS
  иконка была бы битой (Android) или отсутствующей вовсе (iOS делает
  скриншот страницы вместо иконки).
- Сгенерированы 4 PNG-файла, воспроизводящие дизайн существующего
  `public/favicon.svg` (тёмный фон `#0a0e17`, бирюзовая линия графика
  `#1de6c2`, синяя точка `#3385ff`): обычные 192×192 и 512×512,
  maskable 512×512 (контент вписан в safe zone ~80%, как требует
  спецификация maskable-иконок Android), и apple-touch-icon 180×180
  (непрозрачный, без альфа-канала — по рекомендации Apple HIG).
- `vite.config.ts`: манифест обновлён — maskable-иконка теперь
  отдельный файл `icon-512-maskable.png` вместо дублирования обычной
  512-иконки с `purpose: 'maskable'` (у обычной иконки нет safe-zone
  отступа, что ломает отображение в лаунчерах с круглой/капле-видной
  маской).
- `index.html`: добавлен `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`
  — `includeAssets` в `VitePWA` только кладёт файл в precache
  service worker'а, но **не** добавляет HTML-тег; без явного тега iOS
  Safari не подхватывает apple-touch-icon вообще.

**Рекомендация на будущее:** сгенерированные иконки — программная
реконструкция дизайна `favicon.svg` через Pillow (в окружении не было
SVG-рендерера вроде `rsvg-convert`/`cairosvg`). Дизайнеру стоит
заменить их финальными брендированными иконками перед публикацией в
сторы/на реальный домен — технически (размеры, `purpose`,
подключение) всё уже корректно.

## 2. [Высокая] `setCurrentSignal` вызывался на каждом промежуточном тике

**Файл:** `src/stores/useTickStore.ts`, функция `maybeEvaluateSignal`.

Блок `analytics.setCurrentSignal(finalSignal)` / `addSignal` /
`ensureScheduler().schedule(...)` / `saveSignal(...)` вызывался
безусловно, включая вызовы с `isClosed === false` (промежуточные тики
формирующейся свечи). Обёрнут в `if (isClosed) { ... }` — теперь
срабатывает строго в тех же двух случаях, что и открытие демо-сделки
(pre-close или закрытие свечи), как и было задокументировано в
комментарии разработчика прямо над этим кодом.

Это закрывает падающий тест
`src/stores/useTickStore.test.ts` → `signal notification gating —
intermediate ticks do not update currentSignal` → `intermediate tick
(isClosed=false) does not call setCurrentSignal or play alerts`.

## 3. [Средний, security] RLS: anon-ключ мог удалить всю историю сигналов и модель калибровки

**Файлы:**
`supabase/migrations/20260828120000_lock_down_signals_and_calibration_delete.sql`
(новый), `supabase/functions/delete-all-signals/index.ts` (новый),
`src/lib/signal-persistence.ts`.

- `trading_signals` и `calibration_state` были открыты на `DELETE` для
  `anon, authenticated` с `USING (true)`. Anon-ключ публичен (виден в
  каждом сетевом запросе браузера) — любой, кто его скопировал, мог
  одним REST-запросом безвозвратно стереть общую историю сигналов или
  испортить веса калибровочной модели для всех пользователей деплоя.
- Новой миграцией DELETE-политики для обеих таблиц удалены (`DROP
  POLICY`). RLS остаётся включённым — без политики DELETE anon просто
  не имеет права на эту операцию.
- Кнопка «Удалить всё» (`SignalFeed.tsx` → `deleteAllSignals()`)
  теперь ходит в новую edge-функцию `delete-all-signals`, которая сама
  выполняет `DELETE` service-role ключом на сервере (обходит RLS
  изнутри Deno-рантайма, никогда не покидает сервер) и rate-limit'ится
  через существующую таблицу `rate_limits` (3 запроса/мин на
  клиента) — тот же паттерн, что уже использовался в `proxy-*`
  edge-функциях для API-ключей источников котировок.
- **Осознанно оставлено без изменений:** INSERT/UPDATE-политики на
  `trading_signals` (нужны `saveSignal`/`updateSignalOutcome` —
  частые, штатные, поштучные операции) и UPDATE на `calibration_state`
  (нужен `saveCalibrationState` upsert). Это менее катастрофичный риск,
  чем безвозвратный bulk-DELETE, и вынесение их в edge-функции —
  отдельная, более крупная архитектурная работа, которую стоит делать
  с возможностью полного прогона тестов (см. `AUDIT_BOLT_RECOMMENDATIONS.md`).

**Требуется ручной шаг после деплоя:** применить новую миграцию к
реальному Supabase-проекту (`supabase db push` или через Dashboard) —
она не применяется автоматически при сборке фронтенда.

## 4. [Средний, performance] Основной JS-бандл 846 KB без code-splitting

**Файл:** `vite.config.ts`.

Добавлен `build.rollupOptions.output.manualChunks` — `lightweight-charts`
и `@sentry/react` (два самых тяжёлых пакета в зависимостях) теперь
собираются в отдельные чанки `vendor-charts`/`vendor-sentry` и
грузятся параллельно с основным кодом вместо раздувания одного файла.
Чисто конфигурационное изменение сборки — код приложения не тронут,
поведение в рантайме не меняется.

## 5. [Средний, mobile] Нижний таб-бар не учитывал safe-area на iPhone

**Файл:** `src/ui/MobileNav.tsx`.

`<nav>` с нижней навигацией не добавлял `padding-bottom:
env(safe-area-inset-bottom)`, хотя `index.html` объявляет
`viewport-fit=cover`. На iPhone X+ в установленном PWA (standalone)
таб-бар прижимался к самому краю экрана — тап-зоны кнопок попадали в
зону жеста возврата на домашний экран. Добавлен
`style={{ paddingBottom: 'max(0.25rem, env(safe-area-inset-bottom))' }}`
— тот же паттерн, что уже используется в `LandscapeControls.tsx` для
верхнего safe-area.

## 6. [Низкий, a11y] Зум был запрещён

**Файл:** `index.html`.

Убраны `maximum-scale=1.0` и `user-scalable=no` из
`<meta name="viewport">` — они полностью отключали pinch-to-zoom, что
нарушает WCAG 2.1 SC 1.4.4 (Resize text) и особенно чувствительно для
торгового терминала с мелкими цифрами. Layout не рассчитан на зум
специальным образом, но теперь пользователи с ослабленным зрением как
минимум могут им воспользоваться.

## 7. [Низкий, offline] Google Fonts не кэшировались service worker'ом

**Файл:** `vite.config.ts`.

Добавлены `workbox.runtimeCaching` правила для
`fonts.googleapis.com` (`StaleWhileRevalidate` — стили шрифта) и
`fonts.gstatic.com` (`CacheFirst`, TTL 1 год — сами файлы шрифтов,
неизменны по URL). Раньше эти домены не входили в `globPatterns`
(тот кэширует только собственные ассеты сборки), поэтому при плохой
сети/офлайн шрифты не подтягивались (FOUT/откат на системный шрифт).

---

## Что проверено дополнительно и признано в порядке

Помимо семи пунктов аудита, вручную дополнительно проверены (без
инструментов — построчным ревью, сеть недоступна):

- `src/stores/useDemoAccountStore.ts` (466 строк) — логика мартингейла,
  открытия/резолюции сделок, guard от параллельных сделок на один
  инструмент, миграция персистентного состояния (v1→v5) — не найдено
  новых проблем сверх уже задокументированных в комментариях прошлых
  аудитов.
- `src/stores/useAnalyticsStore.ts` — дедуп истории по `signal.id`,
  `resetSession()` vs `clearAll()`, персистенция только `signals`
  (winRate/calibrationSampleCount — производные, пересчитываются
  через `recomputeStats()`) — корректно.
- `src/hooks/useAppUpdate.ts`, `src/hooks/useLandscape.ts` — cleanup
  всех `addEventListener` присутствует, утечек не найдено.
- `src/ui/ErrorBoundary.tsx` — стандартная реализация, интегрирована с
  Sentry через `captureError`.
- Поиск по всему `src/`: забытых `console.log`/`console.debug`/
  `debugger`/`TODO`/`FIXME` — не найдено (подтверждает аудит).

## Не проверено в этой сессии (нет сети/инструментов)

- Реальный прогон `tsc --noEmit`, `eslint .`, `vitest run`, `vite
  build` — **обязательно** прогнать сразу после разворачивания архива
  (см. `AUDIT_BOLT_RECOMMENDATIONS.md`), это единственный способ
  гарантировать, что все 566 тестов зелёные и правки не сломали
  типизацию/линт.
- `npm run e2e` (Playwright) — браузеры Playwright не были доступны ни
  в окружении исходного аудита, ни здесь.
- Полное построчное ревью всех 179 файлов `src/` (индикаторы,
  паттерны, `decision/` движок) — аудит и это исправление
  сфокусированы на 7 найденных проблемах и точечной дополнительной
  проверке демо-счёта/истории/PWA/мобильного UI, как и было запрошено;
  остальное аудит уже пометил как «в хорошем состоянии» на основании
  чистого `tsc`/`eslint`/565 из 566 тестов.
