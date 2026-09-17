import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  STRATEGY_PATTERNS,
  PATTERN_LABELS_RU,
  patternCategory,
  PATTERN_RELIABILITY_MULTIPLIER,
  RELIABILITY_MULTIPLIER_MIN,
  RELIABILITY_MULTIPLIER_MAX,
  getReliabilityMultiplier,
  effectiveReliabilityOverridesForSymbol,
  applyReliabilityMultiplierUpdatesForSymbol,
  resetReliabilityOverridesForSymbol,
} from './pattern-categories';
import { ALL_PATTERNS } from '@/stores/settingsStore';
import type { PatternName } from '@/types/domain';

describe('patternCategory', () => {
  it('classifies every entry of STRATEGY_PATTERNS as "strategy"', () => {
    for (const name of STRATEGY_PATTERNS) {
      expect(patternCategory(name)).toBe('strategy');
    }
  });

  it('classifies classic candlestick patterns as "pattern"', () => {
    const classicSamples: PatternName[] = [
      'hammer',
      'doji',
      'bullish-engulfing',
      'morning-star',
      'three-white-soldiers',
      'falling-three-methods',
    ];
    for (const name of classicSamples) {
      expect(patternCategory(name)).toBe('pattern');
    }
  });

  it('classifies every pattern from ALL_PATTERNS as either pattern or strategy, matching STRATEGY_PATTERNS membership', () => {
    for (const name of ALL_PATTERNS) {
      const expected = STRATEGY_PATTERNS.includes(name) ? 'strategy' : 'pattern';
      expect(patternCategory(name)).toBe(expected);
    }
  });
});

describe('PATTERN_LABELS_RU', () => {
  it('has a non-empty Russian label for every pattern in ALL_PATTERNS', () => {
    for (const name of ALL_PATTERNS) {
      expect(PATTERN_LABELS_RU[name]).toBeTruthy();
      expect(typeof PATTERN_LABELS_RU[name]).toBe('string');
    }
  });

  it('has a label for every STRATEGY_PATTERNS entry', () => {
    for (const name of STRATEGY_PATTERNS) {
      expect(PATTERN_LABELS_RU[name]).toBeTruthy();
    }
  });
});

// ЧИСТКА (найдено независимой проверкой качества Этапов 1-3, 2026-09-08):
// applyReliabilityMultiplierUpdates()/resetReliabilityOverrides() (глобальные,
// не per-symbol мутаторы) были удалены из pattern-categories.ts — с тех пор
// как CalibrationPanel.tsx переключился на per-symbol API, ни один
// продакшен-код их не вызывал; они оставались только тестируемыми сами
// собой, создавая иллюзию, что это ещё действующий путь применения. Их
// тесты удалены вместе с ними (см. CHANGES_APPLIED_CALIBRATION_STAGE2_5_REVIEW_CLEANUP_20260908.md).
//
// Единственное поведение читающей стороны (loadPersistedReliabilityOverrides,
// вызывается один раз при импорте модуля), которое стоило сохранить и
// одеть тестом — обратная совместимость: если у пользователя в браузере
// уже лежит override, сохранённый ДО появления per-symbol слоя (тем самым
// удалённым сейчас applyReliabilityMultiplierUpdates()), он должен
// по-прежнему подхватываться как общий дефолт при следующей загрузке
// страницы, а не молча теряться. Проверяется через переимпорт модуля
// (vi.resetModules), т.к. чтение происходит один раз при первом импорте.
describe('legacy global reliability override (backward compatibility)', () => {
  const LEGACY_KEY = 'pattern-reliability-multiplier-v1';

  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('picks up a pre-per-symbol override already saved in localStorage as the new module-load default', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ doji: 1.25 }));
    const fresh = await import('./pattern-categories');
    expect(fresh.PATTERN_RELIABILITY_MULTIPLIER.doji).toBe(1.25);
  });

  it('ignores a malformed legacy value without throwing on import and falls back to the hand-written default', async () => {
    localStorage.setItem(LEGACY_KEY, 'not json');
    const fresh = await import('./pattern-categories');
    expect(fresh.PATTERN_RELIABILITY_MULTIPLIER['inside-bar']).toBe(0.1);
  });
});

