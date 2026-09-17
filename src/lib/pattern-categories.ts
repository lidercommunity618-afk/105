import type { PatternName } from '@/types/domain';

/**
 * Комплексные многофакторные детекторы, которые по своей сути являются
 * торговыми стратегиями (в отличие от классических свечных паттернов).
 * Список должен быть подмножеством ALL_PATTERNS из src/stores/settingsStore.ts.
 */
export const STRATEGY_PATTERNS: readonly PatternName[] = [
  'impulse-breakout',
  'consolidation-breakout',
  'liquidity-sweep',
  'liquidity-sweep-reaction',
  'mean-reversion',
  'strong-order-block-reaction',
  'order-block-continuation',
  'macd-deceleration-continuation',
  'fvg-return',
  'fvg-breaker-block',
  'fvg-nested',
  'fvg-rejection',
  'order-block-breaker',
  'order-block-nested',
  'harmonic-pattern',
];

export type PatternCategory = 'pattern' | 'strategy';

/**
 * Всё, что не входит в STRATEGY_PATTERNS, но есть в PatternName
 * (то есть классические свечные паттерны), автоматически считается
 * категорией 'pattern'.
 */
export function patternCategory(name: PatternName): PatternCategory {
  return STRATEGY_PATTERNS.includes(name) ? 'strategy' : 'pattern';
}

// BUGFIX (аудит 2026-09-06, п.4 "двойной учёт одного и того же паттерна"):
// эти паттерны получают персональный strategy-бонус в signal-builder.ts
// (evaluateEvidence), масштабированный под confidence по весам из
// исходного стратегического документа (например 0.55 для OBC, 0.65 для
// FVG Nested) — это их единственный источник истины для вклада в score.
// direction-prediction.ts раньше ДОПОЛНИТЕЛЬНО считал то же самое
// обнаружение как обычный components.trigger (общий вес 1.5 для любого
// паттерна) — то есть одно обнаружение давало два независимых вклада в
// один и тот же score. Реальный пример: сделка SELL 79733.00, 2026-09-05
// 20:15 — order-block-continuation pattern (100%) дал -1.00 как trigger И
// +0.55 как "OBC strategy" бонус, что раздуло score до 6.1 и протащило
// сигнал сквозь regime-штраф. Для паттернов из этого списка
// components.trigger теперь обнуляется в direction-prediction.ts — см.
// использование STRATEGY_BONUS_PATTERNS там же.
export const STRATEGY_BONUS_PATTERNS: readonly PatternName[] = [
  'order-block-continuation',
  'macd-deceleration-continuation',
  'fvg-nested',
  'fvg-breaker-block',
  'fvg-rejection',
  'fvg-return',
  'order-block-nested',
  'order-block-breaker',
  'impulse-breakout',
  'liquidity-sweep-reaction',
  'harmonic-pattern',
];

// BUGFIX (факторный анализ 5 убыточных сделок BTCUSDT M1, 06:26-06:48 UTC):
// эмпирические множители надёжности по факторной таблице (винрейт по
// резолвнутым сделкам). 1.0 = без изменений. Это ручной, временный override
// до готовности ML-калибровки (CalibrationModel.isReady(), MIN_SAMPLES=100
// per instrument) — обновлять по мере накопления новых данных.
export const PATTERN_RELIABILITY_MULTIPLIER: Partial<Record<PatternName, number>> = {
  'inside-bar': 0.1, // 27% винрейт, N=19 — фактически отключаем как триггер,
                      // не убираем из детектора совсем (остаётся видимым в
                      // rejectedPatterns/факторах для постмортема)
};

// Этап 2 плана калибровки ("связать computeFactorStats() с
// PATTERN_RELIABILITY_MULTIPLIER"): границы клампа для автоматически
// пересчитанного множителя — те же, что заданы в исходном плане
// (0.1..1.5). Вынесены сюда (а не в src/ui/factor-analytics.ts или
// отдельный calibration-модуль), чтобы избежать циклического импорта:
// src/lib/pattern-reliability-calibration.ts читает их отсюда же, откуда
// читает и сам PATTERN_RELIABILITY_MULTIPLIER.
export const RELIABILITY_MULTIPLIER_MIN = 0.1;
export const RELIABILITY_MULTIPLIER_MAX = 1.5;

const RELIABILITY_OVERRIDE_STORAGE_KEY = 'pattern-reliability-multiplier-v1';

function clampReliabilityMultiplier(value: number): number {
  return Math.min(RELIABILITY_MULTIPLIER_MAX, Math.max(RELIABILITY_MULTIPLIER_MIN, value));
}

