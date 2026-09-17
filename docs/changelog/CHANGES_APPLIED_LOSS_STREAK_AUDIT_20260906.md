# Аудит 2026-09-06: 4 убыточные сделки подряд (BTCUSDT M1, 20:15–20:29 UTC) + деактивация автоудаления

## Триггер
4 сделки BTCUSDT M1 подряд закрылись в убыток (SELL 20:15, BUY 20:16, SELL 20:23,
BUY 20:29 — ADX 14.9–19.0, regime=range, session=closed — суббота, все паттерны/
стратегии активны, scoreThreshold=2). Разбор скриншотов графика и .md-отчётов по
каждой сделке против кода (не только против файла-диагноза 8.docx) подтвердил 7
конкретных дефектов сигнального движка. Внешняя проверка: классификация ADX
Уайлдера (<20 — no trend, 20–25 — developing, >25 — trending) — общепринята
(babypips/Forexpedia и др.), что обосновывает выбор порога hard-veto = 20.

## Изменения

1. **Regime-гейт: мягкий штраф → hard veto ниже ADX 20** (`signal-filters.ts`)
   ADX < 30 в range давал ×0.35 к score, но не блокировал; все 4 сделки (ADX
   14.9–19.0) получили штраф и всё равно прошли. Теперь ADX < 20 обнуляет
   сигнал (invalidated=true); 20–30 остаётся мягким штрафом.

2. **scoreThreshold: 2 → 4** (`types/domain.ts`, `SettingsPanel.tsx`)
   2 из 10 практически ничего не отсеивало — даже урезанный regime-гейтом
   сигнал (4.3–7.0 в наших 4 сделках) проходил свободно.

3. **Настоящая M15 HTF-структура вместо псевдо-HTF** (новый файл
   `compute/indicators/htf-structure.ts`, `compute/patterns/index.ts`,
   `compute/patterns/strong-order-block-reaction.ts`)
   И `strong-order-block-reaction.ts` (через `ctx.structure` напрямую), и
   `mean-reversion.ts` (через `computeStructure(candles, 60, ...)`) считали
   "HTF" на тех же M1-свечах с другим lookback — не на другом таймфрейме.
   Теперь M1→M15 агрегируется по-настоящему (OHLCV-ресэмплинг), и
   `strong-order-block-reaction`'s HTF-bias гейт получает отдельный параметр
   `htfStructure`, посчитанный на реальных M15-барах.

4. **Устранён двойной учёт паттерна** (`lib/pattern-categories.ts` — новый
   `STRATEGY_BONUS_PATTERNS`, `decision/direction-prediction.ts`)
   10 стратегий (OBC, MDM, 4×FVG-*, order-block-nested/breaker,
   impulse-breakout, liquidity-sweep-reaction) получали вклад в score ДВАЖДЫ:
   через общий `components.trigger` (вес 1.5) И через персональный
   strategy-бонус в `signal-builder.ts`. Реальный пример: сделка SELL
   79733.00 (20:15) — order-block-continuation дал -1.00 как trigger И +0.55
   как "OBC strategy" одновременно. Теперь для этих паттернов
   `components.trigger` обнуляется — бонус остаётся единственным источником.

5. **Chop-guard в кулдауне** (`decision/signal-cooldown.ts`, `decision/engine.ts`)
   Кулдаун подавлял только повтор ТОГО ЖЕ направления. Наш инцидент — BUY→
   SELL→BUY за 13 минут в одной зоне — три разных направления, ни одно не
   повторяющееся, поэтому кулдаун не подавил ничего. Добавлен отдельный,
   не завязанный на резолв chop-guard: ≥2 разных направлений в одной
   ценовой зоне за 15 минут блокируют следующий сигнал независимо от его
   направления.

6. **Бейдж "не откалибровано" в UI** (`ui/SignalCard.tsx`)
   Пометка `calibrationSource==='fallback'` была видна только в текстовом
   постмортем-отчёте (`lib/trade-report.ts`), не в момент принятия решения.
   Добавлен видимый бейдж рядом с процентом вероятности.

7. **Экспирация с учётом regime** (`decision/recommended-expiry.ts`,
   `decision/signal-builder.ts`)
   Экспирация считалась только по ATR/цене, никогда — по regime/ADX. Для
   сигналов, прошедших regime-гейт только с мягким штрафом (ADX 20–30),
   экспирация увеличена на 1 бар.

8. **Деактивировано автоудаление истории раз в сутки** (по прямому запросу)
   `hooks/useAutoCleanupSignals.ts` и его тест удалены; вызов убран из
   `App.tsx`; `useAnalyticsStore.ts::maybeRunAutoCleanup` — no-op (оставлен
   ради persist-схемы существующих пользователей). Единственный путь очистки
   истории теперь — ручная кнопка "Удалить все" (не изменена).

## Проверка
- `tsc --noEmit --strict` — 0 ошибок
- `vitest run` — 57/57 файлов, 721/721 тестов (2 теста в `gemini-analysis.test.ts`
  требуют `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` в окружении — не связаны
  с этими изменениями)
- `vite build` — успешно

## Не сделано в рамках этого прохода
- Тесты для `htf-structure.ts` написаны не были (только typecheck + косвенная
  проверка через `strategies.test.ts` и `patterns/index.ts`) — стоит добавить
  прямые unit-тесты на `aggregateToHigherTimeframe`.
- Пункт 3 (HTF) применён к `mean-reversion.ts` и `strong-order-block-reaction.ts`
  — если в кодовой базе появятся другие места с тем же псевдо-HTF паттерном
  (`computeStructure(candles, <другой lookback>, ...)`), их стоит проверить
  тем же способом.
