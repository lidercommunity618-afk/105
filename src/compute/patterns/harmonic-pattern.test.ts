import { describe, it, expect } from 'vitest';
import { detectHarmonicPattern, type HarmonicConfig } from '@/compute/patterns/harmonic-pattern';
import type { Candle } from '@/types/domain';
import type { SmartMoneyResult } from '@/compute/indicators/smart-money';

// ─────────────────────────────────────────────────────────────────────────
// Фикстуры ниже строят свечи, ATR-адаптивный ZigZag на которых (см.
// zigzag.ts) детерминированно даёт ровно 5 точек X-A-B-C-D с известными
// вручную посчитанными коэффициентами Фибоначчи. Числа предварительно
// проверены прогоном отдельной чистой JS-копии computeZigZag на этих же
// свечах (вне vitest, т.к. окружение без npm/vitest) — здесь фиксируется
// ожидаемый результат этой проверки.
//
// htfFactor: 1 отключает ресэмплинг (resampleCandles(c,1)===c), чтобы
// фикстуры были точными без учёта агрегации на старший ТФ — сам
// ресэмплинг ("на голом M1 без него ZigZag даёт либо ноль сработок, либо
// шум") проверяется отдельно на уровне zigzag.ts, не здесь.
// ─────────────────────────────────────────────────────────────────────────

function candle(time: number, open: number, close: number, high: number, low: number, volume = 100): Candle {
  return { time, open, high, low, close, volume };
}

function ramp(startTime: number, from: number, to: number, bars: number, wick = 0.15): { candles: Candle[]; endTime: number } {
  const candles: Candle[] = [];
  let t = startTime;
  const step = (to - from) / bars;
  let price = from;
  for (let i = 0; i < bars; i++) {
    const open = price;
    price = from + step * (i + 1);
    const close = price;
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick;
    candles.push(candle(t, open, close, high, low));
    t += 60;
  }
  return { candles, endTime: t };
}

function flat(startTime: number, price: number, bars: number, noise = 0.3): { candles: Candle[]; endTime: number } {
  const candles: Candle[] = [];
  let t = startTime;
  for (let i = 0; i < bars; i++) {
    const wobble = (i % 2 === 0 ? 1 : -1) * noise * 0.3;
    const open = price;
    const close = price + wobble;
    const high = Math.max(open, close) + noise;
    const low = Math.min(open, close) - noise;
    candles.push(candle(t, open, close, high, low));
    t += 60;
  }
  return { candles, endTime: t };
}

// Число баров на ногу подбирается так, чтобы шаг цены за бар оставался
// примерно постоянным (~2) независимо от длины ноги — иначе ATR, унаследованный
// от предыдущей (другой по масштабу) ноги, искажает момент подтверждения
// разворота на следующей.
function barsFor(from: number, to: number): number {
  return Math.max(10, Math.round(Math.abs(to - from) / 2));
}

function buildSwingCandles(startPrice: number, targets: number[], warmupBars = 20): Candle[] {
  let t = 1_700_000_000;
  const out: Candle[] = [];
  const warm = flat(t, startPrice, warmupBars);
  out.push(...warm.candles);
  t = warm.endTime;
  let prev = startPrice;
  for (const target of targets) {
    const leg = ramp(t, prev, target, barsFor(prev, target));
    out.push(...leg.candles);
    t = leg.endTime;
    prev = target;
  }
  return out;
}

const TEST_CONFIG: HarmonicConfig = {
  minLegAtr: 1.0,
  fibTolerancePct: 8,
  htfFactor: 1,
};

