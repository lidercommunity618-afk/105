# CHANGES_APPLIED.md — «Доделка» применена к проекту 51-main

Дата: 2026-08-23.
Все три задачи из промта применены точечно, аддитивно. Существующая
логика принятия решений (`src/decision/direction-prediction.ts`,
`src/decision/signal-filters.ts`, `src/decision/signal-builder.ts`) —
**не изменена ни на строку**.

> Примечание: в проекте уже был файл `CHANGES_APPLIED.md` от
> предыдущей доработки — он переименован в
> `CHANGES_APPLIED_PREVIOUS.md`, чтобы не потерять историю. Этот файл
> описывает только изменения из промта «Доделка».

---

## Задача 1 — Синхронизация темы терминала (Tailwind ↔ график)

### Файлы
- `tailwind.config.js` — изменён
- `src/lib/chart-theme.ts` — **новый**
- `src/ui/ChartPanel.tsx` — изменён (только опции `createChart`/`addSeries`)

### Что сделано
1. Пересчитал палитру `colors.base` (600–950), `colors.success` и
   `colors.error` в `tailwind.config.js` под указанные анкоры:
   - `base.950 → #0e1621`, `base.900 → #161f2c`, `base.800 → #212c3d`.
   - `base.700 / base.600` — пересчитаны через HSL: сохранил тон (hue
     ≈216°, «сдержанный тёмно-графитово-синий», без ухода в синий/
     фиолетовый) и повторил исходные шаги lightness/saturation между
     600↔700↔800, применённые к новым 800/900/950. Результат:
     `base.700 = #36455c`, `base.600 = #445773`.
   - `success.500 → #2ebd85`; 400/600/700 пересчитаны в HSL тем же
     способом — взял исходные смещения lightness/saturation каждой
     ступени относительно старого 500 и применил их к новому 500.
     Результат: `400 = #69c09e`, `600 = #1ca16d`, `700 = #17875b`.
   - `error.500 → #e5484d`; аналогично: `400 = #f17276`,
     `600 = #ce2e34`, `700 = #aa2529`.
   - `base.50–500`, `primary`, `secondary`, `accent`, `warning` — не
     тронуты.
   - **Важная оговорка**: конкретные HEX — это приближение к
     фирменному стилю Pocket Option на основе описания в задании, а
     не эталон, снятый с их живого терминала (доступа к нему не было).
     При наличии официальной палитры её можно подставить точечно в
     эти же переменные.

2. Создал `src/lib/chart-theme.ts` — 5 констант
   (`CHART_BG`, `CHART_GRID_LINE`, `CHART_SCALE_BORDER`,
   `CHART_UP_COLOR`, `CHART_DOWN_COLOR`), продублированных из
   `tailwind.config.js` с комментарием «должно совпадать с
   tailwind.config.js → base.950/700/800, success.500, error.500».
   Прямого импорта `tailwind.config.js` в рантайм нет и не нужен —
   Tailwind конфиг используется только сборщиком CSS.

3. В `ChartPanel.tsx` заменил хардкод на эти константы:
   - `layout.background.color` (`'#0a0e17'`) → `CHART_BG`.
   - `grid.vertLines.color` / `grid.horzLines.color`
     (`'rgba(62, 72, 93, 0.25)'`) → `CHART_GRID_LINE`
     (`rgba(54, 69, 92, 0.25)` — та же альфа 0.25, RGB нового `base.700`).
   - `rightPriceScale.borderColor` / `timeScale.borderColor`
     (`'#272f40'`) → `CHART_SCALE_BORDER`.
   - `candleSeries`: `upColor`/`wickUpColor` (`'#10b981'`) →
     `CHART_UP_COLOR`; `downColor`/`wickDownColor` (`'#ef4444'`) →
     `CHART_DOWN_COLOR`. `borderVisible: false` не менял.
   - EMA/Bollinger/MACD-гистограмма, `volumeSeries.color`, crosshair —
     **не тронуты**, как и требовалось.

4. Проверил `SettingsPanel.tsx, StrategiesModal.tsx,
   DemoAccountBadge.tsx, Header.tsx, MobileNav.tsx, Onboarding.tsx,
   Education.tsx, SignalCard.tsx, PriorityAlertBanner.tsx` на предмет
   хардкод-HEX/RGB — **не найдено ни одного** (grep по всем `*.tsx` в
   `src/ui/` подтверждает, что после правки хардкод остался только в
   `ChartPanel.tsx`, в двух местах, явно исключённых из задания: MACD-
   гистограмма (`v >= 0 ? '#22c55e' : '#ef4444'`) и ценовые линии BOS
   (`'#22c55e88' : '#ef444488'`)).