function readLocalStorageSafely(key: string): string | null {
  // localStorage может отсутствовать (SSR/тестовое окружение без jsdom) или
  // бросать (приватный режим Safari, квота) — в обоих случаях ведём себя
  // как будто персистентных данных просто нет, не роняя импорт модуля.
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
    // Не блокируем применение множителей в памяти на время текущей сессии,
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

// ЧИСТКА (найдено независимой проверкой качества Этапов 1-3, 2026-09-08):
// раньше здесь читался ключ, в который писала applyReliabilityMultiplierUpdates()
// — функция для глобального (не per-symbol) применения, мутировавшая
// PATTERN_RELIABILITY_MULTIPLIER целиком. Сама функция удалена вместе с
// парной resetReliabilityOverrides() (см. CHANGES_APPLIED_CALIBRATION_STAGE2_5_REVIEW_CLEANUP_20260908.md)
// — с тех пор как CalibrationPanel.tsx переключился на per-symbol API
// (applyReliabilityMultiplierUpdatesForSymbol и т.д. — см. блок "per-symbol
// reliability overrides" ниже), ни один продакшен-код больше не пишет в
// этот ключ. Чтение оставлено НАВСЕГДА (не только временно) — это
// backward-compat путь для пользователей, которые нажимали "Применить" ДО
// появления per-symbol слоя: их уже сохранённый в браузере глобальный
// override должен по-прежнему подхватываться как общий дефолт (то, к чему
// откатывается любой инструмент, у которого нет своего собственного
// per-symbol override), а не молча потеряться.
function loadPersistedReliabilityOverrides(): Partial<Record<PatternName, number>> {
  const raw = readLocalStorageSafely(RELIABILITY_OVERRIDE_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Partial<Record<PatternName, number>> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        result[name as PatternName] = clampReliabilityMultiplier(value);
      }
    }
    return result;
  } catch {
    return {};
  }
}

// Применяем персистентные пересчёты (если пользователь уже нажимал
// "Применить" в ДОПЕРСИМВОЛЬНОЙ версии Этапа 2) ПОВЕРХ ручных дефолтов
// выше — иначе "самообучение по факторам" молча откатывалось бы к ручным
// цифрам при каждой перезагрузке страницы для тех, кто уже успел им
// воспользоваться до появления per-symbol слоя.
Object.assign(PATTERN_RELIABILITY_MULTIPLIER, loadPersistedReliabilityOverrides());

// ---------------------------------------------------------------------------
// FIX (аудит калибровки Этапа 2, п.4 — "множитель глобальный, не per-symbol"):
// PATTERN_RELIABILITY_MULTIPLIER выше остаётся как есть — это ручной/базовый
// дефолт, общий для всех инструментов (в т.ч. для существующих тестов и
// direction-prediction.ts, если вызывающий код не передал symbolId — полная
// обратная совместимость, ничего из старого поведения не убрано).
//
// Поверх него добавляется per-symbol слой overrides: если для конкретного
// symbolId нажали "Калибровать" в CalibrationPanel, новый множитель
// применяется ТОЛЬКО к этому инструменту, а не глобально ко всем — это и
// была суть замечания (калибровка на BTCUSDT больше не искажает сигналы по
// EURUSD). Не найден в per-symbol карте — используется общий дефолт выше,
// как и раньше.
// ---------------------------------------------------------------------------

const SYMBOL_RELIABILITY_OVERRIDE_STORAGE_PREFIX = 'pattern-reliability-multiplier-symbol-v1:';

// In-memory кэш per-symbol overrides, лениво подгружаемый из localStorage по
// первому обращению к конкретному symbolId — не сканируем localStorage
// целиком на старте (число торгуемых символов заранее неизвестно).
const symbolReliabilityOverrides = new Map<string, Partial<Record<PatternName, number>>>();

function symbolStorageKey(symbolId: string): string {
  return `${SYMBOL_RELIABILITY_OVERRIDE_STORAGE_PREFIX}${symbolId}`;
}

function loadSymbolOverridesFromStorage(symbolId: string): Partial<Record<PatternName, number>> {
  const raw = readLocalStorageSafely(symbolStorageKey(symbolId));
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Partial<Record<PatternName, number>> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        result[name as PatternName] = clampReliabilityMultiplier(value);
      }
    }
    return result;
  } catch {
    return {};
  }
}

function getSymbolOverrides(symbolId: string): Partial<Record<PatternName, number>> {
  let overrides = symbolReliabilityOverrides.get(symbolId);
  if (overrides === undefined) {
    overrides = loadSymbolOverridesFromStorage(symbolId);
    symbolReliabilityOverrides.set(symbolId, overrides);
  }
  return overrides;
}

/**
 * Множитель надёжности для конкретного паттерна на конкретном инструменте:
 * per-symbol override, если он есть, иначе общий дефолт
 * (PATTERN_RELIABILITY_MULTIPLIER), иначе 1 (без изменений). symbolId
 * опционален и по умолчанию отсутствует — вызывающий код (существующие
 * тесты, старые вызовы direction-prediction.ts) без изменений продолжает
 * получать общий дефолт, как и раньше.
 */
export function getReliabilityMultiplier(name: PatternName, symbolId?: string): number {
  if (symbolId) {
    const perSymbol = getSymbolOverrides(symbolId)[name];
    if (perSymbol !== undefined) return perSymbol;
  }
  return PATTERN_RELIABILITY_MULTIPLIER[name] ?? 1;
}