describe('detectHarmonicPattern', () => {
  it('returns null with insufficient candle history', () => {
    const candles = [candle(1, 100, 101, 101, 99)];
    expect(detectHarmonicPattern(candles, undefined, undefined, undefined, undefined, TEST_CONFIG)).toBeNull();
  });

  it('detects a bullish Gartley (X low, A high, B low, C high, D low) and buy direction', () => {
    // X=100(low) A=200(high) B=138.2(low) C=169.1(high) D=121.4(low), затем
    // подтверждающий разворот вверх. Вручную посчитанные коэффициенты:
    // AB/XA=0.618, BC/AB=0.5 (в 0.382-0.886), CD/BC≈1.54 (в 1.13-1.618),
    // AD/XA=0.786 — все точно на идеальных значениях Gartley.
    const candles = buildSwingCandles(150, [100, 200, 138.2, 169.1, 121.4, 140]);
    const result = detectHarmonicPattern(candles, undefined, undefined, undefined, undefined, TEST_CONFIG);

    expect(result).not.toBeNull();
    expect(result?.name).toBe('harmonic-pattern');
    expect(result?.harmonicType).toBe('gartley');
    expect(result?.direction).toBe('buy');
    expect(result?.confidence).toBeGreaterThan(0.8);
    expect(result?.przLow).toBeDefined();
    expect(result?.przHigh).toBeDefined();
    expect(result!.przLow!).toBeLessThan(result!.przHigh!);
    // Стоп ниже D/X (buy), тейк — между D и C (61.8% ретрейс C→D обратно к C).
    expect(result!.harmonicStop!).toBeLessThan(120);
    expect(result!.harmonicTarget!).toBeGreaterThan(121.4);
    expect(result!.harmonicTarget!).toBeLessThan(169.1);
  });

  it('detects a bearish Butterfly (X high, A low, B high, C low, D high beyond X) and sell direction', () => {
    // X=200(high) A=100(low) B=178.6(high) C=116.82(low) D=227(high, за
    // пределами X) — расширение, характерное для Butterfly. Коэффициенты:
    // AB/XA=0.786, BC/AB=0.786 (в 0.382-0.886), CD/BC≈1.78 (в 1.618-2.24),
    // AD/XA=1.27.
    const candles = buildSwingCandles(150, [200, 100, 178.6, 116.8204, 227, 200]);
    const result = detectHarmonicPattern(candles, undefined, undefined, undefined, undefined, TEST_CONFIG);

    expect(result).not.toBeNull();
    expect(result?.harmonicType).toBe('butterfly');
    expect(result?.direction).toBe('sell');
    expect(result?.confidence).toBeGreaterThan(0.8);
    expect(result!.przLow!).toBeLessThan(result!.przHigh!);
    // Стоп выше D/X (sell), тейк — между D и C.
    expect(result!.harmonicStop!).toBeGreaterThan(227);
    expect(result!.harmonicTarget!).toBeLessThan(227);
    expect(result!.harmonicTarget!).toBeGreaterThan(116.8204);
  });

  it('detects an AB=CD pattern when Gartley/Butterfly ratios do not match but AB≈CD does', () => {
    // X=300(high) — выбран далёким от A, чтобы AB/XA (~0.25) не попадал ни
    // в допуск Gartley (0.618), ни Butterfly (0.786) — тем самым эти два
    // паттерна гарантированно не матчатся. A=100(low) B=150(high, AB=50)
    // C=120(low, BC=30, BC/AB=0.6 — валидный ретрейс) D=170(high, CD=50,
    // CD/AB=1.0 — определение AB=CD).
    const candles = buildSwingCandles(150, [300, 100, 150, 120, 170, 140]);
    const result = detectHarmonicPattern(candles, undefined, undefined, undefined, undefined, TEST_CONFIG);

    expect(result).not.toBeNull();
    expect(result?.harmonicType).toBe('ab-cd');
    expect(result?.direction).toBe('sell');
  });

  it('returns null when no X-A-B-C-D geometry matches any of the 5 harmonic ratio sets', () => {
    // Смещения между точками намеренно несогласованы ни с одним набором
    // коэффициентов. Проверено отдельным прогоном: AB/XA≈0.75 (вне допуска
    // Gartley 0.618, Bat ≤0.5, Crab ≤0.618, случайно внутри допуска
    // Butterfly 0.786) — но AD/XA≈1.13 не попадает ни в допуск 1.27, ни в
    // допуск 1.618, поэтому Butterfly целиком не проходит (нужны все 4
    // коэффициента); CD/AB≈1.17 не попадает в допуск ~1.0 для AB=CD.
    const candles = buildSwingCandles(150, [100, 180, 120, 160, 90, 110]);
    const result = detectHarmonicPattern(candles, undefined, undefined, undefined, undefined, TEST_CONFIG);
    expect(result).toBeNull();
  });

  it('rejects a stale D point (ZigZag confirmed it too long ago relative to the last candle)', () => {
    // Та же геометрия X-A-B-C-D, что и в первом тесте (валидный bullish
    // Gartley), но подтверждающая нога после D растянута гораздо дальше
    // (121.4 → 300 вместо 121.4 → 140). Она не меняет саму геометрию
    // X-A-B-C-D (это точки ДО подтверждающего движения), но отодвигает
    // "текущую" свечу на много баров вперёд от момента, когда ZigZag
    // подтвердил D — ageBars ≈ 88, что выше freshness-порога (BUGFIX,
    // см. комментарий "Freshness gate" в harmonic-pattern.ts). Раньше
    // детектор вернул бы этот же паттерн (с тем же przLow/przHigh) сколь
    // угодно долго после реального завершения сетапа.
    const candles = buildSwingCandles(150, [100, 200, 138.2, 169.1, 121.4, 300]);
    const result = detectHarmonicPattern(candles, undefined, undefined, undefined, undefined, TEST_CONFIG);
    expect(result).toBeNull();
  });

  it('rejects a pattern whose structural target was already reached before the signal could fire', () => {
    // Тот же bullish Gartley, но подтверждающая нога идёт немного дальше
    // (121.4 → 155 вместо 121.4 → 140) — этого недостаточно, чтобы D устарел
    // по времени (ageBars остаётся в допуске), но достаточно, чтобы цена по
    // пути уже коснулась harmonicTarget (~150.9, см. первый тест). BUGFIX:
    // без проверки задним числом это вернуло бы формально валидный сигнал
    // на сделку, которая по факту уже отыграна целиком до момента открытия
    // позиции.
    const candles = buildSwingCandles(150, [100, 200, 138.2, 169.1, 121.4, 155]);
    const result = detectHarmonicPattern(candles, undefined, undefined, undefined, undefined, TEST_CONFIG);
    expect(result).toBeNull();
  });

  // ── Bat / Crab (интегрированы из параллельной реализации модуля) ────────
  it('detects a bullish Bat (X low, A high, B low, C high, D low) and buy direction', () => {
    // X=100(low) A=200(high) B=155(low) C=182.81(high) D=111.4(low).
    // AB/XA=0.45 (в 0.382-0.5, вне допуска Gartley 0.618 и Butterfly 0.786),
    // BC/AB=0.618 (в общем для всех 4 диапазоне 0.382-0.886),
    // CD/BC≈2.57 (в 1.618-2.618, специфично для Bat),
    // AD/XA=0.886 — точно идеал Bat (вне допуска Gartley/Butterfly/Crab).
    const candles = buildSwingCandles(150, [100, 200, 155, 182.81, 111.4, 130]);
    const result = detectHarmonicPattern(candles, undefined, undefined, undefined, undefined, TEST_CONFIG);

    expect(result).not.toBeNull();
    expect(result?.name).toBe('harmonic-pattern');
    expect(result?.harmonicType).toBe('bat');
    expect(result?.direction).toBe('buy');
    expect(result?.confidence).toBeGreaterThan(0.8);
    expect(result!.przLow!).toBeLessThan(result!.przHigh!);
    expect(result!.harmonicStop!).toBeLessThan(111.4);
    // Диагностика: точки X-A-B-C-D и коэффициенты должны присутствовать и
    // совпадать с геометрией фикстуры (перенесено из параллельной
    // реализации — раньше detectHarmonicPattern их не возвращал вовсе).
    // Допуск 1 (± 0.5) — точки ZigZag регистрируются на wick-экстремумах
    // фикстурных свечей (см. ramp()/flat() с noise/wick), а не строго на
    // переданных targets, тот же порядок точности, что и у остальных
    // числовых проверок PRZ/SL/TP в этом файле (toBeLessThan/toBeGreaterThan
    // вместо точного равенства).
    expect(result?.harmonicPoints?.x.price).toBeCloseTo(100, 0);
    expect(result?.harmonicPoints?.d.price).toBeCloseTo(111.4, 0);
    expect(result?.harmonicRatios?.ad_xa).toBeCloseTo(0.886, 1);
  });

  it('detects a bullish Crab (X low, A high, B low, C high, D low beyond X) and buy direction', () => {
    // X=100(low) A=200(high) B=145(low) C=187(high) D=38.2(low, ЗА
    // пределами X=100 в обратную сторону — расширение, характерное для
    // Crab). Зеркальная (bearish) версия этой же геометрии — тестом ниже,
    // для симметрии с парой bullish Gartley / bearish Butterfly выше.
    // AB/XA=0.55 (в 0.382-0.618, вне допуска Bat ≤0.5 и Gartley 0.618±tol),
    // BC/AB≈0.764 (в общем диапазоне 0.382-0.886),
    // CD/BC≈3.54 (в 2.24-3.618, специфично для Crab),
    // AD/XA=1.618 — точно идеал Crab (Butterfly тоже допускает 1.618, но
    // отсекается по AB/XA=0.55, далёкому от идеала Butterfly 0.786).
    const candles = buildSwingCandles(150, [100, 200, 145, 187, 38.2, 95]);
    const result = detectHarmonicPattern(candles, undefined, undefined, undefined, undefined, TEST_CONFIG);

    expect(result).not.toBeNull();
    expect(result?.harmonicType).toBe('crab');
    expect(result?.direction).toBe('buy');
    expect(result?.confidence).toBeGreaterThan(0.8);
    expect(result!.przLow!).toBeLessThan(result!.przHigh!);
    expect(result?.harmonicRatios?.ad_xa).toBeCloseTo(1.618, 1);
  });

  // ── Скользящие окна поиска (интегрированы из параллельной реализации) ───
  it('still finds the pattern via the [-6,-1] window when one extra ZigZag point has formed after D', () => {
    // Тот же bullish Gartley X-A-B-C-D, что и в первом тесте, но после D
    // добавлена ещё одна нога (121.4 → 145 → 128), которая успевает
    // подтвердить ЕЩЁ ОДНУ точку ZigZag (E=145, high) до конца фикстуры —
    // проверено отдельным прогоном computeZigZag на этих же свечах: ровно
    // 6 точек (X,A,B,C,D,E), т.е. "последние 5" точек ZigZag теперь
    // A-B-C-D-E, а не X-A-B-C-D. Раньше (без скользящих окон,
    // findHarmonicZigZagPoints всегда возвращал ровно 5 точек) валидный
    // Gartley был бы потерян целиком — детектор видел бы только A-B-C-D-E,
    // которая не образует известную геометрию. С окном tail.slice(-6,-1)
    // (см. detectHarmonicPattern) X-A-B-C-D по-прежнему проверяется и
    // находится, несмотря на появление E.
    const candles = buildSwingCandles(150, [100, 200, 138.2, 169.1, 121.4, 145, 128]);
    const result = detectHarmonicPattern(candles, undefined, undefined, undefined, undefined, TEST_CONFIG);

    expect(result).not.toBeNull();
    expect(result?.harmonicType).toBe('gartley');
    expect(result?.direction).toBe('buy');
    // D — по-прежнему точка из исходной геометрии (~121.4), а не E (~145).
    expect(result?.harmonicPoints?.d.price).toBeCloseTo(121.4, 0);
  });

  // ── PRZ-конфлюэнс с OB/FVG (интегрирован из параллельной реализации) ────
  it('boosts confidence and adds a confluence factor when the PRZ overlaps a fresh same-direction order block', () => {
    const candles = buildSwingCandles(150, [100, 200, 138.2, 169.1, 121.4, 140]);
    const withoutConfluence = detectHarmonicPattern(candles, undefined, undefined, undefined, undefined, TEST_CONFIG);
    expect(withoutConfluence).not.toBeNull();
    const przLow = withoutConfluence!.przLow!;
    const przHigh = withoutConfluence!.przHigh!;
    const lastTime = candles[candles.length - 1].time;

    const smartMoney: SmartMoneyResult = {
      orderBlocks: [
        {
          top: przHigh,
          bottom: przLow,
          time: lastTime - 5 * 60,
          type: 'bullish',
          mitigated: false,
          endTime: null,
          touchCount: 0,
          rejections: [],
          status: 'untested',
          strengthScore: 1,
          hasDisplacement: true,
          hasStructureConfluence: true,
          bodyTop: przHigh,
          bodyBottom: przLow,
          meanThreshold: (przHigh + przLow) / 2,
          hasFvgConfluence: true,
          hasLiquiditySweep: true,
        },
      ],
      fvgs: [],
      inversionFvgs: [],
      breakerBlocks: [],
      rejectionBlocks: [],
      bosEvents: [],
    };

    const withConfluence = detectHarmonicPattern(candles, undefined, undefined, undefined, smartMoney, TEST_CONFIG);
    expect(withConfluence).not.toBeNull();
    expect(withConfluence!.confidence).toBeGreaterThan(withoutConfluence!.confidence);
    expect(withConfluence?.confluenceFactors).toContain('PRZ confluence with bullish order block');
  });

  it('does not apply the confluence bonus for a stale (too old) order block at the PRZ', () => {
    const candles = buildSwingCandles(150, [100, 200, 138.2, 169.1, 121.4, 140]);
    const baseline = detectHarmonicPattern(candles, undefined, undefined, undefined, undefined, TEST_CONFIG);
    expect(baseline).not.toBeNull();
    const przLow = baseline!.przLow!;
    const przHigh = baseline!.przHigh!;
    const lastTime = candles[candles.length - 1].time;

    const smartMoney: SmartMoneyResult = {
      orderBlocks: [
        {
          top: przHigh,
          bottom: przLow,
          // Старше freshness-порога (CONFLUENCE_FRESHNESS_MAX_AGE_BARS=20
          // баров) — не должен давать бонус.
          time: lastTime - 500 * 60,
          type: 'bullish',
          mitigated: false,
          endTime: null,
          touchCount: 0,
          rejections: [],
          status: 'untested',
          strengthScore: 1,
          hasDisplacement: true,
          hasStructureConfluence: true,
          bodyTop: przHigh,
          bodyBottom: przLow,
          meanThreshold: (przHigh + przLow) / 2,
          hasFvgConfluence: true,
          hasLiquiditySweep: true,
        },
      ],
      fvgs: [],
      inversionFvgs: [],
      breakerBlocks: [],
      rejectionBlocks: [],
      bosEvents: [],
    };

    const result = detectHarmonicPattern(candles, undefined, undefined, undefined, smartMoney, TEST_CONFIG);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeCloseTo(baseline!.confidence, 5);
    expect(result?.confluenceFactors ?? []).not.toContain('PRZ confluence with bullish order block');
  });

  it('detects a bearish Crab (X high, A low, B high, C low, D high beyond X) and sell direction', () => {
    // Точное зеркало предыдущего bullish Crab (X=100/A=200/B=145/C=187/
    // D=38.2 → X=200/A=100/B=155/C=113/D=261.8) — та же геометрия,
    // отражённая относительно направления, для симметрии с парой
    // bullish Gartley / bearish Butterfly выше.
    const candles = buildSwingCandles(150, [200, 100, 155, 113, 261.8, 205]);
    const result = detectHarmonicPattern(candles, undefined, undefined, undefined, undefined, TEST_CONFIG);

    expect(result).not.toBeNull();
    expect(result?.harmonicType).toBe('crab');
    expect(result?.direction).toBe('sell');
    expect(result?.confidence).toBeGreaterThan(0.8);
    expect(result!.przLow!).toBeLessThan(result!.przHigh!);
    expect(result!.harmonicStop!).toBeGreaterThan(261.8);
    expect(result?.harmonicRatios?.ad_xa).toBeCloseTo(1.618, 1);
  });

  it('falls back to internal defaults when called without a config (e.g. unit tests / cold start)', () => {
    const candles = buildSwingCandles(150, [100, 200, 138.2, 169.1, 121.4, 140]);
    // Дефолтный fibTolerancePct/minLegAtr совпадают с TEST_CONFIG значениями
    // (см. DEFAULT_HARMONIC_CONFIG в harmonic-pattern.ts и
    // DEFAULT_INDICATOR_CONFIG в types/domain.ts), поэтому тот же фикстур
    // должен матчиться и без явного конфига — не должно быть исключения.
    expect(() => detectHarmonicPattern(candles)).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Рекомендация 2 (docs/audit/recommendations-post-harmonic-audit.md):
// существующие 14 тестов выше не поймали баг "PRZ для ab-cd считался от
// BC вместо AB" (см. docs/audit/2026-09-harmonic-module-synthetic-audit.md,
// раздел 2), потому что их фикстуры имели AB и BC достаточно БЛИЗКИМИ по
// величине, чтобы разница между "от какой ноги считать" терялась в допуске
// fibTolerancePct. Ниже — минимум один тест на каждый из 5 типов паттерна
// с ЗАВЕДОМО РАЗНЫМИ по порядку величины AB и BC (bc_ab у нижней границы
// допустимого диапазона ~0.4 и у верхней ~0.85 — покрыты оба конца
// диапазона [0.382, 0.886] в разных фикстурах), с ЧИСЛЕННОЙ проверкой
// przLow/przHigh (не просто "PRZ существует") — именно такая проверка
// поймала бы тот баг.
//
// Числа ниже — не подобраны вручную по формуле "на бумаге", а взяты как
// ФАКТИЧЕСКИЙ результат работы реального детектора на этих фикстурах
// (see docs/changelog/CHANGES_APPLIED_HTF_RESAMPLE_ALIGNMENT_20260912.md
// про методику) — ZigZag сам находит pivot-точки по ATR-порогу, поэтому
// они не обязаны совпадать 1-в-1 с "идеальными" X/A/B/C/D, заданными в
// targets; используется точная величина, которую детектор действительно
// вернул, чтобы тест был регрессионным (ловил будущие изменения формулы),
// а не проверкой соответствия ожиданиям, посчитанным вручную.
describe('detectHarmonicPattern — asymmetric AB/BC fixtures (numeric PRZ regression, Рекомендация 2)', () => {
  it('Gartley: bc_ab ≈ 0.40 (нижняя граница диапазона [0.382, 0.886]) — PRZ считается от BC', () => {
    // X=100 A=200 B=138.2(ab_xa=0.618, точка) C=163(bc_ab≈0.40) D=121.4(ad_xa=0.786, точка)
    const candles = buildSwingCandles(150, [100, 200, 138.2, 162.92, 121.4, 140]);
    const result = detectHarmonicPattern(candles, undefined, undefined, undefined, undefined, TEST_CONFIG);

    expect(result).not.toBeNull();
    expect(result?.harmonicType).toBe('gartley');
    expect(result?.direction).toBe('buy');
    expect(result?.harmonicRatios?.bc_ab).toBeCloseTo(0.403, 2);
    // AB (~61.8) и BC (~24.9) отличаются более чем в 2 раза — именно тот
    // класс асимметрии, который не даёт спутать "посчитано от AB" и
    // "посчитано от BC" внутри допуска.
    expect(result!.przLow).toBeCloseTo(121.3142, 3);
    expect(result!.przHigh).toBeCloseTo(134.7974, 3);
  });

  it('Bat: bc_ab ≈ 0.85 (верхняя граница диапазона) — PRZ считается от BC', () => {
    // X=100 A=200 B=155(ab_xa≈0.45) C=193.25(bc_ab≈0.85) D=111.4(ad_xa=0.886, точка)
    const candles = buildSwingCandles(150, [100, 200, 155, 193.25, 111.4, 130]);
    const result = detectHarmonicPattern(candles, undefined, undefined, undefined, undefined, TEST_CONFIG);

    expect(result).not.toBeNull();
    expect(result?.harmonicType).toBe('bat');
    expect(result?.direction).toBe('buy');
    expect(result?.harmonicRatios?.bc_ab).toBeCloseTo(0.851, 2);
    expect(result!.przLow).toBeCloseTo(92.4761, 3);
    expect(result!.przHigh).toBeCloseTo(131.0261, 3);
  });

  it('Crab: bc_ab ≈ 0.85 (верхняя граница) при ab_xa у своей верхней границы 0.618 — PRZ считается от BC', () => {
    // X=100 A=200 B=138.2(ab_xa=0.618) C=190.73(bc_ab≈0.85) D=38.2(ad_xa=1.618, точка)
    const candles = buildSwingCandles(150, [100, 200, 138.2, 190.73, 38.2, 60]);
    const result = detectHarmonicPattern(candles, undefined, undefined, undefined, undefined, TEST_CONFIG);

    expect(result).not.toBeNull();
    expect(result?.harmonicType).toBe('crab');
    expect(result?.direction).toBe('buy');
    expect(result?.harmonicRatios?.bc_ab).toBeCloseTo(0.851, 2);
    // Широкий PRZ здесь — не баг: crab допускает cd_bc в широком диапазоне
    // [2.24, 3.618], поэтому cdProjectionLow/High далеко друг от друга при
    // такой величине BC. Числа ниже — фактический вывод детектора.
    expect(result!.przLow).toBeCloseTo(-0.2589, 3);
    expect(result!.przHigh).toBeCloseTo(72.5408, 3);
  });

  it('Butterfly: bc_ab ≈ 0.85 (верхняя граница) — PRZ считается от BC', () => {
    // X=200 A=100 B=178.6(ab_xa=0.786, точка) C=111.79(bc_ab≈0.85) D=227(ad_xa=1.27, bestOf)
    const candles = buildSwingCandles(150, [200, 100, 178.6, 111.79, 227, 200]);
    const result = detectHarmonicPattern(candles, undefined, undefined, undefined, undefined, TEST_CONFIG);

    expect(result).not.toBeNull();
    expect(result?.harmonicType).toBe('butterfly');
    expect(result?.direction).toBe('sell');
    expect(result?.harmonicRatios?.bc_ab).toBeCloseTo(0.851, 2);
    expect(result!.przLow).toBeCloseTo(220.224, 3);
    expect(result!.przHigh).toBeCloseTo(261.9664, 3);
  });

  it('AB=CD: bc_ab ≈ 0.40 (BC вдвое меньше AB) — PRZ по-прежнему точка и считается именно от AB, а не от BC (регрессия найденного бага)', () => {
    // A=99.85 B=150.15(ab≈50.3) C=129.85(bc≈20.3, bc_ab≈0.40) D=180.15(cd≈50.3 ≈ AB, не BC)
    const candles = buildSwingCandles(150, [300, 100, 150, 130, 180, 155]);
    const result = detectHarmonicPattern(candles, undefined, undefined, undefined, undefined, TEST_CONFIG);

    expect(result).not.toBeNull();
    expect(result?.harmonicType).toBe('ab-cd');
    expect(result?.direction).toBe('sell');
    expect(result?.harmonicRatios?.bc_ab).toBeCloseTo(0.404, 2);
    // Если бы PRZ по-прежнему считался от BC (~20.3), а не от AB (~50.3),
    // przLow/przHigh отличались бы от D примерно на порядок величины —
    // здесь же PRZ есть выродившаяся ТОЧКА, совпадающая с самим D (в
    // пределах эпсилона на округление, см. Рекомендация 4).
    expect(result!.przLow).toBeCloseTo(180.15, 3);
    expect(result!.przHigh).toBeCloseTo(180.15, 3);
    expect(Math.abs(result!.przHigh! - result!.przLow!)).toBeLessThan(0.01);
  });
});
