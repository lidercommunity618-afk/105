# CHANGES_APPLIED_CALIBRATION_STAGE2_AUDIT_FIX_20260907.md

Дата: 2026-09-07.

Контекст: независимый аудит фиксов Этапа 2 плана калибровки (см.
`CHANGES_APPLIED_CALIBRATION_FACTOR_SELFLEARN_STAGE2_20260906.md`).
Обе заявленные проблемы (двойной подсчёт факторов в
`computeFactorStats()` для `STRATEGY_BONUS_PATTERNS` и глобальный
`PATTERN_RELIABILITY_MULTIPLIER` без per-symbol слоя) подтверждены
устранёнными построчной трассировкой кода и содержательными тестами.
Аудит нашёл одну новую (не pre-existing) регрессию, введённую самим
Этапом 2.

## Что исправлено

**`src/ui/CalibrationPanel.tsx`.** В пояснительном тексте под блоком
"КАЛИБРОВКА НАДЁЖНОСТИ ПАТТЕРНОВ" (добавлен в Этапе 2 вместе с самим
per-symbol слоем) было обращение `symbol?.label`, где `symbol =
findSymbol(symbolId)` имеет тип `Symbol` из `src/types/domain.ts` —
там есть `displaySymbol`/`displayName`, но не `label`. Это единственное
вхождение `symbol?.label` в файле (соседние `b.label`/`s.label` —
законные обращения к другим типам, `CalibrationBucket` и
`ReliabilitySuggestion`, у которых поле `label` реально есть).

Заменено на `symbol?.displayName ?? symbolId` — тот же паттерн
фолбэка, что уже использовался, просто на существующее поле типа.

```diff
- применяется только к {symbol?.label ?? symbolId} — другие
+ применяется только к {symbol?.displayName ?? symbolId} — другие
```

Это устраняет ошибку компиляции `Property 'label' does not exist on
type 'Symbol'`, которую `npx tsc --noEmit -p tsconfig.app.json` должен
был показать после Этапа 2. Логика (какому символу принадлежит
калибровка) не менялась — только имя поля, из которого берётся
отображаемое имя инструмента.

## Проверка

- Изменение точечное (одна строка), не затрагивает типы, тесты или
  поведение per-symbol калибровки — все тесты Этапа 2
  (`pattern-categories.test.ts`, `direction-prediction.test.ts`,
  `factor-analytics.test.ts`) не читают и не проверяют этот JSX-текст.
- `npx tsc --noEmit -p tsconfig.app.json` в среде аудита физически не
  прогонялся (нет сетевого доступа к npm registry для установки
  зависимостей) — исправление сделано по статическому анализу типа
  `Symbol` (`src/types/domain.ts`), но не подтверждено прогоном
  компилятора. Рекомендуется прогнать `tsc`/`eslint`/`vitest` локально
  перед мержем, чтобы закрыть это разрывом инструментов, а не
  предположением.
