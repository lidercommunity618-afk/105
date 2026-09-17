# CHANGES_APPLIED_FVG_AUDIT_FIX.md — проверка качества реализации FVG-фикса

Дата: 2026-08-25.

## Контекст

В архиве `59-main-fvg-fixed.zip` уже была применена доработка из промта
«исправление алгоритма разметки FVG» (см. документы аудита и промта,
переданные вместе с задачей). Задача этого прохода — проверить
качество этой реализации по всем пунктам промта и исправить то, что
осталось сломанным.

## Проверено и подтверждено рабочим (без изменений)

1. **`src/compute/indicators/fvg-core.ts`** — единая функция
   `detectFvgGeometry()` (direction-check средней свечи + ATR×1.2
   displacement-гейт + `hasDisplacement: false` вместо жёсткого
   исключения при недоступном ATR) действительно используется во всех
   трёх местах: `smart-money.ts`, `detectFVG()` и `detectImbalances()`
   в `order-block-strength.ts`. Три независимые копии геометрии гэпа
   устранены, как и требовалось.
2. **CE (Consequent Encroachment)** — поле `ce`/`(top+bottom)/2`
   считается в `fvg-core.ts` и присутствует в `SmartMoneyFVG` и
   `ImbalanceZone`.
3. **Inversion FVG** — `smart-money.ts` создаёt отдельную запись в
   `inversionFvgs` (не просто флаг) с развёрнутой полярностью, теми
   же границами и `time = endTime` исходной зоны; исходная зона
   остаётся в `fvgs` с `broken: true`. Проверка инверсии — по
   закрытию свечи (`close`), а не по тени, как и требовала методичка.
4. **Унификация touched/invalidated** — `ImbalanceZone.filled`
   переименован в `touched` (CE-касание тенью) + добавлен
   `invalidated` (полное закрытие через дальнюю границу зоны,
   идентично `broken` в `smart-money.ts`). Все три потребителя —
   `direction-prediction.ts`, `signal-filters.ts`,
   `order-block-continuation.ts` — переключены на `!invalidated`.
   Мёртвый код с `filter(f => !f.filled)` переименован под новое поле
   с пояснением, а не просто удалён (defence-in-depth, как и
   допускал промт).
5. **OB/BOS-конфлюэнс** — `hasOBConfluence`/`hasBOSConfluence`
   считаются в отдельном проходе `computeConfluence()` после того, как
   `orderBlocks` и `bosEvents` уже полностью заполнены, включая
   перенос флагов на парную `inversionFvgs`-запись. Поля
   информационные, никого не гейтят — соответствует ТЗ (по аналогии с
   `super-order-block.ts`).
6. Юнит-тесты (`smart-money.test.ts`,
   `indicators.test.ts::detectImbalances (touched vs invalidated)`)
   покрывают все 4 обязательных кейса из промта (позитивный,
   негативный по слабому displacement, инверсия, touched-но-не-
   invalidated).

## Найденный и исправленный баг

### `src/ui/BoxOverlayPrimitive.ts` — CE-линия и IFVG-пунктир не рендерились

`ChartPanel.tsx` корректно проставлял `midLine: true` для FVG-зон и
`borderDashed: true` + `midLine: true` для `inversionFvgs`
(п. 1–2 «Файл 3» промта), и `BoxPaneRenderer.draw()` уже умел рисовать
оба эффекта (пунктирная граница через `ctx.setLineDash`, пунктирная
горизонтальная средняя линия). Но между ними, в
`BoxOverlayPrimitive.updateAllViews()`, при конвертации
`ChartBoxData → PixelBox` эти два поля **не копировались**:

```ts
// было
pixelBoxes.push({ x1, x2, y1, y2, fill: b.fillColor, border: b.borderColor, label: b.label });
```

В результате `PixelBox.borderDashed`/`PixelBox.midLine` всегда были
`undefined`, и рендерер никогда не заходил в свои же `if (b.borderDashed)`
/ `if (b.midLine)` ветки — CE-мидлайн и пунктирная граница IFVG были
полностью невидимы на графике, несмотря на то что вся логика выше
(детекция, вычисление `ce`, создание `inversionFvgs`, передача пропсов
из `ChartPanel.tsx`) была реализована верно. Баг чисто в последнем
звене конвейера рендеринга.

**Исправление** — прокинуть оба поля в `PixelBox`:

```ts
pixelBoxes.push({
  x1, x2, y1, y2,
  fill: b.fillColor,
  border: b.borderColor,
  label: b.label,
  borderDashed: b.borderDashed,
  midLine: b.midLine,
});
```

Никакие сигнатуры не менялись, `PixelBox` уже содержал оба
необязательных поля — правка точечная, одна строка логики.

## Итог

Вся бизнес-логика (Файлы 1–2 промта) была реализована качественно и
без методологических ошибок. Единственный найденный баг — чисто
UI-слой (Файл 3), не влияющий на скоринг сигналов, но делавший
CE-линию и Inversion FVG невидимыми на графике. Исправлен.
