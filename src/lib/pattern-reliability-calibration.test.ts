import { describe, it, expect } from 'vitest';
import type { FactorStatRow } from '@/ui/factor-analytics';
import { MIN_FACTOR_SAMPLES } from '@/ui/factor-analytics';
import {
  computeReliabilitySuggestions,
  toMultiplierUpdates,
  suggestedMultiplierFromWinRate,
  breakevenWinRateFromProfitPercent,
  wilsonLowerBound,
} from './pattern-reliability-calibration';
import { STRATEGY_BONUS_PATTERNS, RELIABILITY_MULTIPLIER_MIN, RELIABILITY_MULTIPLIER_MAX } from './pattern-categories';

function row(overrides: Partial<FactorStatRow>): FactorStatRow {
  return {
    name: 'doji',
    kind: 'pattern',
    sampleCount: 10,
    decidedCount: 10,
    wins: 5,
    winRate: 0.5,
    ...overrides,
  };
}

// Безубыток по умолчанию в тестах ниже — тот, что использовался руками до
// фикса (0.5) — передаём его явно там, где тест проверяет НЕ саму
// payout-экономику, а другую, не связанную с ней логику (фильтрацию по
// сэмплам, exclusion-правила, сортировку и т.д.), чтобы не завязывать эти
// тесты на конкретное числовое значение безубытка.
const COIN_FLIP_BREAKEVEN = 0.5;

