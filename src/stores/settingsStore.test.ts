import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ALL_PATTERNS, useSettingsStore } from './settingsStore';
import type { PatternName } from '@/types/domain';
import { DEFAULT_INDICATOR_CONFIG } from '@/types/domain';

// Patterns intentionally NOT exposed as a UI toggle in ALL_PATTERNS. Empty
// today — every implemented pattern is meant to be toggleable. If a pattern
// is ever deliberately kept out of the settings UI, add it here with a
// comment explaining why, instead of just leaving it out of ALL_PATTERNS —
// an unexplained gap is exactly the regression this file guards against
// (see audit: 11 fully-implemented, fully-tested patterns were unreachable
// from the UI because ALL_PATTERNS never listed them).
const EXCLUDED_FROM_ALL_PATTERNS: readonly PatternName[] = [];

// Exhaustiveness map: one key per PatternName. If `PatternName` in
// src/types/domain.ts ever gains a new member without a corresponding key
// added here, this file fails to type-check (`npm run typecheck`) — that
// compile-time guarantee is what actually prevents the drift, independent of
// whether anyone remembers to update ALL_PATTERNS or run this test.
const PATTERN_NAME_COVERAGE: Record<PatternName, true> = {
  'hammer': true,
  'shooting-star': true,
  'doji': true,
  'pin-bar': true,
  'bullish-engulfing': true,
  'bearish-engulfing': true,
  'bullish-harami': true,
  'bearish-harami': true,
  'inside-bar': true,
  'morning-star': true,
  'evening-star': true,
  'impulse-breakout': true,
  'consolidation-breakout': true,
  'liquidity-sweep': true,
  'liquidity-sweep-reaction': true,
  'mean-reversion': true,
  'strong-order-block-reaction': true,
  'order-block-continuation': true,
  'macd-deceleration-continuation': true,
  'fvg-return': true,
  'fvg-breaker-block': true,
  'fvg-nested': true,
  'fvg-rejection': true,
  'order-block-breaker': true,
  'order-block-nested': true,
  'inverted-hammer': true,
  'hanging-man': true,
  'marubozu-bullish': true,
  'marubozu-bearish': true,
  'spinning-top': true,
  'piercing-line': true,
  'dark-cloud-cover': true,
  'tweezer-bottom': true,
  'tweezer-top': true,
  'three-white-soldiers': true,
  'three-black-crows': true,
  'abandoned-baby-bottom': true,
  'abandoned-baby-top': true,
  'rising-three-methods': true,
  'falling-three-methods': true,
  'harmonic-pattern': true,
};

describe('ALL_PATTERNS coverage', () => {
  it('includes every PatternName, or explicitly excludes it', () => {
    const allNames = Object.keys(PATTERN_NAME_COVERAGE) as PatternName[];
    const missing = allNames.filter(
      (name) => !ALL_PATTERNS.includes(name) && !EXCLUDED_FROM_ALL_PATTERNS.includes(name),
    );
    expect(missing).toEqual([]);
  });

  it('has no duplicate entries', () => {
    expect(new Set(ALL_PATTERNS).size).toBe(ALL_PATTERNS.length);
  });

  it('only lists names that are actually valid PatternName values', () => {
    const validNames = new Set(Object.keys(PATTERN_NAME_COVERAGE));
    const invalid = ALL_PATTERNS.filter((p) => !validNames.has(p));
    expect(invalid).toEqual([]);
  });
});

describe('useSettingsStore — version < 14 migration (harmonic-pattern module)', () => {
  const STORAGE_KEY = 'terminal-settings';
  let originalState: ReturnType<typeof useSettingsStore.getState>;

  beforeEach(() => {
    originalState = useSettingsStore.getState();
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    useSettingsStore.setState(originalState, true);
  });

  it('additively merges the 4 new harmonic indicator fields, showHarmonicPatterns, and a harmonic-pattern activePatterns entry into an old (v13) persisted state, without resetting the user\'s own pattern exclusions', async () => {
    // Пользователь на версии 13: уже сохранённый indicators без 4 новых
    // harmonic* полей, без showHarmonicPatterns вовсе, и уже осознанно
    // отключивший 'doji' в activePatterns (что не должно быть сброшено
    // аддитивным домерджем — тот же принцип, что и у version < 9).
    const oldActivePatterns = ALL_PATTERNS.filter((p) => p !== 'harmonic-pattern' && p !== 'doji');
    const oldPersisted = {
      state: {
        indicators: { atrPeriod: 14, emaFast: 9 },
        activePatterns: oldActivePatterns,
      },
      version: 13,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(oldPersisted));

    await useSettingsStore.persist.rehydrate();

    const state = useSettingsStore.getState();
    expect(state.indicators.harmonicMinLegAtr).toBe(DEFAULT_INDICATOR_CONFIG.harmonicMinLegAtr);
    expect(state.indicators.harmonicFibTolerancePct).toBe(DEFAULT_INDICATOR_CONFIG.harmonicFibTolerancePct);
    expect(state.indicators.harmonicHtfFactor).toBe(DEFAULT_INDICATOR_CONFIG.harmonicHtfFactor);
    expect(state.showHarmonicPatterns).toBe(true);
    expect(state.activePatterns).toContain('harmonic-pattern');
    // Ранее отключённый пользователем паттерн должен остаться отключённым —
    // это не полный реcет activePatterns к дефолту.
    expect(state.activePatterns).not.toContain('doji');
  });

  it('leaves an already-migrated (v14+) state untouched', async () => {
    const currentPersisted = {
      state: {
        indicators: { ...DEFAULT_INDICATOR_CONFIG, harmonicMinLegAtr: 2.5 },
        showHarmonicPatterns: false,
        activePatterns: [...ALL_PATTERNS],
      },
      version: 14,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(currentPersisted));

    await useSettingsStore.persist.rehydrate();

    const state = useSettingsStore.getState();
    // Значение, явно выставленное пользователем, не должно быть
    // перезатёрто дефолтом — миграция для version < 14 не должна выполняться
    // повторно для уже мигрированного состояния.
    expect(state.indicators.harmonicMinLegAtr).toBe(2.5);
    expect(state.showHarmonicPatterns).toBe(false);
  });
});
