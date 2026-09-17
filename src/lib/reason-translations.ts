import type { PatternName } from '@/types/domain';
import { PATTERN_LABELS_RU } from '@/lib/pattern-categories';

/**
 * Переводит английские фрагменты signal.reason (например
 * "BOS bullish; RSI oversold (28.4); order-block-continuation pattern (72%)")
 * в русские, понятные пользователю строки. Источник данных — исходные
 * тексты из src/decision/direction-prediction.ts и
 * src/decision/signal-filters.ts, которые НЕ переводятся на месте (покрыты
 * юнит-тестами на английские подстроки) — русификация только на этом,
 * UI-уровне.
 *
 * Правило, под которое не подошёл фрагмент, возвращает фрагмент как есть —
 * информация никогда не теряется.
 */
interface ReasonRule {
  /** Регулярка для сопоставления одного фрагмента reason (уже без "; "). */
  pattern: RegExp;
  /** Строит русский текст по результату match(). */
  translate: (match: RegExpMatchArray) => string;
}

const OB_TOUCH_COUNT_RE = /\((\d+)\s*touch(?:es)?\)/;
const FUSION_COUNT_RE = /\+\s*(\d+)\s*confirming pattern/;

export const REASON_TRANSLATION_RULES: readonly ReasonRule[] = [
  { pattern: /^BOS bullish$/, translate: () => 'Слом структуры вверх (BOS)' },
  { pattern: /^BOS bearish$/, translate: () => 'Слом структуры вниз (BOS)' },
  { pattern: /^CHoCH bullish$/, translate: () => 'Смена характера тренда вверх (CHoCH)' },
  { pattern: /^CHoCH bearish$/, translate: () => 'Смена характера тренда вниз (CHoCH)' },
  {
    pattern: /^RSI oversold \(([\d.]+)\)$/,
    translate: (m) => `RSI в зоне перепроданности (${m[1]})`,
  },
  {
    pattern: /^RSI overbought \(([\d.]+)\)$/,
    translate: (m) => `RSI в зоне перекупленности (${m[1]})`,
  },
  { pattern: /^EMA fast above slow$/, translate: () => 'Быстрая EMA выше медленной (восходящий тренд)' },
  { pattern: /^EMA fast below slow$/, translate: () => 'Быстрая EMA ниже медленной (нисходящий тренд)' },
  { pattern: /^MACD histogram positive$/, translate: () => 'Гистограмма MACD положительная' },
  { pattern: /^MACD histogram negative$/, translate: () => 'Гистограмма MACD отрицательная' },
  { pattern: /^Price at lower Bollinger band$/, translate: () => 'Цена у нижней границы Боллинджера' },
  { pattern: /^Price at upper Bollinger band$/, translate: () => 'Цена у верхней границы Боллинджера' },
  {
    // "Untouched bullish OB nearby" / "Tested bearish OB holding (3 touches)" и т.п.
    pattern: /^(Untouched|Tested) (bullish|bearish) OB.*$/,
    translate: (m) => {
      const state = m[1] === 'Untouched' ? 'Непротестированный' : 'Протестированный';
      const direction = m[2] === 'bullish' ? 'бычий' : 'медвежий';
      const touchMatch = m[0].match(OB_TOUCH_COUNT_RE);
      const touches = touchMatch ? ` (${touchMatch[1]} касан.)` : '';
      return `${state} ${direction} ордер-блок рядом${touches}`;
    },
  },
  { pattern: /FVG nearby$/, translate: () => 'Рядом непротестированный FVG' },
  { pattern: /liquidity pool nearby$/, translate: () => 'Рядом пул ликвидности' },
  { pattern: /^OBC strategy.*$/, translate: () => 'Подтверждение стратегией Order Block Continuation' },
  { pattern: /^MDM strategy.*$/, translate: () => 'Подтверждение стратегией MACD Deceleration' },
  { pattern: /^FVG Nested strategy.*$/, translate: () => 'Подтверждение стратегией "Вложенный FVG"' },
  { pattern: /^FVG Breaker Block strategy.*$/, translate: () => 'Подтверждение стратегией "FVG + Брейкер-блок"' },
  { pattern: /^FVG Rejection strategy.*$/, translate: () => 'Подтверждение стратегией "Отбой от границы FVG"' },
  { pattern: /^FVG Return strategy.*$/, translate: () => 'Подтверждение стратегией "Возврат к FVG"' },
  { pattern: /^OB Nested strategy.*$/, translate: () => 'Подтверждение стратегией "Вложенный ордер-блок"' },
  { pattern: /^OB Breaker Block strategy.*$/, translate: () => 'Подтверждение стратегией "Брейкер-блок ордер-блока"' },
  { pattern: /^Harmonic Pattern strategy.*$/, translate: () => 'Подтверждение гармоническим паттерном' },
  {
    // "gartley harmonic strategy (+0.50)" / "butterfly harmonic strategy (+0.50)" и т.д.
    // harmonicType различает Gartley/Bat/Crab/Butterfly/AB=CD (audit rec. #3).
    pattern: /^(gartley|bat|crab|butterfly|ab-cd) harmonic strategy.*$/,
    translate: (m) => {
      const labels: Record<string, string> = {
        gartley: 'Гартли',
        bat: 'Летучая мышь',
        crab: 'Краб',
        butterfly: 'Бабочка',
        'ab-cd': 'AB=CD',
      };
      return `Подтверждение гармоническим паттерном «${labels[m[1]] ?? m[1]}»`;
    },
  },
  {
    // "order-block-continuation pattern (72%)" / "hammer pattern (65%) + 2 confirming patterns"
    pattern: /^(.+) pattern \((\d+)%\)(.*)$/,
    translate: (m) => {
      const label = PATTERN_LABELS_RU[m[1] as PatternName] ?? m[1];
      let result = `Паттерн "${label}" (${m[2]}% уверенности)`;
      const fusionMatch = m[3].match(FUSION_COUNT_RE);
      if (fusionMatch) {
        result += ` + ещё ${fusionMatch[1]} подтверждающих паттерна`;
      }
      return result;
    },
  },
];

/**
 * Разбивает reason по '; ' и переводит каждый фрагмент. Фрагменты, не
 * подошедшие ни под одно правило, возвращаются без изменений.
 */
export function translateReason(reason: string): string[] {
  if (!reason) return [];
  return reason.split('; ').map((rawFragment) => {
    const fragment = rawFragment.trim();
    for (const rule of REASON_TRANSLATION_RULES) {
      const match = fragment.match(rule.pattern);
      if (match) return rule.translate(match);
    }
    return fragment;
  });
}