/**
 * Эффективные overrides для инструмента — общий дефолт, перекрытый
 * per-symbol значениями там, где они заданы. Используется как "before" в
 * предпросмотре "было/станет" в CalibrationPanel.tsx, чтобы предпросмотр
 * отражал то, что реально применяется к ЭТОМУ инструменту, а не глобальный
 * дефолт, который мог быть перекрыт ранее для другого символа.
 */
export function effectiveReliabilityOverridesForSymbol(symbolId: string): Partial<Record<PatternName, number>> {
  return { ...PATTERN_RELIABILITY_MULTIPLIER, ...getSymbolOverrides(symbolId) };
}

/**
 * Применяет пересчитанные множители ТОЛЬКО к указанному инструменту и
 * сохраняет их в localStorage под ключом, привязанным к symbolId — другие
 * инструменты не затрагиваются. Единственный путь применения "было/станет"
 * из CalibrationPanel.tsx — глобальный, не-per-symbol эквивалент этой
 * функции удалён (см. чистку осиротевшего API выше, "ЧИСТКА" у
 * loadPersistedReliabilityOverrides).
 */
export function applyReliabilityMultiplierUpdatesForSymbol(
  symbolId: string,
  updates: Partial<Record<PatternName, number>>,
): void {
  const current = { ...getSymbolOverrides(symbolId) };
  for (const [name, value] of Object.entries(updates)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      current[name as PatternName] = clampReliabilityMultiplier(value);
    }
  }
  symbolReliabilityOverrides.set(symbolId, current);
  writeLocalStorageSafely(symbolStorageKey(symbolId), JSON.stringify(current));
}

/**
 * Сбрасывает per-symbol overrides только для указанного инструмента —
 * инструмент возвращается к общему дефолту (PATTERN_RELIABILITY_MULTIPLIER),
 * другие откалиброванные инструменты не затрагиваются.
 */
export function resetReliabilityOverridesForSymbol(symbolId: string): void {
  symbolReliabilityOverrides.set(symbolId, {});
  removeLocalStorageSafely(symbolStorageKey(symbolId));
}

/** Русский словарь имён паттернов/стратегий для отображения в UI. */
export const PATTERN_LABELS_RU: Record<PatternName, string> = {
  // классические свечные паттерны
  hammer: 'Молот',
  'shooting-star': 'Падающая звезда',
  doji: 'Доджи',
  'pin-bar': 'Пин-бар',
  'bullish-engulfing': 'Бычье поглощение',
  'bearish-engulfing': 'Медвежье поглощение',
  'bullish-harami': 'Бычье харами',
  'bearish-harami': 'Медвежье харами',
  'inside-bar': 'Внутренний бар',
  'morning-star': 'Утренняя звезда',
  'evening-star': 'Вечерняя звезда',
  'inverted-hammer': 'Перевёрнутый молот',
  'hanging-man': 'Повешенный',
  'marubozu-bullish': 'Бычий марубозу',
  'marubozu-bearish': 'Медвежий марубозу',
  'spinning-top': 'Волчок',
  'piercing-line': 'Просвет в облаках',
  'dark-cloud-cover': 'Завеса из тёмных облаков',
  'tweezer-bottom': 'Пинцет (дно)',
  'tweezer-top': 'Пинцет (вершина)',
  'three-white-soldiers': 'Три белых солдата',
  'three-black-crows': 'Три чёрные вороны',
  'abandoned-baby-bottom': 'Брошенный ребёнок (дно)',
  'abandoned-baby-top': 'Брошенный ребёнок (вершина)',
  'rising-three-methods': 'Растущие три метода',
  'falling-three-methods': 'Падающие три метода',
  // стратегии (STRATEGY_PATTERNS)
  'impulse-breakout': 'Импульсный пробой',
  'consolidation-breakout': 'Пробой консолидации',
  'liquidity-sweep': 'Снятие ликвидности',
  'liquidity-sweep-reaction': 'Реакция на снятие ликвидности',
  'mean-reversion': 'Возврат к среднему',
  'strong-order-block-reaction': 'Сильная реакция от ордер-блока',
  'order-block-continuation': 'Продолжение от ордер-блока',
  'macd-deceleration-continuation': 'Замедление MACD с продолжением',
  // Стратегии на FVG (Strategies A-D из источника)
  'fvg-return': 'Возврат к FVG',
  'fvg-breaker-block': 'FVG + Брейкер-блок',
  'fvg-nested': 'Вложенный FVG',
  'fvg-rejection': 'Отбой от границы FVG',
  // OB Breaker Block / Nested OB — те же концепции, что и пара выше, но
  // применённые к Order Block (breakerBlocks/orderBlocks из smart-money.ts),
  // а не к FVG.
  'order-block-breaker': 'Брейкер-блок ордер-блока',
  'order-block-nested': 'Вложенный ордер-блок',
  // Гармонические паттерны (Gartley, Butterfly, AB=CD) — единый PatternName
  // 'harmonic-pattern' с полем harmonicType внутри PatternResult различает
  // конкретный тип геометрии (см. domain.ts).
  'harmonic-pattern': 'Гармонический паттерн',
};
