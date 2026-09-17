# trading-pwa-terminal

Профессиональный торговый терминал (PWA) с анализом по Smart Money
Concepts / ICT (Order Blocks, FVG, Breaker Blocks и др.), реальными
котировками с Binance и Deriv и калибруемой моделью генерации сигналов.

Стек: Vite + React 18 + TypeScript + Zustand + Supabase + Web Worker для
тяжёлых вычислений + Playwright (e2e).

## Быстрый старт

```bash
npm install
cp .env.example .env   # заполнить хотя бы Supabase-переменные, см. ниже
npm run dev
```

## Переменные окружения

Полный список — в `.env.example`. Кратко:

| Переменная               | Обязательна | Назначение |
|---------------------------|-------------|------------|
| `VITE_SUPABASE_URL`       | Да\*        | Персистентность сигналов/калибровки, edge-функции-прокси |
| `VITE_SUPABASE_ANON_KEY`  | Да\*        | То же |
| `VITE_DERIV_APP_ID`       | Нет         | По умолчанию `1089` (публичный demo app_id Deriv) |
| `VITE_SENTRY_DSN`         | Нет         | Без него ошибки просто идут в `console.error` |
| `VITE_YAHOO_PROXY_URL`    | Только для источника Yahoo | CORS-прокси для Yahoo Finance |

\* Приложение **не падает** без Supabase — весь код в
`src/lib/signal-persistence.ts` no-op'ает при `isSupabaseConfigured ===
false`, история сигналов при этом остаётся только в `localStorage`. Но
источники котировок, идущие через edge-функции (`finnhub`,
`twelvedata`, `yahoo`, Gemini-анализ), без Supabase не работают вообще.

Секреты для edge-функций (`TWELVEDATA_API_KEY`, `FINNHUB_API_KEY`,
`GEMINI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) задаются в Supabase
Dashboard → Edge Functions → Secrets — **не** во фронтенд-`.env`.

## Скрипты

```bash
npm run dev         # dev-сервер (Vite)
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint (flat config, ESLint 9)
npm run test        # Vitest, единожды
npm run test:watch  # Vitest в watch-режиме
npm run ci          # typecheck && lint && test — прогонять перед каждым коммитом/PR
npm run build       # tsc --noEmit && vite build — билд провалится при любой ошибке типов
npm run preview     # локальный просмотр production-сборки
npm run e2e         # Playwright e2e (нужно npx playwright install --with-deps chromium)
npm run backtest    # офлайн-бэктест стратегий (tsx backtest/index.ts)
npm run backtest:harmonic-audit    # эмпирический аудит детектора гармоник на синтетических данных
npm run backtest:htf-resample-audit # эмпирический аудит стабильности HTF OB/FVG-зон на скользящем окне
```

`npm run build` намеренно включает полную проверку типов перед
`vite build` — не убирайте `tsc --noEmit` из этого скрипта ради
скорости; при ошибке типов чинить нужно типы, а не обходить проверку.

## Бэктест: что на самом деле измеряют метрики

`npm run backtest` / `npm run backtest:harmonic-audit` / `npm run
backtest:htf-resample-audit` — офлайн-инструменты для проверки детекторов
паттернов на исторических/синтетических данных (`backtest/`).

**Важная оговорка при интерпретации отчётов `backtest/output/*.md`**
(задокументировано по итогам аудита, см.
`docs/audit/recommendations-post-harmonic-audit.md`, Рекомендация 6):
`resolveOutcome()`/`applySpreadToOutcome()` (`backtest/simulator.ts`)
резолвят исход закрытием `expiryBars`-й свечи после входа, а не
фактическим достижением структурных уровней — это сознательное,
синхронизированное с демо-счётом поведение всего движка (не специфично
для гармоник). Следствие: любой бэктест конкретного детектора паттернов
через `simulate()` измеряет **точность предсказания направления на
экспирации**, а не качество структурных уровней, которые считает этот
детектор (`harmonicStop`/`harmonicTarget` у harmonic-pattern, аналогичные
уровни у Order Block/FVG-детекторов). Не делайте из текущих R-метрик
вывод о "прибыльности SL/TP-логики" — для такой оценки нужен отдельный
режим резолвинга исхода (первое касание структурных уровней вместо
знака на экспирации), которого пока нет.

## База данных / edge-функции (Supabase)

`npm run build` **не трогает** Supabase. Миграции и функции
применяются отдельно:

```bash
supabase db push                     # применить все файлы из supabase/migrations/ по порядку
supabase functions deploy proxy-yahoo
supabase functions deploy proxy-twelvedata
supabase functions deploy proxy-finnhub
supabase functions deploy proxy-gemini
supabase functions deploy delete-all-signals
```

## PWA

Проект — устанавливаемое PWA (`vite-plugin-pwa`, `generateSW`).
`dist/sw.js` и `dist/workbox-*.js` **генерируются заново при каждой
сборке** — не редактировать вручную и не коммитить `dist/` в git (см.
`.gitignore`). После сборки стоит проверять:

- что `dist/manifest.webmanifest` ссылается только на реально
  существующие в `dist/` иконки;
- Lighthouse PWA-аудит (`npm run preview` → Chrome DevTools →
  Lighthouse) — критерий installability должен быть зелёным.

## Перед деплоем

1. `npm run ci` — зелёный (typecheck + lint + test).
2. `npm run build` — без ошибок, обратить внимание на предупреждение
   `chunks are larger than 500 kB` (см. `manualChunks` в
   `vite.config.ts`).
3. Миграции и edge-функции Supabase применены/задеплоены (см. выше).
4. `npm run e2e` — хотя бы дымовой прогон, если в окружении можно
   установить браузеры Playwright.

Подробный чек-лист и контекст по каждому пункту — в
[`docs/AUDIT_BOLT_RECOMMENDATIONS.md`](docs/AUDIT_BOLT_RECOMMENDATIONS.md).

## История изменений

Хронология всех сессий аудита/доработки — в [`CHANGELOG.md`](CHANGELOG.md),
подробные отчёты по каждой — в [`docs/changelog/`](docs/changelog/).