// FIX (аудит калибровки Этапа 2, п.4 — "PATTERN_RELIABILITY_MULTIPLIER
// остался глобальным, не per-symbol"): калибровка одного инструмента больше
// не должна влиять на другой.
describe('per-symbol reliability overrides', () => {
  // Этап "чистки осиротевшего API" (2026-09-08) убрал
  // applyReliabilityMultiplierUpdates()/resetReliabilityOverrides()
  // (глобальные мутаторы) — там, где тестам ниже нужен "глобальный дефолт"
  // для сравнения с per-symbol override, он выставляется прямой мутацией
  // PATTERN_RELIABILITY_MULTIPLIER (он и так был обычным экспортируемым
  // мутируемым объектом, direction-prediction.ts/getReliabilityMultiplier
  // читают его "живьём") — со снимком/восстановлением до и после каждого
  // теста, чтобы не утекать между тестами (тот же object identity, что
  // используется в проде).
  let globalSnapshot: Partial<Record<PatternName, number>>;

  beforeEach(() => {
    globalSnapshot = { ...PATTERN_RELIABILITY_MULTIPLIER };
    resetReliabilityOverridesForSymbol('BTCUSDT');
    resetReliabilityOverridesForSymbol('EURUSD');
  });

  afterEach(() => {
    for (const key of Object.keys(PATTERN_RELIABILITY_MULTIPLIER)) {
      delete PATTERN_RELIABILITY_MULTIPLIER[key as PatternName];
    }
    Object.assign(PATTERN_RELIABILITY_MULTIPLIER, globalSnapshot);
    resetReliabilityOverridesForSymbol('BTCUSDT');
    resetReliabilityOverridesForSymbol('EURUSD');
    localStorage.clear();
  });

  it('getReliabilityMultiplier falls back to the global default when no symbolId is given (backward compatibility)', () => {
    PATTERN_RELIABILITY_MULTIPLIER.doji = 1.3;
    expect(getReliabilityMultiplier('doji')).toBe(1.3);
  });

  it('getReliabilityMultiplier falls back to the global default when the symbol has no override', () => {
    PATTERN_RELIABILITY_MULTIPLIER.doji = 1.3;
    expect(getReliabilityMultiplier('doji', 'BTCUSDT')).toBe(1.3);
  });

  it('a per-symbol override does not leak into another symbol', () => {
    applyReliabilityMultiplierUpdatesForSymbol('BTCUSDT', { doji: 1.5 });
    expect(getReliabilityMultiplier('doji', 'BTCUSDT')).toBe(1.5);
    // EURUSD must be unaffected by BTCUSDT's calibration.
    expect(getReliabilityMultiplier('doji', 'EURUSD')).toBe(1);
    // ...and calling without a symbolId at all must also be unaffected.
    expect(getReliabilityMultiplier('doji')).toBe(1);
  });

  it('a per-symbol override takes priority over the global default for that symbol only', () => {
    PATTERN_RELIABILITY_MULTIPLIER.doji = 0.8; // global default
    applyReliabilityMultiplierUpdatesForSymbol('BTCUSDT', { doji: 1.5 }); // BTCUSDT-specific
    expect(getReliabilityMultiplier('doji', 'BTCUSDT')).toBe(1.5);
    expect(getReliabilityMultiplier('doji', 'EURUSD')).toBe(0.8);
  });

  it('clamps per-symbol updates to [RELIABILITY_MULTIPLIER_MIN, RELIABILITY_MULTIPLIER_MAX]', () => {
    applyReliabilityMultiplierUpdatesForSymbol('BTCUSDT', { doji: 99, hammer: -5 });
    expect(getReliabilityMultiplier('doji', 'BTCUSDT')).toBe(RELIABILITY_MULTIPLIER_MAX);
    expect(getReliabilityMultiplier('hammer', 'BTCUSDT')).toBe(RELIABILITY_MULTIPLIER_MIN);
  });

  it('resetReliabilityOverridesForSymbol reverts only that symbol to the global default', () => {
    applyReliabilityMultiplierUpdatesForSymbol('BTCUSDT', { doji: 1.5 });
    applyReliabilityMultiplierUpdatesForSymbol('EURUSD', { doji: 0.6 });
    resetReliabilityOverridesForSymbol('BTCUSDT');
    expect(getReliabilityMultiplier('doji', 'BTCUSDT')).toBe(1);
    expect(getReliabilityMultiplier('doji', 'EURUSD')).toBe(0.6);
  });

  it('effectiveReliabilityOverridesForSymbol merges the global default with the symbol override', () => {
    PATTERN_RELIABILITY_MULTIPLIER.doji = 0.9;
    PATTERN_RELIABILITY_MULTIPLIER.hammer = 0.7;
    applyReliabilityMultiplierUpdatesForSymbol('BTCUSDT', { doji: 1.5 });
    const effective = effectiveReliabilityOverridesForSymbol('BTCUSDT');
    expect(effective.doji).toBe(1.5); // symbol override wins
    expect(effective.hammer).toBe(0.7); // falls back to global default
  });

  it('persists per-symbol overrides in localStorage under a symbol-scoped key', () => {
    applyReliabilityMultiplierUpdatesForSymbol('BTCUSDT', { doji: 1.2 });
    const raw = localStorage.getItem('pattern-reliability-multiplier-symbol-v1:BTCUSDT');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).doji).toBe(1.2);
    // Must not have written under the EURUSD-scoped key.
    expect(localStorage.getItem('pattern-reliability-multiplier-symbol-v1:EURUSD')).toBeNull();
  });
});