### Как проверено
`npm run build` прошёл без ошибок, значения в `chart-theme.ts` и
`tailwind.config.js` сверены построчно. Визуальный рендер в браузере
**скриншотом не проверял** — в этом окружении нет сетевого доступа для
установки Chromium/Playwright (`npx playwright install` вернул 403 при
обращении к внешним источникам). Числа палитры и их применение в коде
проверены сопоставлением значений вручную.

---

## Задача 2 — Явный список «Паттерн vs Стратегия»

### Файлы
- `src/lib/pattern-categories.ts` — **новый**
- `src/lib/pattern-categories.test.ts` — **новый**
- `src/ui/SignalCard.tsx` — изменена 1 строка (рендер имени паттерна)
- `src/ui/PriorityAlertBanner.tsx` — добавлена категория и акцентная
  раскраска (детали в Задаче 3, т.к. правки в одном файле)

### Что сделано
1. `STRATEGY_PATTERNS` — ровно те 8 значений из ТЗ (`impulse-breakout`,
   `consolidation-breakout`, `liquidity-sweep`,
   `liquidity-sweep-reaction`, `mean-reversion`,
   `strong-order-block-reaction`, `order-block-continuation`,
   `macd-deceleration-continuation`). `patternCategory()` — через
   `includes()`, как в ТЗ.
2. `PATTERN_LABELS_RU: Record<PatternName, string>` — все 34 значения
   `PatternName` из `src/types/domain.ts` покрыты (typecheck это
   подтверждает — при пропуске ключа сборка становится красной).
   Названия стратегий на русском взял из самого ТЗ; названия
   классических паттернов — стандартные термины технического анализа.
3. `SignalCard.tsx`: `signal.pattern.replace(/-/g, ' ')` заменён на
   `PATTERN_LABELS_RU[signal.pattern] ?? signal.pattern.replace(/-/g, ' ')`
   — с фолбэком на случай появления нового `PatternName`, для которого
   словарь ещё не обновлён (хотя typecheck не даст это сделать
   незамеченным).
4. `PriorityAlertBanner.tsx`:
   - `const category = signal.pattern ? patternCategory(signal.pattern) : null;`
   - Если `category === 'strategy'` — рамка карточки, разделитель
     шапки, иконка/текст «Сигнал» и полоса прогресса переключаются с
     `secondary-*` на `accent-*` (`border-accent-600`,
     `border-accent-800/50`, `text-accent-400`, `bg-accent-500`).
     Если `'pattern'` или `signal.pattern === null` — расцветка
     `secondary-*` остаётся как раньше (дефолт), структура баннера не
     менялась.
   - Под заголовком «Сигнал» добавлена строка `text-3xs text-base-500`
     вида `Стратегия · Продолжение от ордер-блока` (или `Паттерн ·
     …`) — только если `signal.pattern` задан; если `null`, строка не
     рендерится вовсе. Размеры баннера не изменились (строка
     добавлена внутри существующего блока шапки, без увеличения
     `width`/`bottom`).

### Юнит-тест
`pattern-categories.test.ts` — 5 тестов: категоризация всех
`STRATEGY_PATTERNS` как `'strategy'`, классических паттернов как
`'pattern'`, согласованность с `ALL_PATTERNS` из `settingsStore.ts`,
и полнота/непустота `PATTERN_LABELS_RU` для всех `ALL_PATTERNS` и
`STRATEGY_PATTERNS`.

---

## Задача 3 — Русский текст аргументов вместо «Вход/Стоп/Цель» в баннере

### Файлы
- `src/lib/reason-translations.ts` — **новый**
- `src/lib/reason-translations.test.ts` — **новый**
- `src/ui/PriorityAlertBanner.tsx` — изменена только сетка
  Вход/Стоп/Цель; шапка/«ПОКУПКА-ПРОДАЖА»/таймер/прогресс-бар по
  структуре не тронуты (прогресс-бар сменил только цвет по категории —
  см. Задачу 2, это прямо предусмотрено пунктом 5 Задачи 3 ТЗ).

### Что сделано
1. `translateReason(reason: string): string[]` — разбивает `reason`
   по `'; '`, каждый фрагмент прогоняет через массив правил
   `REASON_TRANSLATION_RULES` (регэксп → функция перевода), в точности
   по списку из ТЗ: `BOS bullish/bearish`, `CHoCH bullish/bearish`,
   `RSI oversold/overbought (N)`, `EMA fast above/below slow`,
   `MACD histogram positive/negative`, `Price at lower/upper Bollinger
   band`, `(Untouched|Tested) (bullish|bearish) OB...` (с сохранением
   числа касаний из скобок, если оно есть), `...FVG nearby`,
   `...liquidity pool nearby`, `OBC strategy...`, `MDM strategy...`,
   `<name> pattern (N%)<fusion?>` — с переводом имени паттерна через
   `PATTERN_LABELS_RU` и опциональной припиской `+ ещё N
   подтверждающих паттерна`, если в исходной строке был суффикс
   `+ N confirming pattern(s)`.
   Фрагмент, не подошедший ни под одно правило, возвращается **как
   есть** — информация не теряется.
