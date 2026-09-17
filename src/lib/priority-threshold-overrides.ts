import { THRESHOLD_GRID_MIN, THRESHOLD_GRID_MAX } from './threshold-calibration';

// ---------------------------------------------------------------------------
// Этап 4 плана калибровки. КРИТИЧЕСКИЙ НАЙДЕННЫЙ КОНФЛИКТ (см. changelog):
// priorityThreshold в этом приложении хранится ГЛОБАЛЬНО, одним полем в
// settingsStore.ts (один слайдер на все инструменты) — в отличие от
// калибровочной ML-модели (Этап 1) и PATTERN_RELIABILITY_MULTIPLIER
// (Этап 2), которые уже per-symbol. Если бы Этап 4 подобрал "оптимальный
// порог по данным BTCUSDT" и применил его через settingsStore напрямую —
// это воспроизвело бы ровно тот же класс бага, что уже дважды находили и
// чинили в этом проекте (калибровка одного инструмента молча утекает в
// остальные), только на новом поле.
//
// Решение — этот модуль: per-symbol override-слой для priorityThreshold,
// АРХИТЕКТУРНО ИДЕНТИЧНЫЙ секции "per-symbol reliability overrides" в
// src/lib/pattern-categories.ts, но для одного числа вместо
// Partial<Record<PatternName, number>>. Глобальный priorityThreshold в
// settingsStore.ts НЕ убирается и не меняет поведение — он остаётся общим
// дефолтом (fallback) для любого символа без собственного override, точно
// так же, как PATTERN_RELIABILITY_MULTIPLIER остаётся общим дефолтом для
// getReliabilityMultiplier().
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = 'priority-threshold-symbol-v1:';

// In-memory кэш per-symbol overrides, лениво подгружаемый из localStorage по
// первому обращению к конкретному symbolId — не сканируем localStorage
// целиком на старте (число торгуемых символов заранее неизвестно). Тот же
// паттерн, что symbolReliabilityOverrides в pattern-categories.ts.
const symbolOverrides = new Map<string, number>();

function storageKey(symbolId: string): string {
  return `${STORAGE_PREFIX}${symbolId}`;
}

function clampThreshold(value: number): number {
  return Math.min(THRESHOLD_GRID_MAX, Math.max(THRESHOLD_GRID_MIN, value));
}

function readLocalStorageSafely(key: string): string | null {
  // localStorage может отсутствовать (SSR/тестовое окружение без jsdom) или
  // бросать (приватный режим Safari, квота) — в обоих случаях ведём себя
  // как будто персистентных данных просто нет, не роняя импорт модуля. Тот
  // же паттерн, что в pattern-categories.ts.
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorageSafely(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {
    // Не блокируем применение override в памяти на время текущей сессии,
    // если запись на диск не удалась.
  }
}

function removeLocalStorageSafely(key: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(key);
  } catch {
    // no-op — см. writeLocalStorageSafely
  }
}

function loadFromStorage(symbolId: string): number | undefined {
  const raw = readLocalStorageSafely(storageKey(symbolId));
  if (raw === null) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return clampThreshold(parsed);
}

function getSymbolOverride(symbolId: string): number | undefined {
  if (symbolOverrides.has(symbolId)) return symbolOverrides.get(symbolId);
  const loaded = loadFromStorage(symbolId);
  if (loaded !== undefined) symbolOverrides.set(symbolId, loaded);
  return loaded;
}

/**
 * Эффективный priorityThreshold для инструмента: per-symbol override, если
 * он есть, иначе globalDefault (переданный вызывающим кодом —
 * useSettingsStore.getState().priorityThreshold). Этот модуль НЕ импортирует
 * settingsStore напрямую (избегаем циклического импорта stores↔lib и держим
 * модуль тестируемым без React/Zustand) — тот же принцип, что и у
 * getReliabilityMultiplier() в pattern-categories.ts.
 */
export function effectivePriorityThresholdForSymbol(symbolId: string, globalDefault: number): number {
  return getSymbolOverride(symbolId) ?? globalDefault;
}

export function hasPriorityThresholdOverride(symbolId: string): boolean {
  return getSymbolOverride(symbolId) !== undefined;
}

/** Применяет новый порог ТОЛЬКО к указанному инструменту и сохраняет его в
 *  localStorage под ключом, привязанным к symbolId — другие инструменты не
 *  затрагиваются. */
export function applyPriorityThresholdOverrideForSymbol(symbolId: string, value: number): void {
  const clamped = clampThreshold(value);
  symbolOverrides.set(symbolId, clamped);
  writeLocalStorageSafely(storageKey(symbolId), String(clamped));
}

/** Сбрасывает override только для указанного инструмента — он возвращается
 *  к общему дефолту (globalDefault), другие откалиброванные инструменты не
 *  затрагиваются. */
export function resetPriorityThresholdOverrideForSymbol(symbolId: string): void {
  symbolOverrides.delete(symbolId);
  removeLocalStorageSafely(storageKey(symbolId));
}
