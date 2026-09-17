import type { Candle, PatternResult, SignalStrength, IndicatorSnapshot } from '@/types/domain';
import { computeStructure } from '@/compute/indicators/trend-structure';
import { macd } from '@/compute/indicators/macd';
import type { SessionRegime } from '@/compute/session-regime';
import { isHighLiquiditySession } from '@/compute/session-regime';
import type { SmartMoneyResult } from '@/compute/indicators/smart-money';

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function strengthForConfidence(confidence: number): SignalStrength {
  if (confidence >= 0.75) return 'strong';
  if (confidence >= 0.5) return 'moderate';
  return 'weak';
}

const MIN_SERIES_LENGTH = 4;
const LOOKBACK_BARS = 15;

// Аудит «Замедление MACD с продолжением» (2026-08-31), п.2 / промт-фикс п.2:
// без явного порога нижняя граница confidence была ~0.34 (0.4 базовый минимум
// × 0.85 correctionMultiplier) — неотличимо от случайного сигнала, и такой
// сигнал проходил в фид/бэктест наравне с "сильными". 0.55 — нижняя граница
// рекомендованного диапазона 0.55-0.6: эта стратегия уже опирается на
// несколько независимых жёстких гейтов (RSI, ADX, Фибо 78.6%, монотонность
// гистограммы, тело паузы), поэтому итоговая избирательность должна быть
// сопоставима с impulse-breakout (порог 0.6, но меньше структурных гейтов),
// а не ниже. Финальное значение — кандидат для уточнения бэктестом.
const ENTRY_THRESHOLD = 0.55;

// Промт-фикс п.4: ADX как обязательное подтверждение силы тренда для
// continuation-сетапа. НЕ путать с ADX_HARD_BLOCK=25 в mean-reversion.ts —
// там логика обратная (блокирует вход при СИЛЬНОМ тренде, т.к. реверсия
// работает только во флэте). Здесь порог мягче (20 < 25) осознанно: цель —
// отсечь безтрендовый шум на коротком 15-барном структурном окне
// (computeStructure), а не отобрать только самые сильные тренды.
const ADX_TREND_CONFIRM = 20;

// Промт-фикс п.5: относительный шаг затухания вместо строгой поэлементной
// проверки (<=), чтобы не засчитывать шумовые колебания гистограммы —
// типичные на M1, где значения гистограммы часто крошечные — как настоящее
// ослабление импульса. Каждый следующий бар старой серии должен быть не
// больше 90% предыдущего. Начальное консервативное значение, требует
// уточнения бэктестом (см. backtest/) перед боевым использованием.
const DECAY_STEP_RATIO = 0.9;