2. Реальные форматы строк из `direction-prediction.ts` /
   `signal-builder.ts` были прочитаны (не изменены) для проверки, что
   регэкспы действительно ловят то, что реально генерируется в рантайме
   (например, `Tested bullish OB holding (3 touches)`,
   `order-block-continuation pattern (72%)`,
   `hammer pattern (65%) + 2 confirming patterns`,
   `OBC strategy (+0.30)`).
3. `PriorityAlertBanner.tsx`: сетка `grid-cols-3` с `LevelCell`
   (Вход/Стоп/Цель, `formatPrice`) удалена. Вместо неё — список из
   максимум 3 строк `translateReason(signal.reason).slice(0, 3)`,
   каждая строка — `text-3xs text-base-200` с иконкой `CheckCircle2`
   (9px), цвет иконки `text-secondary-400` по умолчанию или
   `text-accent-400`, если `category === 'strategy'` (см. Задачу 2).
   Если после перевода список пуст (пустой `reason`) — показывается
   нейтральный текст «Комплексное подтверждение по нескольким
   факторам».
4. Цены входа/стопа/тейка из этого баннера полностью убраны — они
   по-прежнему доступны в `SignalCard.tsx` (боковая панель сигналов),
   не дублируются здесь.
5. Логика таймера/автозакрытия (30 секунд) и полоса прогресса внизу —
   не изменены по поведению; полоса прогресса теперь физически
   находится ниже нового блока причин (было ниже сетки
   Вход/Стоп/Цель), просто заняла её место в разметке.
6. `pipSize` в `PriorityAlertBannerProps` оставлен в интерфейсе (чтобы
   не трогать сигнатуру вызовов в `App.tsx` — два места вызова
   передают этот пропс), но больше не деструктурируется в теле
   компонента, так как значения цены здесь больше не выводятся; это не
   создаёт unused-var предупреждений (`npm run lint` подтверждает).

### Юнит-тест
`reason-translations.test.ts` — 11 тестов: BOS, CHoCH, RSI (oversold/
overbought с сохранением числа), OB untouched без счётчика, OB tested
с сохранением числа касаний, перевод паттерна с русским именем,
перевод паттерна с fusion-суффиксом, OBC/MDM strategy, составная
строка из 3 фрагментов (максимально приближенная к реальному выводу
`direction-prediction.ts`), фрагмент без совпадения (проходит как
есть), пустой `reason` → `[]`.

---

## Финальная проверка

Все команды реально выполнены в этом окружении (сетевой доступ есть
только к npm-реестру; внешние хосты вроде Playwright CDN недоступны).

| Команда | Результат |
|---|---|
| `npm install` | ✅ успешно (655 пакетов) |
| `npm run typecheck` | ✅ 0 ошибок |
| `npm run lint` | ✅ 0 warning/error |
| `npm run test` | ✅ 374/374 тестов, 26/26 файлов, включая неизменённые ожидания в `direction-prediction.test.ts` (20), `signal-filters.test.ts` (8), `signal-builder.test.ts` (13), плюс новые `reason-translations.test.ts` (11) и `pattern-categories.test.ts` (5) |
| `npm run build` | ✅ успешно, `dist/` собран (единственное предупреждение — про размер основного чанка >500kB, существовало до правок, не связано с этими изменениями) |

Визуальную сверку темы через рендер в браузере/скриншот выполнить не
удалось — в этом окружении нет сетевого доступа для установки
Chromium (`npx playwright install` вернул 403 при обращении к внешним
источникам). Корректность применения палитры проверена построчным
сопоставлением HEX-значений между `tailwind.config.js` и
`src/lib/chart-theme.ts`, а также успешным прохождением сборки
CSS/JS в `npm run build`.

## Список новых/изменённых файлов

**Новые:**
- `src/lib/chart-theme.ts`
- `src/lib/pattern-categories.ts`
- `src/lib/pattern-categories.test.ts`
- `src/lib/reason-translations.ts`
- `src/lib/reason-translations.test.ts`
- `CHANGES_APPLIED.md` (этот файл)

**Переименован:**
- `CHANGES_APPLIED.md` → `CHANGES_APPLIED_PREVIOUS.md` (отчёт о
  предыдущей, не связанной с этим промтом доработке — сохранён, не
  удалён)

**Изменённые:**
- `tailwind.config.js`
- `src/ui/ChartPanel.tsx`
- `src/ui/SignalCard.tsx`
- `src/ui/PriorityAlertBanner.tsx`

**Не тронуты (по прямому запрету ТЗ):**
- `src/decision/direction-prediction.ts`
- `src/decision/signal-filters.ts`
- `src/decision/signal-builder.ts`
