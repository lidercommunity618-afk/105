import type { PatternName } from '@/types/domain';
import type { FactorStatRow } from '@/ui/factor-analytics';
import { MIN_FACTOR_SAMPLES } from '@/ui/factor-analytics';
import {
  PATTERN_RELIABILITY_MULTIPLIER,
  STRATEGY_BONUS_PATTERNS,
  PATTERN_LABELS_RU,
  RELIABILITY_MULTIPLIER_MIN,
  RELIABILITY_MULTIPLIER_MAX,
} from './pattern-categories';

// Этап 2 плана калибровки ("КАЛИБРОВКА" + "АНАЛИТИКА ПО ФАКТОРАМ" →
// самообучение): раньше PATTERN_RELIABILITY_MULTIPLIER правился вручную —
// кто-то смотрел на таблицу "АНАЛИТИКА ПО ФАКТОРАМ" и вписывал число в
// pattern-categories.ts. Этот модуль автоматизирует именно этот шаг —
// пересчитывает множитель по формуле из плана и возвращает предпросмотр
// "было/станет" для явного подтверждения пользователем (см.
// CalibrationPanel.tsx), не трогая саму логрегрессию (это отдельный,
// более рискованный Этап 3).

// BUGFIX (аудит 2026-09-13, "калибровка мерит безубыток неправильной
// константой"): раньше здесь стояло BREAKEVEN_WIN_RATE = 0.5 — условная
// монета "1 из 2", никак не связанная с реальной экономикой демо-счёта.
// Приложение торгует бинарными контрактами с выплатой profitPercent (по
// умолчанию 80%) при выигрыше и потерей всей ставки при проигрыше — их
// настоящая точка безубыточности выше 50%:
//
//   p * profitPercent/100 - (1-p) * 1 = 0  =>  p = 100 / (100 + profitPercent)
//
// При profitPercent = 80 это 55.56%, а не 50%. Со старой константой паттерн
// с реальным винрейтом 53% (EV = 0.53*0.8 - 0.47 = -0.046, то есть убыточен)
// получал множитель 0.53/0.5 = 1.06 — САМООБУЧЕНИЕ УСИЛИВАЛО заведомо
// убыточный паттерн, потому что сверяло его не с реальной точкой
// безубыточности счёта, а с абстрактной монеткой. Паттерн ровно на
// настоящем безубытке (55.56%) получал 1.11 вместо честного 1.0.
//
// Теперь опорное значение выводится из фактического profitPercent демо-
// счёта (см. вызов из CalibrationPanel.tsx), а не хардкодится. Это фикс
// логики построения одной константы, диапазон множителей
// [RELIABILITY_MULTIPLIER_MIN; RELIABILITY_MULTIPLIER_MAX] не менялся.
export const DEFAULT_PROFIT_PERCENT_FALLBACK = 80;

/**
 * Настоящая точка безубыточности бинарного контракта с выплатой
 * `profitPercent`% при выигрыше и потерей всей ставки при проигрыше.
 * Например, 80 -> ~0.5556 (55.56%), а не 0.5 — выигрыш меньше 100% ставки
 * означает, что даже "монетка" (50/50) в среднем убыточна.
 *
 * Некорректный вход (0, отрицательное значение, NaN) откатывается на
 * DEFAULT_PROFIT_PERCENT_FALLBACK, чтобы функция не могла вернуть деление
 * на ноль/отрицательное число и не ломала клампинг ниже по цепочке.
 */
export function breakevenWinRateFromProfitPercent(profitPercent: number): number {
  const safeProfitPercent =
    Number.isFinite(profitPercent) && profitPercent > 0 ? profitPercent : DEFAULT_PROFIT_PERCENT_FALLBACK;
  return 100 / (100 + safeProfitPercent);
}

const ALL_PATTERN_NAMES = new Set<string>(Object.keys(PATTERN_LABELS_RU));
const STRATEGY_BONUS_NAME_SET = new Set<string>(STRATEGY_BONUS_PATTERNS);

