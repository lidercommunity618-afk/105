import type { Candle } from '@/types/domain';
import { atr } from './atr';
import { resampleCandles } from '@/compute/patterns/fvg-strategies-shared';

// ─────────────────────────────────────────────────────────────────────────
// ZigZag / поиск точек X-A-B-C-D для модуля "Гармонические паттерны"
// (Gartley/Butterfly/AB=CD, см. src/compute/patterns/harmonic-pattern.ts).
//
// Намеренно НЕ переиспользует findPivots() (./pivots.ts) — там фиксированный
// PIVOT_LOOKUP=2, что на M1 даёт шумовые локальные экстремумы, непригодные
// для 5-точечной геометрии гармоник (см. промт/аудит модуля). Вместо этого —
// классический ATR-адаптивный ZigZag: разворот регистрируется только когда
// цена отходит от текущего экстремума минимум на `minLegAtrMultiple × ATR`.
// ─────────────────────────────────────────────────────────────────────────

export interface ZigZagPoint {
  time: number;
  price: number;
  type: 'high' | 'low';
  /** Индекс внутри массива свечей, переданного в computeZigZag (после ресэмплинга, если он применялся). */
  index: number;
}

/**
 * ATR-адаптивный ZigZag на переданном массиве свечей (без ресэмплинга —
 * см. findHarmonicZigZagPoints ниже для полного пайплайна с HTF-ресэмплингом).
 */
export function computeZigZag(
  candles: Candle[],
  minLegAtrMultiple: number,
  atrPeriod: number = 14,
): ZigZagPoint[] {
  if (candles.length < 3 || minLegAtrMultiple <= 0) return [];

  const atrValues = atr(candles, atrPeriod);
  const points: ZigZagPoint[] = [];

  let trend: 'up' | 'down' | null = null;
  let extremePrice = candles[0].close;
  let extremeIndex = 0;

  for (let i = 1; i < candles.length; i++) {
    // ATR ещё не прогрелся (первые atrPeriod баров) — пропускаем бар, не
    // рискуя порогом 0/null (что дало бы ложные срабатывания на любом шуме).
    const currentAtr = atrValues[i];
    if (currentAtr === null || currentAtr <= 0) continue;
    const threshold = minLegAtrMultiple * currentAtr;
    const candle = candles[i];

    if (trend === null) {
      // Ждём первое движение, достаточное для установления направления —
      // до этого момента экстремум просто следует за close первой свечи.
      if (candle.high - extremePrice >= threshold) {
        trend = 'up';
        extremePrice = candle.high;
        extremeIndex = i;
      } else if (extremePrice - candle.low >= threshold) {
        trend = 'down';
        extremePrice = candle.low;
        extremeIndex = i;
      }
      continue;
    }

    if (trend === 'up') {
      if (candle.high >= extremePrice) {
        extremePrice = candle.high;
        extremeIndex = i;
      } else if (extremePrice - candle.low >= threshold) {
        // Разворот вниз — фиксируем накопленный максимум как high-пивот.
        points.push({ time: candles[extremeIndex].time, price: extremePrice, type: 'high', index: extremeIndex });
        trend = 'down';
        extremePrice = candle.low;
        extremeIndex = i;
      }
    } else {
      if (candle.low <= extremePrice) {
        extremePrice = candle.low;
        extremeIndex = i;
      } else if (candle.high - extremePrice >= threshold) {
        // Разворот вверх — фиксируем накопленный минимум как low-пивот.
        points.push({ time: candles[extremeIndex].time, price: extremePrice, type: 'low', index: extremeIndex });
        trend = 'up';
        extremePrice = candle.high;
        extremeIndex = i;
      }
    }
  }

  return points;
}

/**
 * Полный пайплайн для гармоник: ресэмплинг на синтетический старший ТФ
 * (тот же приём, что уже используют order-block-nested.ts/fvg-nested.ts —
 * resampleCandles + HTF_FACTOR=5) + ATR-адаптивный ZigZag поверх него. На
 * голом M1 без ресэмплинга ZigZag даёт либо ноль сработок, либо шум —
 * поэтому это единственный поддерживаемый способ получить точки X-A-B-C-D
 * для харонических детекторов.
 *
 * Возвращает null, если точек меньше 5 (минимум для X-A-B-C-D), иначе —
 * последние `tailCount` чередующихся high/low точек (готовые как X, A, B,
 * C, D по порядку, если tailCount === 5).
 *
 * `tailCount` (по умолчанию 5, как и раньше — все существующие вызовы,
 * включая ChartPanel.tsx, продолжают получать ровно последние 5 точек без
 * изменений) — оставлен настраиваемым, чтобы детектор
 * (detectHarmonicPattern) мог запросить более длинный хвост и построить
 * несколько скользящих окон X-A-B-C-D (паттерн мог "сложиться" 1-2 точки
 * ZigZag назад, не обязательно строго на самой последней) — тот же приём,
 * что и в детекторе гармоник соседнего проекта на базе findPivots/
 * buildZigzag. slice(-tailCount) на массиве короче tailCount просто вернёт
 * всё, что есть — не требует отдельной обработки "точек меньше tailCount".
 */
/**
 * BUGFIX (аудит модуля "гармоники", 2026-09; централизовано по итогам
 * Рекомендации 1 последующего аудита): resampleCandles() группирует свечи
 * блоками по `factor` НАЧИНАЯ С ИНДЕКСА 0 переданного массива — для
 * фиксированного набора данных это безобидно, но production/бэктест
 * передают в detectHarmonicPattern() СКОЛЬЗЯЩЕЕ окно
 * (`candles.slice(i - windowSize + 1, i + 1)`, см. backtest/simulator.ts /
 * src/engine/analysisEngine.ts), у которого начало сдвигается на 1 свечу
 * каждый бар. Из-за этого граница HTF-группировки для ОДНИХ И ТЕХ ЖЕ
 * абсолютных свечей "гуляла" в зависимости от `i % htfFactor` — на
 * синтетических данных с эталонными точками X-A-B-C-D это проявлялось как:
 * время/цена уже НАЙДЕННОЙ точки D дрейфовали на каждом баре (вплоть до
 * (htfFactor-1) сырых баров) без единого реального изменения цены, а на
 * части фаз конкретный бар мог не давать сработки вовсе, хотя на соседнем
 * баре та же геометрия детектировалась (см. docs/audit).
 *
 * Выравнивание (`alignToAbsoluteTime: true`) теперь встроено в саму
 * `resampleCandles()` (fvg-strategies-shared.ts) как опциональный параметр
 * — раньше было локальной функцией `alignToAbsoluteHtfBoundary` только
 * здесь, что при подтверждённой (см. docs/audit) той же уязвимости в
 * detectHtfObZones (order-block-nested.ts) / detectHtfFvgZones
 * (fvg-nested.ts) означало бы копирование одной и той же логики в 3 места.
 * Поведение и результат для этого файла не изменились — просто вызов
 * теперь идёт через общий флаг вместо локальной обёртки.
 */
export function findHarmonicZigZagPoints(
  candles: Candle[],
  minLegAtrMultiple: number,
  htfFactor: number,
  atrPeriod: number = 14,
  tailCount: number = 5,
): ZigZagPoint[] | null {
  const htf = resampleCandles(candles, htfFactor, { alignToAbsoluteTime: true });
  const points = computeZigZag(htf, minLegAtrMultiple, atrPeriod);
  if (points.length < 5) return null;
  return points.slice(-tailCount);
}