// BUGFIX (аудит 2026-09-13, "MIN_FACTOR_SAMPLES=5 недостаточен для
// самокалибровки"): computeReliabilitySuggestions теперь считает
// предлагаемый множитель от wilsonLowerBound(wins, decidedCount), а не от
// сырого row.winRate — значит decidedCount:10 (использовавшийся во многих
// тестах ниже раньше, когда порог отсечения был 5) теперь ниже
// MIN_FACTOR_SAMPLES=20 и строки с ним просто исключались бы из
// предпросмотра. Все фикстуры ниже подняты минимум до decidedCount:20, а
// ожидаемые числовые значения `after` пересчитаны под реальную формулу
// (см. вычисления в этом же PR/аудите) — Wilson-нижняя граница НИКОГДА не
// равна сырому winRate, поэтому "at coin-flip breakeven raw winRate=0.5
// -> after=1" (справедливое до фикса) больше не выполняется ни для одной
// конечной выборки.
describe('wilsonLowerBound', () => {
  it('matches the well-known reference value for a single 100% observation (n=1)', () => {
    // Стандартный проверочный кейс для интервала Уилсона z=1.96: 1 победа
    // из 1 -> нижняя граница ≈ 0.206, а не сырые 100%.
    expect(wilsonLowerBound(1, 1)).toBeCloseTo(0.2065, 4);
  });

  it('is strictly below the raw winRate for any finite sample below 100%', () => {
    expect(wilsonLowerBound(10, 20)).toBeLessThan(0.5);
    expect(wilsonLowerBound(5, 10)).toBeLessThan(0.5);
  });

  it('converges toward the raw winRate as n grows', () => {
    const small = wilsonLowerBound(50, 100);
    const large = wilsonLowerBound(5000, 10000);
    // Обе выборки — 50% сырых, но при бОльшем n граница ближе к 0.5.
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThan(0.5);
  });

  it('returns 0 for n<=0 without throwing', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
});

describe('breakevenWinRateFromProfitPercent', () => {
  it('at profitPercent=80 (app default) the real breakeven is ~55.56%, not 50%', () => {
    // BUGFIX (аудит 2026-09-13): раньше вся калибровка считала безубытком
    // 50% ("монета"), хотя выплата 80% при выигрыше и потеря всей ставки
    // при проигрыше математически требуют 100/(100+80) = 55.56%.
    expect(breakevenWinRateFromProfitPercent(80)).toBeCloseTo(0.5556, 4);
  });

  it('at profitPercent=100 (1:1 payout) the breakeven is exactly 50%', () => {
    expect(breakevenWinRateFromProfitPercent(100)).toBeCloseTo(0.5, 10);
  });

  it('lower payout requires a higher breakeven winRate', () => {
    expect(breakevenWinRateFromProfitPercent(50)).toBeCloseTo(2 / 3, 4);
  });

  it('falls back to the 80%-payout breakeven for invalid input (0, negative, NaN)', () => {
    const fallback = breakevenWinRateFromProfitPercent(80);
    expect(breakevenWinRateFromProfitPercent(0)).toBeCloseTo(fallback, 10);
    expect(breakevenWinRateFromProfitPercent(-10)).toBeCloseTo(fallback, 10);
    expect(breakevenWinRateFromProfitPercent(NaN)).toBeCloseTo(fallback, 10);
  });
});

describe('suggestedMultiplierFromWinRate', () => {
  it('maps a winRate equal to the given breakevenWinRate to multiplier 1', () => {
    expect(suggestedMultiplierFromWinRate(0.5, COIN_FLIP_BREAKEVEN)).toBe(1);
    expect(suggestedMultiplierFromWinRate(0.5556, 0.5556)).toBeCloseTo(1, 6);
  });

  it('a 50% winRate is BELOW breakeven (and thus penalized) once payout < 100% is accounted for', () => {
    // Ровно баг, который чинит этот фикс: при реальном payout 80% винрейт
    // 50% убыточен (EV = 0.5*0.8 - 0.5 = -0.10 на $1 ставки), а не
    // "нейтрален", как считала старая константа 0.5.
    const realBreakeven = breakevenWinRateFromProfitPercent(80);
    expect(suggestedMultiplierFromWinRate(0.5, realBreakeven)).toBeLessThan(1);
  });

  it('clamps very high winRate to RELIABILITY_MULTIPLIER_MAX', () => {
    expect(suggestedMultiplierFromWinRate(1, COIN_FLIP_BREAKEVEN)).toBe(RELIABILITY_MULTIPLIER_MAX);
  });

  it('clamps very low winRate to RELIABILITY_MULTIPLIER_MIN', () => {
    expect(suggestedMultiplierFromWinRate(0, COIN_FLIP_BREAKEVEN)).toBe(RELIABILITY_MULTIPLIER_MIN);
  });
});

describe('computeReliabilitySuggestions', () => {
  it('suggests a lowered multiplier for a low-winRate pattern with enough samples', () => {
    // decidedCount поднят с 19 до 20 (MIN_FACTOR_SAMPLES) — с 19 строка
    // теперь исключалась бы из предпросмотра ещё до расчёта множителя.
    const stats = [row({ name: 'inside-bar', decidedCount: 20, wins: 5, winRate: 5 / 20 })];
    const suggestions = computeReliabilitySuggestions(stats, {}, COIN_FLIP_BREAKEVEN);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].name).toBe('inside-bar');
    expect(suggestions[0].after).toBeLessThan(1);
    expect(suggestions[0].after).toBeGreaterThanOrEqual(RELIABILITY_MULTIPLIER_MIN);
  });

  it('excludes rows below MIN_FACTOR_SAMPLES decidedCount', () => {
    const stats = [row({ name: 'doji', decidedCount: MIN_FACTOR_SAMPLES - 1, winRate: 0.9 })];
    expect(computeReliabilitySuggestions(stats, {}, COIN_FLIP_BREAKEVEN)).toEqual([]);
  });

  it('excludes rows whose name is not a valid PatternName (indicators, structure, filters)', () => {
    const stats = [
      row({ name: 'rsi', kind: 'indicator', decidedCount: 20, winRate: 0.2 }),
      row({ name: 'bos', kind: 'bos', decidedCount: 20, winRate: 0.2 }),
      row({ name: 'signal-filter', kind: 'filter', decidedCount: 20, winRate: 0.2 }),
    ];
    expect(computeReliabilitySuggestions(stats, {}, COIN_FLIP_BREAKEVEN)).toEqual([]);
  });

  it('excludes STRATEGY_BONUS_PATTERNS entries, even if they look like eligible pattern rows', () => {
    expect(STRATEGY_BONUS_PATTERNS.length).toBeGreaterThan(0);
    const stats = STRATEGY_BONUS_PATTERNS.map((name) =>
      row({ name, decidedCount: 20, wins: 4, winRate: 0.2 }),
    );
    expect(computeReliabilitySuggestions(stats, {}, COIN_FLIP_BREAKEVEN)).toEqual([]);
  });

  it('excludes rows with a null winRate (no decided trades)', () => {
    const stats = [row({ name: 'doji', decidedCount: MIN_FACTOR_SAMPLES, winRate: null })];
    expect(computeReliabilitySuggestions(stats, {}, COIN_FLIP_BREAKEVEN)).toEqual([]);
  });

  it('reports "before" from the provided currentOverrides, and "after" from the Wilson-adjusted winRate, not the raw one', () => {
    // wins=10/decidedCount=20 (raw winRate=0.5, ровно на COIN_FLIP_BREAKEVEN)
    // -> wilsonLowerBound(10, 20) ≈ 0.299, что даёт after=0.6, а НЕ 1, как
    // было бы при подстановке сырого winRate.
    const stats = [row({ name: 'doji', decidedCount: 20, wins: 10, winRate: 0.5 })];
    const suggestions = computeReliabilitySuggestions(stats, { doji: 0.7 }, COIN_FLIP_BREAKEVEN);
    expect(suggestions[0].before).toBe(0.7);
    expect(suggestions[0].after).toBeCloseTo(0.6, 2);
    expect(suggestions[0].changed).toBe(true);
  });

  it('marks changed=false when the recomputed (Wilson-adjusted) multiplier matches the current override', () => {
    // Тот же фикстур, что и выше (wins=10/decidedCount=20) даёт after=0.6 —
    // override должен совпадать именно с этим числом, не с 1.
    const stats = [row({ name: 'doji', decidedCount: 20, wins: 10, winRate: 0.5 })];
    const suggestions = computeReliabilitySuggestions(stats, { doji: 0.6 }, COIN_FLIP_BREAKEVEN);
    expect(suggestions[0].changed).toBe(false);
  });

  it('sorts changed suggestions before unchanged ones', () => {
    const stats = [
      row({ name: 'doji', decidedCount: 20, wins: 10, winRate: 0.5 }), // unchanged (override=0.6, см. тест выше)
      row({ name: 'hammer', decidedCount: 20, wins: 2, winRate: 0.1 }), // changed (raw и Wilson-нижняя оба далеко от override=1)
    ];
    const suggestions = computeReliabilitySuggestions(stats, { doji: 0.6, hammer: 1 }, COIN_FLIP_BREAKEVEN);
    expect(suggestions[0].name).toBe('hammer');
    expect(suggestions[0].changed).toBe(true);
  });

  it('uses the real 80%-payout breakeven (~55.56%) by default when breakevenWinRate is omitted', () => {
    // BUGFIX (аудит 2026-09-13): раньше вызов без явного winRate-безубытка
    // тихо давал multiplier=1 для 50%-паттерна ("нейтрален"). Дефолтный
    // безубыток теперь производный от payout 80%, а не от монеты 50/50 —
    // 50%-паттерн (тем более после Wilson-поправки, которая ещё и снижает
    // саму оценку) должен получить множитель заметно МЕНЬШЕ 1.
    const stats = [row({ name: 'doji', decidedCount: 20, wins: 10, winRate: 0.5 })];
    const suggestions = computeReliabilitySuggestions(stats, {});
    expect(suggestions[0].after).toBeLessThan(1);
  });

  it('a symbol with a lower configured payout gets a higher (stricter) breakeven bar', () => {
    // BUGFIX (аудит 2026-09-13): исходный фикстур (winRate=0.56, n=10) был
    // заменён — при Wilson-нижней границе 56% сырого винрейта настолько
    // близки к 80%-безубытку (55.56%), что нужна нереалистично огромная
    // выборка (n~50000), чтобы граница вообще превысила безубыток; это не
    // ошибка теста, а именно то, что и должен делать статистически честный
    // расчёт — "едва выше безубытка" не должно выглядеть надёжно
    // прибыльным ни при каком практически достижимом n. Для теста взят
    // винрейт (75%), достаточно уверенно выше ОБОИХ безубытков по сырому
    // значению, чтобы после Wilson-поправки на разумном n (40) остаться
    // выше 55.56%, но ниже 62.5%.
    const stats = [row({ name: 'doji', decidedCount: 40, wins: 30, winRate: 0.75 })];
    const at80Payout = computeReliabilitySuggestions(stats, {}, breakevenWinRateFromProfitPercent(80));
    const at60Payout = computeReliabilitySuggestions(stats, {}, breakevenWinRateFromProfitPercent(60));
    // Wilson-нижняя граница (75% сырых, n=40) ≈ 0.598: выше 55.56% (payout
    // 80%), но ниже 62.5% (payout 60%) — множитель должен это отражать.
    expect(at80Payout[0].after).toBeGreaterThan(1);
    expect(at60Payout[0].after).toBeLessThan(1);
  });
});

describe('toMultiplierUpdates', () => {
  it('builds a name -> after map from suggestions', () => {
    const stats = [row({ name: 'doji', decidedCount: 20, wins: 4, winRate: 0.2 })];
    const suggestions = computeReliabilitySuggestions(stats, {}, COIN_FLIP_BREAKEVEN);
    const updates = toMultiplierUpdates(suggestions);
    expect(updates.doji).toBe(suggestions[0].after);
    expect(Object.keys(updates)).toHaveLength(1);
  });
});