function isPatternName(name: string): name is PatternName {
  return ALL_PATTERN_NAMES.has(name);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// BUGFIX (аудит 2026-09-13, "MIN_FACTOR_SAMPLES=5 недостаточен для
// самокалибровки"): раньше computeReliabilitySuggestions ниже считал
// множитель прямо от сырого row.winRate (wins/decidedCount), как только
// decidedCount достигал MIN_FACTOR_SAMPLES=5. Стандартная ошибка доли при
// n=5 — порядка ±22% (SE = sqrt(p(1-p)/n) при p=0.5 даёт ~0.224); 4 победы
// из 5 подряд (winRate=0.8) — совершенно рядовая случайность даже при
// истинных 50%, но такая выборка получала множитель, близкий к
// RELIABILITY_MULTIPLIER_MAX, — самообучение реагировало на шум, а не на
// статистически значимое отклонение от безубытка. При этом в
// calibration-model.ts для концептуально той же задачи ("можно ли доверять
// этой статистике") используется MIN_SAMPLES=100 — 20-кратное расхождение
// порогов для одного и того же типа решения внутри одного приложения.
//
// Решение — не сужать сам диапазон множителя (RELIABILITY_MULTIPLIER_MIN/
// MAX не менялись), а не давать шуму выглядеть как доказанная надёжность:
// множитель считается не от сырого winRate, а от НИЖНЕЙ ГРАНИЦЫ интервала
// Уилсона (Wilson score interval, z=1.96 — стандартные 95%) для той же
// пары (wins, n). Эта граница по построению тем ближе к сырому winRate,
// чем больше выборка, и тем сильнее "усаживается" к 0 при малых n или
// экстремальных долях — то есть именно снимает шумовой всплеск у
// небольших выборок, не требуя отдельного волевого порога отсечения.
// MIN_FACTOR_SAMPLES (factor-analytics.ts) отдельно поднят с 5 до 20 —
// не вместо этого фикса, а вместе с ним: Wilson-граница не спасает от
// вырожденных случаев вроде n=1 (см. wilsonLowerBound(1,1)≈0.21 — уже не
// экстремум, но всё ещё крайне шумно), у порога исключения по-прежнему
// есть смысл.
//
// winRate, возвращаемый computeReliabilitySuggestions наружу (для UI),
// НЕ меняется — пользователь по-прежнему видит настоящий наблюдаемый
// винрейт; консервативной делается только внутренняя оценка, на которую
// опирается РЕШЕНИЕ поменять множитель.
export function wilsonLowerBound(wins: number, n: number, z: number = 1.96): number {
  if (n <= 0) return 0;
  const phat = wins / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denominator);
}

/**
 * `breakevenWinRate` обязателен намеренно (без дефолта на 0.5) — чтобы
 * ни один вызов не мог тихо откатиться на неверную "монету 50/50" вместо
 * реальной экономики счёта. Единственное место, откуда это должно
 * вычисляться, — breakevenWinRateFromProfitPercent(profitPercent) с
 * актуальным profitPercent демо-счёта.
 *
 * Принимает уже готовую оценку winRate — вызывающий код сам решает, сырая
 * это доля или статистически консервативная (см. wilsonLowerBound выше и
 * её использование в computeReliabilitySuggestions). Сам по себе это
 * чистый ratio/clamp и намеренно не знает о размере выборки.
 */
export function suggestedMultiplierFromWinRate(winRate: number, breakevenWinRate: number): number {
  return clamp(winRate / breakevenWinRate, RELIABILITY_MULTIPLIER_MIN, RELIABILITY_MULTIPLIER_MAX);
}

export interface ReliabilitySuggestion {
  name: PatternName;
  label: string;
  decidedCount: number;
  wins: number;
  winRate: number;
  before: number;
  after: number;
  changed: boolean;
}

