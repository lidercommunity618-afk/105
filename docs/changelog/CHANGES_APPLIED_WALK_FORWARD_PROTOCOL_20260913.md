# Проверка правок #1-2 + фикс "переобучение через сам аудит" (п.5) — 2026-09-13

## Часть 1 — проверка project-bolt-audit-wilson-fix-2026-09-13

Прогнал `npm ci` (чистая установка по lockfile — предыдущая сессия отметила,
что `npm test` не запускался из-за отсутствия node_modules/сети), затем:

- `tsc --noEmit -p tsconfig.app.json` — **0 ошибок**.
- `npx vitest run` (весь проект, 63 файла) — **850/850 тестов**, регрессий
  нет.
- `eslint .` — чисто.

Построчно сверил обе правки с их changelog-описаниями:

- **Спред-паритет баланса** (`useDemoAccountStore.ts::resolveTrade`):
  `isWithinSpread` корректно демоутит только пограничный WIN в тай (тот же
  код-путь, что уже существовавший `isTie`), убыток спредом не смягчается,
  `spread: null` не меняет старое поведение. `checkExpiries` и
  `resolveFromHistory` действительно используют одну и ту же функцию —
  расхождения логики нет. Комментарий в `apply-spread.ts` обновлён
  корректно (раньше буквально противоречил новому поведению).
- **Wilson lower bound / MIN_FACTOR_SAMPLES**: формула Уилсона сверена
  вручную (`wilsonLowerBound(1,1)` ≈ 0.2065 — совпадает с заявленным
  тестом). `MIN_FACTOR_SAMPLES` поднят 5→20 переиспользованием уже
  существующей константы `MIN_THRESHOLD_BACKTEST_SAMPLES`, а не новой
  волевой цифрой — корректный, обоснованный выбор. Сырой `winRate`
  по-прежнему возвращается наружу для UI, решение принимается по
  консервативной Wilson-границе — разделение ответственности не нарушено.

Замечаний по логике не найдено — обе правки внесены качественно и без
новых дефектов.

## Часть 2 — фикс "проверка на переобучение через сам аудит" (п.5)

### Проблема

`backtest/simulator.ts` уже поддерживал `inSampleRatio` (разбиение одного
статического файла свечей на in-sample/out-of-sample), но это не защищает
от главного риска: `npm run backtest` можно перезапускать произвольное
число раз с разными параметрами против одного и того же исторического
файла, неявно подгоняя решение под OOS-часть тоже (researcher degrees of
freedom). Реальная защита — оценивать правки на данных, время входа
которых физически позже момента заморозки этих же правок.

### Решение

Новый модуль `backtest/change-registry.ts`:
- `LOGIC_CHANGE_LOG` — реестр трёх уже применённых сегодня правок
  (breakeven-payout-aware, spread-balance-parity, wilson-min-samples) с
  `frozenAtMs`.
- `currentFreezeMs()` / `isForwardTestTrade()` — момент заморозки
  действующего набора правил и проверка "сделка вошла после этого
  момента".
- `computeForwardTestReport(trades, freezeAtMs, profitPercent)` — метрики
  и вердикт (`insufficient-data` / `below-breakeven` /
  `above-breakeven-not-significant` / `significantly-above-breakeven`),
  переиспользуя `MIN_THRESHOLD_BACKTEST_SAMPLES`, `wilsonLowerBound`,
  `breakevenWinRateFromProfitPercent` — те же функции, что уже
  используются калибровкой, вместо параллельной копии той же экономики.

`backtest/index.ts` — новые CLI-флаги `--freeze-at` (по умолчанию
`currentFreezeMs(LOGIC_CHANGE_LOG)`) и `--profit-percent` (по умолчанию
80); `backtest/report.ts` — секция FORWARD-TEST в консоли, markdown и JSON
отчётах, с явным предупреждением, что ретроспективный бэктест не
подтверждает прибыльность вперёд, пока форвард-сделок недостаточно.
`backtest/harmonic-audit.ts` обновлён под новую сигнатуру
`generateReport()` (добавлен обязательный параметр `forwardTest`).

Полное описание протокола и правила ведения реестра — в новом
`docs/audit/WALK_FORWARD_PROTOCOL.md`, включая честно задокументированное
ограничение: R-модель бэктеста (`WIN_R=2`/`LOSS_R=-1`) не совпадает с
реальной экономикой демо-счёта (фиксированный `profitPercent`) — фикс
форвард-теста работает через `winRate`, а не через R-модель, именно
поэтому; полное согласование R-модели с реальной экономикой вынесено за
рамки этой правки как отдельная, более широкая задача.

Диапазоны весов/порогов/множителей не менялись — это новый процессный
инструмент поверх уже существующей логики.

### Тесты

Новый `backtest/change-registry.test.ts` (12 тестов): валидность записей
реестра, `currentFreezeMs` (максимум/пустой лог/дефолт), `isForwardTestTrade`
на границе, и все четыре вердикта `computeForwardTestReport` — включая
явный тест "60% сырого винрейта на n=20 даёт `above-breakeven-not-significant`,
а не `significantly-above-breakeven`" (Wilson-граница ≈38.7% при n=20/60% —
посчитано вручную и сверено).

### Проверка

- `tsc --noEmit -p tsconfig.app.json` и `tsc --noEmit -p backtest/tsconfig.json`
  — 0 ошибок.
- `eslint .` — чисто.
- `npx vitest run` (весь проект, 64 файла) — **862/862 теста** (было 850,
  +12 новых), регрессий нет.
- CLI (`npm run backtest`) не прогонялся end-to-end с реальными данными в
  этой сессии — `backtest/data-loader.ts` требует сеть к Binance/Deriv API,
  недоступную в текущей песочнице. Вся логика (`simulate`, `metrics`,
  `change-registry`) покрыта юнит-тестами на синтетических данных, которые
  и были прогнаны.