// MACD Deceleration in Medium Trend: after a sustained same-color histogram
// run (the correction against the trend) that monotonically decays, a
// "pause" candle (small body) appears, then the histogram flips to the
// trend-aligned color — but the first bar of the new (trend) color is
// smaller in magnitude than the last bar of the old (correction) color.
// Signal direction follows the prevailing trend (continuation, not
// reversal): the flip must resolve IN the trend direction, not against it.
//
// Аудит/промт-фикс, применённые здесь (Аудит + Промт «Замедление MACD с
// продолжением», 2026-08-31):
//  1. (Критично) needRsi в IndicatorAggregator.ts теперь включает эту
//     стратегию — RSI-хард-инвалидатор ниже больше не отключается тихо от
//     несвязанных галочек в UI.
//  2. (Высоко) ENTRY_THRESHOLD — сигналы с confidence ниже отсекаются.
//  3. (Средне) pauseIdx больше не совпадает численно с flipIdx — пауза
//     теперь бар, предшествующий последнему бару старой серии (см. ниже).
//  4. (Средне) ADX-подтверждение силы тренда; needAdx в
//     IndicatorAggregator.ts обновлён по тому же принципу, что и needRsi.
//  5. (Низко) Нормализация проверки затухания через DECAY_STEP_RATIO.
//  6. (Низко) Параметры MACD теперь настраиваемые через необязательный
//     4-й аргумент (дефолт 12/26/9 сохраняет обратную совместимость).
// Дополнительно (сверх аудита, по итогам сверки с «Торговая система
// «Замедление MACD с продолжением»» и с самим докстрингом этого файла):
//  7. Явная проверка, что флип-бар совпадает по знаку с направлением
//     тренда (иначе это не continuation-сигнал).
//  8. Проверка глубины коррекции (78.6% Фибо) теперь по каждому бару
//     коррекционной серии, а не только по последней свече (Торговая
//     система, §7).
//  9. (Доп., 2026-08-31, по запросу) Хард-гейт |lastValue| < |flipValue| —
//     буквально по докстрингу выше. Добавлен ВМЕСТЕ с перекалибровкой
//     формулы confidence (см. комментарий на месте ниже) — по отдельности
//     это математически ломало ENTRY_THRESHOLD (см. история решения там же).
//  10. (Доп., 2026-08-31, по запросу) Фильтр новостного выброса: флип-бар
//     шире 2×ATR (Торговая система, §7). needAtr в IndicatorAggregator.ts
//     обновлён по тому же принципу, что и needRsi/needAdx.
export function detectMacdDecelerationContinuation(
  candles: Candle[],
  snapshot?: IndicatorSnapshot,
  session?: SessionRegime,
  macdConfig?: { fast: number; slow: number; signal: number },
  smartMoney?: SmartMoneyResult,
): PatternResult | null {
  if (candles.length < 35) return null;

  const closes = candles.map((c) => c.close);
  // Промт-фикс п.6: дефолт остаётся классическим 12/26/9 для обратной
  // совместимости с существующими вызовами без 4-го аргумента (в т.ч. в
  // тестах). Реальный config.macdFast/macdSlow/macdSignal из настроек
  // пользователя прокинут сюда из full-snapshot.ts через
  // detectAllPatterns(...) в patterns/index.ts (перенесено из параллельной
  // сессии правок, где это было сделано изначально, — см. сравнительный
  // аудит A vs B, раздел 1.1), так что настройки MACD из UI теперь реально
  // влияют на эту стратегию, а не только на индикаторы, отображаемые в
  // IndicatorAggregator.
  const { fast, slow, signal: signalPeriod } = macdConfig ?? { fast: 12, slow: 26, signal: 9 };
  const { histogram } = macd(closes, fast, slow, signalPeriod);

  const struct = computeStructure(candles, LOOKBACK_BARS);
  if (struct.trend === 'range') return null;

  const direction: 'buy' | 'sell' = struct.trend === 'up' ? 'buy' : 'sell';

  const windowStart = Math.max(0, histogram.length - 15);
  const histWindow: (number | null)[] = histogram.slice(windowStart);

  const valid = histWindow.filter((h): h is number => h !== null);
  if (valid.length < MIN_SERIES_LENGTH + 2) return null;

  const lastIdx = histWindow.length - 1;
  const flipIdx = lastIdx - 1;
  if (flipIdx < MIN_SERIES_LENGTH) return null;

  const flipValue = histWindow[flipIdx];
  const lastValue = histWindow[lastIdx];
  if (flipValue === null || lastValue === null) return null;

  const flipSign = Math.sign(flipValue);
  const lastSign = Math.sign(lastValue);
  if (flipSign === 0 || lastSign === 0) return null;
  if (flipSign === lastSign) return null;

  // Доп. фикс п.7 (не из аудита, но напрямую следует из методологии
  // «Торговая система», §1/§6: сетап — continuation, а не разворотный).
  // Раньше направление сделки бралось только из computeStructure, а
  // совпадение знака флип-бара с направлением тренда нигде не проверялось —
  // теоретически сигнал buy мог сработать на флипе гистограммы В МИНУС.
  if (direction === 'buy' && lastSign <= 0) return null;
  if (direction === 'sell' && lastSign >= 0) return null;

  // Last bar(s) of the old (pre-flip) color series — walk backward while the
  // sign still matches flipSign (the decaying same-color run), stopping the
  // moment the sign changes. NOTE: this condition was previously inverted
  // (`=== flipSign` as the break condition instead of `!== flipSign`), which
  // made oldSeries empty in every realistic decaying-then-flip scenario and
  // silently disabled the entire pattern's primary detection path — fixed
  // here as part of the Phase 3 audit (bolt-prompt-8-strategies-replacement.md).
  const oldSeries: number[] = [];
  for (let i = flipIdx - 1; i >= 0; i--) {
    const h = histWindow[i];
    if (h === null) break;
    if (Math.sign(h) !== flipSign) break;
    oldSeries.unshift(h);
  }
  if (oldSeries.length < MIN_SERIES_LENGTH) return null;

  // Monotonically decaying magnitude, normalized to a relative step instead
  // of a strict <= (промт-фикс п.5). On M1 the histogram is often tiny and
  // noisy, so a strict "each bar no bigger than the previous" check let
  // sequences like 0.00031 -> 0.00030 -> 0.00030 -> 0.00029 pass as
  // "confident decay" when it could just be flat noise.
  for (let i = 1; i < oldSeries.length; i++) {
    if (Math.abs(oldSeries[i]) > Math.abs(oldSeries[i - 1]) * DECAY_STEP_RATIO) return null;
  }

  // flipValue continues the old series' decay one more bar (its own
  // magnitude must still be <= the old series' last element).
  if (Math.abs(flipValue) >= Math.abs(oldSeries[oldSeries.length - 1])) return null;

  // Хард-гейт |lastValue| < |flipValue|, буквально по докстрингу этого
  // файла ("the first bar of the new color is smaller in magnitude than
  // the last bar of the old color"). Ранее сознательно не добавлялся —
  // арифметика показывала, что в связке со СТАРОЙ формулой confidence
  // (0.4 + до 0.15 от отношения |lastValue|/|oldSeries[0]|) это математически
  // ограничивало итоговую confidence сверху величиной ~0.51, ЖЁСТКО ниже
  // ENTRY_THRESHOLD=0.55 без бонуса — что противоречило «Торговая система»,
  // §8 («Kill Zone/OB — бонус, а не обязательный гейт»).
  // По запросу это доработано: гейт добавлен, а формула confidence ниже
  // (см. блок "Пересчитанная формула confidence") перекалибрована вместе с
  // ним — как и было прямо запланировано в прежнем комментарии-развилке:
  // "если... подтвердится, что паттерн должен требовать confluence,
  // добавить этот гейт явно с соответствующей правкой... одновременно,
  // а не по отдельности". Формула больше не измеряет "силу флипа" (что
  // структурно конфликтовало с этим гейтом), а измеряет качество самой
  // setup — длину декей-серии и то, насколько ТИХИЙ флип-бар относительно
  // last-бара старой серии (что и есть определение паттерна).
  if (Math.abs(lastValue) >= Math.abs(flipValue)) return null;

  // "Pause" candle. Промт-фикс п.3: pauseIdx больше не совпадает численно с
  // абсолютным индексом flipIdx (как было раньше — candles.length - 2 для
  // обоих). Методологически пауза должна ПРЕДШЕСТВОВАТЬ флипу как отдельное
  // подтверждающее событие, а не быть тем же баром под другим именем.
  // Первоисточник методички (bolt-prompt-8-strategies-replacement.md)
  // недоступен, поэтому трактовка выбрана по явной инструкции промта-фикса:
  // pauseIdx = flipIdx - 1 (последний бар старой серии), с пересчётом в
  // АБСОЛЮТНЫЙ индекс свечи через windowStart — не через candles.length - N
  // напрямую, чтобы не путать координаты histWindow и candles (это и было
  // причиной исходного смещения).
  const pauseAbsIdx = windowStart + flipIdx - 1;
  if (pauseAbsIdx < 10) return null;
  const pauseCandle = candles[pauseAbsIdx];
  const pauseBody = Math.abs(pauseCandle.close - pauseCandle.open);
  let avgBody = 0;
  for (let i = pauseAbsIdx - 10; i < pauseAbsIdx; i++) {
    avgBody += Math.abs(candles[i].close - candles[i].open);
  }
  avgBody /= 10;
  if (pauseBody >= avgBody) return null;

  // RSI не пересёк 50 во время коррекции (TIER 2, п.11) — hard-инвалидатор,
  // а не мультипликатор. Промт-фикс п.1: snapshot.rsi теперь реально
  // вычисляется для этой стратегии (needRsi в IndicatorAggregator.ts
  // обновлён), так что эта проверка больше не отключается тихо от
  // несвязанных настроек UI.
  if (snapshot?.rsi != null) {
    if (direction === 'buy' && snapshot.rsi < 50) return null;
    if (direction === 'sell' && snapshot.rsi > 50) return null;
  }

  // ADX-подтверждение силы тренда (промт-фикс п.4). 15-барное структурное
  // окно (computeStructure) само по себе статистически шумное на форекс M1 —
  // 2-3 последовательных свинга могут быть микроструктурным шумом (спред,
  // проскальзывание, всплеск ликвидности), а не реальным направленным
  // движением. ADX создан Уайлдером именно для отличения направленного
  // движения от шума. needAdx в IndicatorAggregator.ts обновлён по тому же
  // принципу, что и needRsi — иначе этот новый фильтр воспроизвёл бы тот же
  // класс бага (тихое отключение конфигурацией UI).
  if (snapshot?.adx != null && snapshot.adx < ADX_TREND_CONFIRM) return null;

  const last = candles[candles.length - 1];

  // Фильтр новостного выброса (Торговая система, §7: «флип-бар шире 2×ATR —
  // похоже на новостной выброс, а не органическое продолжение»). Ранее
  // сознательно не реализован — требовал snapshot.atr, а needAtr в
  // IndicatorAggregator.ts не включал эту стратегию (тот же класс бага, что
  // и needRsi/needAdx до фикса). По запросу это доработано: needAtr теперь
  // тоже включает 'macd-deceleration-continuation', так что snapshot.atr
  // здесь реально вычисляется, а не тихо остаётся null.
  if (snapshot?.atr != null && snapshot.atr > 0) {
    const flipBody = Math.abs(last.close - last.open);
    if (flipBody > snapshot.atr * 2) return null;
  }

  let correctionMultiplier = 1;
  if (struct.swingHigh !== null && struct.swingLow !== null) {
    const swingRange = struct.swingHigh - struct.swingLow;
    if (swingRange > 0) {
      // Доп. фикс п.9 (Торговая система, §7: «глубина коррекции превысила
      // 78.6% Фибо на любом баре до входа, не только на баре сигнала»).
      // Раньше проверялась только последняя свеча — теперь проверяется
      // каждый бар коррекционной серии (от начала oldSeries до текущего
      // бара): если хотя бы один закрылся глубже 78.6%, это уже похоже на
      // разворот, а не паузу, даже если текущая свеча отскочила обратно.
      const correctionStartAbsIdx = windowStart + (flipIdx - oldSeries.length);
      for (let i = Math.max(0, correctionStartAbsIdx); i < candles.length; i++) {
        const c = candles[i];
        const r =
          direction === 'buy'
            ? (struct.swingHigh - c.close) / swingRange
            : (c.close - struct.swingLow) / swingRange;
        if (r > 0.786) return null;
      }
      const lastCandle = candles[candles.length - 1];
      const retracement =
        direction === 'buy'
          ? (struct.swingHigh - lastCandle.close) / swingRange
          : (lastCandle.close - struct.swingLow) / swingRange;
      if (retracement > 0.618) correctionMultiplier = 0.85;
    }
  }

  // Пересчитанная формула confidence (2026-08-31, по запросу — вместе с
  // добавлением хард-гейта |lastValue| < |flipValue| выше). СТАРАЯ формула
  // (0.4 + до 0.15 от |lastValue|/|oldSeries[0]|) измеряла "силу флипа" —
  // но теперь, когда |lastValue| гарантированно МЕНЬШЕ |flipValue|
  // (а тот, в свою очередь, ограничен сверху decay-серией), эта величина
  // структурно мала почти всегда, и формула упиралась в потолок ~0.51,
  // ниже ENTRY_THRESHOLD=0.55 без бонуса Kill Zone/OB — что противоречит
  // «Торговая система», §8 (бонусы опциональны, не обязательны).
  // Новая формула измеряет качество самого сетапа, а не силу флипа:
  //  - decayQuality: длина подтверждённой decay-серии (oldSeries) сверх
  //    минимума (MIN_SERIES_LENGTH=4) — чем дольше устойчиво затухает
  //    коррекция, тем увереннее сигнал; выходит на максимум при 10+ барах
  //    серии (капа в 6 доп. баров выбрана произвольно, как и оригинальный
  //    коэффициент 0.15 в старой формуле, — кандидат на уточнение
  //    бэктестом, как и остальные пороги в этом файле).
  //  - quietness: насколько lastValue МЕНЬШЕ flipValue в относительных
  //    величинах — это и есть буквальное определение паттерна из
  //    докстринга ("first bar of new color smaller than last bar of old
  //    color"), поэтому чем тише флип-бар относительно предшествующего
  //    старого бара, тем выше уверенность, а не наоборот.
  // Итоговый диапазон до бонусов: 0.4-0.64 (был 0.4-0.55) — сопоставимо
  // по порядку величины со старым диапазоном, сдвинуто вверх ровно настолько,
  // чтобы качественный сетап (длинная decay-серия + тихий флип) мог
  // достигать ENTRY_THRESHOLD=0.55 без обязательного бонуса, как и требует
  // «Торговая система», §8.
  const decayQuality = clamp01((oldSeries.length - MIN_SERIES_LENGTH) / 6);
  const quietness = clamp01(1 - Math.abs(lastValue) / (Math.abs(flipValue) + 1e-9));
  let confidence = 0.4 + decayQuality * 0.12 + quietness * 0.12;
  confidence = clamp01(confidence) * correctionMultiplier;

  // Bonus if there's an unbroken, structurally-confirmed OB/level in the
  // trend direction. `struct` is already computed above; reuse it here and
  // require structure confluence (per the OB unification fix) since this is
  // still just a soft +0.15 confidence bonus, not a hard gate — a sparser
  // set of qualifying blocks here only means the bonus applies less often.
  // Fix #1: Use smartMoney.orderBlocks instead of superOrderBlocks. The
  // old call used requireStructureConfluence: true which gates against the
  // current structure snapshot — smartMoney already has correct formation-
  // time structure confluence (hasStructureConfirmation). This is a soft
  // +0.15 confidence bonus, not a hard gate, so a sparser block list only
  // means the bonus applies less often.
  const blocks = smartMoney?.orderBlocks ?? [];
  const hasTrendBlock = blocks.some((b) =>
    b.status !== 'broken' &&
    b.type === (direction === 'buy' ? 'bullish' : 'bearish') &&
    Math.abs(last.close - (direction === 'buy' ? b.bottom : b.top)) <= (b.top - b.bottom) * 3,
  );
  if (hasTrendBlock) confidence = clamp01(confidence + 0.15);

  // Kill Zone bonus (London/New York session).
  if (session && isHighLiquiditySession(session)) confidence = clamp01(confidence * 1.15);

  // Промт-фикс п.2: единственная из "трендовых" M1-стратегий без явного
  // порога входа — см. ENTRY_THRESHOLD выше.
  if (confidence < ENTRY_THRESHOLD) return null;

  return {
    name: 'macd-deceleration-continuation',
    direction,
    confidence,
    strength: strengthForConfidence(confidence),
    time: last.time,
  };
}