/**
 * Строит предпросмотр "было/станет" из уже посчитанной таблицы
 * АНАЛИТИКА ПО ФАКТОРАМ (computeFactorStats). Ничего не применяет и не
 * мутирует — чистая функция, применение — отдельный шаг
 * (toMultiplierUpdates + applyReliabilityMultiplierUpdatesForSymbol), вызываемый
 * только после явного подтверждения пользователем.
 *
 * Строки исключаются из предпросмотра, если:
 * - decidedCount < MIN_FACTOR_SAMPLES — тот же порог, что и в самой
 *   таблице "АНАЛИТИКА ПО ФАКТОРАМ", ниже него winRate статистически
 *   ненадёжен (см. factor-analytics.ts). Сам предлагаемый множитель
 *   ("after") при этом считается не от сырого winRate, а от нижней
 *   границы интервала Уилсона для (wins, decidedCount) — см.
 *   wilsonLowerBound() выше; порог по сэмплам и Wilson-граница решают
 *   разные части одной задачи (не дать шуму выглядеть доказанным) и не
 *   заменяют друг друга.
 * - имя не является PatternName — computeFactorStats агрегирует ВСЕ
 *   факторы (индикаторы 'rsi'/'ema', структурные 'bos', фильтры и т.д.),
 *   а PATTERN_RELIABILITY_MULTIPLIER применяется только к паттернам.
 * - паттерн входит в STRATEGY_BONUS_PATTERNS. Для них
 *   reliabilityMultiplier в direction-prediction.ts НИКОГДА не участвует
 *   в score (isStrategyBonusPattern делает triggerContribution
 *   принудительно 0 независимо от множителя) — пересчёт для них был бы
 *   мёртвым кодом, создающим иллюзию калибровки без реального эффекта.
 *   (Отдельно от этого: computeFactorStats раньше задваивал их
 *   sampleCount/decidedCount из-за двух SignalFactor с одинаковым name —
 *   этот баг исправлен в самом computeFactorStats дедупликацией по имени
 *   на сигнал, так что таблица "АНАЛИТИКА ПО ФАКТОРАМ" для них теперь
 *   показывает корректные числа для постмортема, но множитель для них
 *   всё равно не имеет смысла пересчитывать — см. причину выше.)
 */
export function computeReliabilitySuggestions(
  factorStats: FactorStatRow[],
  currentOverrides: Partial<Record<PatternName, number>> = PATTERN_RELIABILITY_MULTIPLIER,
  // BUGFIX (аудит 2026-09-13): раньше не принимал этот параметр вовсе —
  // suggestedMultiplierFromWinRate() внутри был жёстко привязан к
  // BREAKEVEN_WIN_RATE=0.5 (условная монета, а не реальный безубыток).
  // Дефолт здесь — НЕ старое поведение 0.5, а честный безубыток для
  // дефолтного payout счёта (DEFAULT_PROFIT_PERCENT_FALLBACK=80 ->
  // 55.56%), чтобы вызовы без явного payout (напр. старые тесты) сразу
  // получали корректную экономику, а не тихо возвращались к багу. Реальный
  // вызов из CalibrationPanel.tsx всегда передаёт
  // breakevenWinRateFromProfitPercent(profitPercent) с ФАКТИЧЕСКОЙ выплатой
  // текущего демо-счёта пользователя (она может отличаться от 80).
  breakevenWinRate: number = breakevenWinRateFromProfitPercent(DEFAULT_PROFIT_PERCENT_FALLBACK),
): ReliabilitySuggestion[] {
  const suggestions: ReliabilitySuggestion[] = [];
  for (const row of factorStats) {
    if (row.decidedCount < MIN_FACTOR_SAMPLES) continue;
    if (row.winRate === null) continue;
    if (!isPatternName(row.name)) continue;
    if (STRATEGY_BONUS_NAME_SET.has(row.name)) continue;

    const before = currentOverrides[row.name] ?? 1;
    // Wilson lower bound (не сырой row.winRate) — см. подробное обоснование
    // в wilsonLowerBound() выше. row.winRate (сырой) остаётся в
    // возвращаемом объекте ниже без изменений — для честного отображения
    // в UI; здесь используется только для РЕШЕНИЯ, какой множитель
    // предложить.
    const reliableWinRate = wilsonLowerBound(row.wins, row.decidedCount);
    const after = Math.round(suggestedMultiplierFromWinRate(reliableWinRate, breakevenWinRate) * 100) / 100;
    suggestions.push({
      name: row.name,
      label: PATTERN_LABELS_RU[row.name] ?? row.name,
      decidedCount: row.decidedCount,
      wins: row.wins,
      winRate: row.winRate,
      before,
      after,
      changed: Math.abs(after - before) >= 0.01,
    });
  }
  // Сначала те, что реально изменятся, затем по размеру выборки — так
  // предпросмотр сразу показывает самое важное сверху, а не сортируется
  // так, что "без изменений" вперемешку с реальными правками.
  return suggestions.sort((a, b) => {
    if (a.changed !== b.changed) return a.changed ? -1 : 1;
    return b.decidedCount - a.decidedCount;
  });
}

/** Превращает предпросмотр в объект для applyReliabilityMultiplierUpdatesForSymbol. */
export function toMultiplierUpdates(
  suggestions: ReliabilitySuggestion[],
): Partial<Record<PatternName, number>> {
  const updates: Partial<Record<PatternName, number>> = {};
  for (const s of suggestions) {
    updates[s.name] = s.after;
  }
  return updates;
}
