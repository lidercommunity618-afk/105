# Changelog

Полные детальные отчёты по каждой сессии аудита/доработки лежат в
[`docs/changelog/`](docs/changelog/). Здесь — хронологический индекс с
кратким содержанием каждого файла, чтобы не листать 14 отдельных
документов в поисках нужного.

| Дата       | Файл                                                                                             | О чём |
|------------|---------------------------------------------------------------------------------------------------|-------|
| не указана | [`CHANGES_APPLIED_PREVIOUS.md`](docs/changelog/CHANGES_APPLIED_PREVIOUS.md)                       | Первый раунд правок по промту «1»; отмечено, что `npm run ci`/`build` не запускались (не было сети) — изменения проверялись построчным ревью. |
| 2026-08-23 | [`CHANGES_APPLIED.md`](docs/changelog/CHANGES_APPLIED.md)                                         | Три точечные аддитивные доработки логики принятия решений (`direction-prediction.ts` и др.), без изменения существующего поведения. |
| 2026-08-24 | [`CHANGES_APPLIED_PRIORITY_NOTIFICATIONS.md`](docs/changelog/CHANGES_APPLIED_PRIORITY_NOTIFICATIONS.md) | Гарантированные приоритетные уведомления. |
| 2026-08-25 | [`CHANGES_APPLIED_FVG_AUDIT_FIX.md`](docs/changelog/CHANGES_APPLIED_FVG_AUDIT_FIX.md)              | Проверка качества реализации ранее внесённого FVG-фикса. |
| 2026-08-25 | [`CHANGES_APPLIED_SIGNAL_HISTORY_DEDUP.md`](docs/changelog/CHANGES_APPLIED_SIGNAL_HISTORY_DEDUP.md) | Устранение дублей и сигналов без метки в «Истории сигналов». |
| 2026-08-25 | [`CHANGES_APPLIED_SIGNAL_HISTORY_LABELS_AND_DELETE.md`](docs/changelog/CHANGES_APPLIED_SIGNAL_HISTORY_LABELS_AND_DELETE.md) | Метки истории сигналов и удаление записей. |
| 2026-08-26 | [`CHANGES_APPLIED_FVG_RENDER_TOUCH_VS_INVALIDATED_FIX.md`](docs/changelog/CHANGES_APPLIED_FVG_RENDER_TOUCH_VS_INVALIDATED_FIX.md) | Различение «касания» и «инвалидации» FVG при отрисовке. |
| 2026-08-27 | [`CHANGES_APPLIED_ORDER_BLOCK_MERGE_AUDIT.md`](docs/changelog/CHANGES_APPLIED_ORDER_BLOCK_MERGE_AUDIT.md) | Аудит и правка слияния Order Block. |
| 2026-08-27 | [`CHANGES_APPLIED_ORDER_BLOCK_SPEC.md`](docs/changelog/CHANGES_APPLIED_ORDER_BLOCK_SPEC.md)        | Приведение Order Block к спецификации «Алгоритм поиска и отрисовки Order Blocks» (адаптация абстрактного Python-промта под проект). |
| не указана | [`CHANGES_APPLIED_SIGNAL_STATS_AND_PATTERN_GROUPS.md`](docs/changelog/CHANGES_APPLIED_SIGNAL_STATS_AND_PATTERN_GROUPS.md) | Исправление бага в `patternNameSchema` (`level-reaction`) и статистика/группировка паттернов сигналов. |
| 2026-08-28 | [`CHANGES_APPLIED_OB_BREAKER_AND_NESTED.md`](docs/changelog/CHANGES_APPLIED_OB_BREAKER_AND_NESTED.md) | Order Block Breaker и вложенные (nested) блоки. |
| 2026-08-28 | [`CHANGES_APPLIED_AUDIT_20260828.md`](docs/changelog/CHANGES_APPLIED_AUDIT_20260828.md)            | Исправления по результатам полноценного аудита с реальным прогоном `tsc`/тестов. |
| 2026-08-29 | [`CHANGES_APPLIED_WAKE_LOCK_AND_ORIENTATION.md`](docs/changelog/CHANGES_APPLIED_WAKE_LOCK_AND_ORIENTATION.md) | Wake Lock и ориентация экрана — работа приложения при заблокированном/повёрнутом экране. |
| 2026-08-30 | [`CHANGES_APPLIED_DERIV_WS_POLL_RACE.md`](docs/changelog/CHANGES_APPLIED_DERIV_WS_POLL_RACE.md)    | Устранение гонки между WebSocket и polling в `DerivSource`. |
| 2026-08-30 | Репозиторная гигиена (этот коммит)                                                                 | `.gitignore` для `dist/`, перенос `CHANGES_APPLIED_*.md` в `docs/changelog/`, наполнение `README.md`, полный прогон `npm run ci` + `npm run build` (см. README). |
| 2026-09-04 | [`CHANGES_APPLIED_ENTRY_POINTS_AUDIT_20260904.md`](docs/changelog/CHANGES_APPLIED_ENTRY_POINTS_AUDIT_20260904.md) | Аудит фичи «точки входа + причины сигнала»: свеча входа выпадала из `chartContext`, SL/TP/expiry не попадали в постмортем-отчёт, дедуп `handleExport()`, секция факторной аналитики в CalibrationPanel, автоудаление истории раз в сутки. |
| 2026-09-05 | [`CHANGES_APPLIED_PRIORITY_THRESHOLD_DEADLOCK_20260905.md`](docs/changelog/CHANGES_APPLIED_PRIORITY_THRESHOLD_DEADLOCK_20260905.md) | Критичный баг: `priorityThreshold` блокировал создание ЛЮБОГО сигнала навсегда (тупик с зажатым в [0.35,0.65] `sigmoidFallback` и дефолтным порогом 0.75) — гейт теперь применяется только к откалиброванной модели, не к fallback-оценке. |
| 2026-09-12 | [`CHANGES_APPLIED_HTF_RESAMPLE_ALIGNMENT_20260912.md`](docs/changelog/CHANGES_APPLIED_HTF_RESAMPLE_ALIGNMENT_20260912.md) | По итогам `docs/audit/recommendations-post-harmonic-audit.md`: HTF-ресэмплинг `order-block-nested.ts`/`fvg-nested.ts` привязан к абсолютному времени (та же экспозиция, что и у ZigZag/гармоник, подтверждена эмпирически и исправлена централизованно через `resampleCandles(..., { alignToAbsoluteTime })`); 5 новых асимметричных AB/BC-тестов с численной проверкой PRZ на каждый тип гармонического паттерна; README дополнен оговоркой об ограничении метрик бэктеста. |
| 2026-09-12 | [`CHANGES_APPLIED_STRATEGY_AUDIT_OB_RECENCY_MEANREVERSION_20260912.md`](docs/changelog/CHANGES_APPLIED_STRATEGY_AUDIT_OB_RECENCY_MEANREVERSION_20260912.md) | Широкий аудит стратегий/паттернов/индикаторов: order-block-strength в `direction-prediction.ts` выбирал старейший, а не самый свежий подходящий OB (сортировка по recency вместо хронологического порядка); тумблер «Mean reversion» был фиктивным (`components.meanReversion` никогда не заполняется) и создавал тихий deadlock того же класса, что и уже исправленный `priorityThreshold` — исключён из `hasEnabledSource`; мёртвая ветка тернарного оператора в `order-block-continuation.ts` убрана. |

## См. также

- [`docs/AUDIT_BOLT_RECOMMENDATIONS.md`](docs/AUDIT_BOLT_RECOMMENDATIONS.md) — рекомендации по сборке/тестированию/деплою для bolt.new (сокращённая версия вынесена в `README.md`).
