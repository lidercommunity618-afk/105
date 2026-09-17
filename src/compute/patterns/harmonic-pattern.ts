import type {
  Candle,
  PatternResult,
  IndicatorSnapshot,
  MarketStructure,
  SignalDirection,
  SignalStrength,
  HarmonicPoint,
} from '@/types/domain';
import type { SessionRegime } from '@/compute/session-regime';
import { isHighLiquiditySession } from '@/compute/session-regime';
import type { SmartMoneyResult } from '@/compute/indicators/smart-money';
import { findHarmonicZigZagPoints, type ZigZagPoint } from '@/compute/indicators/zigzag';
import { atr } from '@/compute/indicators/atr';
import { intervalSeconds } from './pattern-context';
import { fvgAgeBars, pickFreshUnbrokenFvgs } from './fvg-strategies-shared';
import { pickFreshUnbrokenOrderBlocks } from './order-block-strategies-shared';

// ─────────────────────────────────────────────────────────────────────────
// Модуль "Гармонические паттерны": Gartley, Bat, Crab, Butterfly, AB=CD —
// один PatternName ('harmonic-pattern') на все 5 геометрий, различаемые
// полем harmonicType внутри PatternResult (по аналогии с setupType у
// liquidity-sweep-reaction), чтобы не плодить пятикратное дублирование во
// всех реестрах (settingsStore.ALL_PATTERNS, pattern-categories.ts,
// domain.ts PATTERN_NAMES/patternNameSchema и т.д.)
//
// Bat/Crab и конфлюэнс с OB/FVG на PRZ (см. checkPrzConfluence ниже)
// перенесены из параллельной реализации этого же модуля (детектор на базе
// buildZigzag()/findPivots()) при интеграции — тем же способом, что и
// остальные "structural" аудит-фиксы в этом семействе (structural SL/TP,
// freshness-гейт, пост-фактум инвалидация): переиспользуем уже проверенные
// в этом проекте конвенции (pickFreshUnbrokenFvgs/pickFreshUnbrokenOrderBlocks,
// "age < N bars" свежесть) вместо копирования чужой реализации как есть.
//
// Точки X-A-B-C-D берутся из ATR-адаптивного ZigZag на ресэмплированном
// старшем ТФ (см. zigzag.ts) — НЕ из findPivots() (там фиксированный
// PIVOT_LOOKUP=2, непригодный для 5-точечной геометрии на M1).
// ─────────────────────────────────────────────────────────────────────────

export interface HarmonicConfig {
  minLegAtr: number;
  fibTolerancePct: number;
  htfFactor: number;
}

// На случай вызова без конфига (напр. юнит-тесты) — тот же приём "optional
// параметр + `?? {дефолты}` внутри самого детектора", что уже используется
// в macd-deceleration-continuation.ts:102 для macdConfig. Значения совпадают
// с DEFAULT_INDICATOR_CONFIG в types/domain.ts.
const DEFAULT_HARMONIC_CONFIG: HarmonicConfig = {
  minLegAtr: 1.5,
  fibTolerancePct: 8,
  htfFactor: 5,
};

// Конфлюэнс PRZ с ещё живым (свежим, непробитым) OB/FVG того же
// направления — тот же порог свежести (в барах), что уже используют
// FVG/OB-семейства через pickFreshUnbrokenFvgs/pickFreshUnbrokenOrderBlocks
// (см. импорт выше), и такой же фиксированный бонус к confidence, как у
// параллельной реализации этого модуля. Не завязан на пользовательские
// настройки (как и остальные пороги свежести в этом семействе), чтобы не
// плодить ещё один слайдер в SettingsPanel.tsx ради одного множителя.
const CONFLUENCE_FRESHNESS_MAX_AGE_BARS = 20;
const CONFLUENCE_BONUS = 0.1;

function legLength(a: ZigZagPoint, b: ZigZagPoint): number {
  return Math.abs(b.price - a.price);
}

/**
 * Оценивает, насколько `actual` близко к диапазону [min, max] с учётом
 * допуска `tolerancePct` (% от границ диапазона) по обе стороны. Возвращает
 * null, если значение выходит за пределы допуска, иначе 1.0 внутри
 * "идеального" диапазона, плавно убывая к 0 у границ допуска.
 */
function scoreAgainstRange(actual: number, min: number, max: number, tolerancePct: number): number | null {
  const tolMin = min * (tolerancePct / 100);
  const tolMax = max * (tolerancePct / 100);
  const lo = min - tolMin;
  const hi = max + tolMax;
  if (actual < lo || actual > hi) return null;
  if (actual >= min && actual <= max) return 1;
  const dist = actual < min ? min - actual : actual - max;
  const tolSpan = actual < min ? tolMin : tolMax;
  return tolSpan > 0 ? Math.max(0, 1 - dist / tolSpan) : 1;
}

function scoreAgainstPoint(actual: number, ideal: number, tolerancePct: number): number | null {
  return scoreAgainstRange(actual, ideal, ideal, tolerancePct);
}

// Спецификация одной "ноги" геометрии XABCD: либо точный идеал (Gartley
// AB=0.618XA), либо диапазон (BC=0.382-0.886AB для всех 4 паттернов), либо
// "лучшее совпадение из нескольких идеалов" (Butterfly AD=1.27 ИЛИ 1.618
// XA — берём то значение, к которому actual ближе). Явные теги вместо
// перегрузки числового массива — чтобы диапазон [min,max] и список из 2
// альтернативных идеалов (тоже 2 числа) не перепутать местами.
type LegSpec =
  | { kind: 'point'; ideal: number }
  | { kind: 'range'; min: number; max: number }
  | { kind: 'bestOfPoints'; idealCandidates: number[] };

const point = (ideal: number): LegSpec => ({ kind: 'point', ideal });
const range = (min: number, max: number): LegSpec => ({ kind: 'range', min, max });
const bestOf = (...idealCandidates: number[]): LegSpec => ({ kind: 'bestOfPoints', idealCandidates });

function scoreLeg(actual: number, spec: LegSpec, tolerancePct: number): number | null {
  if (spec.kind === 'point') return scoreAgainstPoint(actual, spec.ideal, tolerancePct);
  if (spec.kind === 'range') return scoreAgainstRange(actual, spec.min, spec.max, tolerancePct);
  const scores = spec.idealCandidates.map((ideal) => scoreAgainstPoint(actual, ideal, tolerancePct));
  const valid = scores.filter((s): s is number => s !== null);
  return valid.length > 0 ? Math.max(...valid) : null;
}

type XabcdType = 'gartley' | 'bat' | 'crab' | 'butterfly';

interface XabcdRules {
  ab_xa: LegSpec;
  bc_ab: LegSpec;
  cd_bc: LegSpec;
  ad_xa: LegSpec;
}

// Коэффициенты Фибоначчи для 4 классических XABCD-паттернов (методология
// Carney, отраслевой стандарт). Gartley/Butterfly — уже проверенные в этом
// проекте значения (сохранены как есть, без изменений, чтобы не менять
// поведение уже работающего детектора). Bat/Crab добавлены при интеграции
// — по тем же общепринятым коэффициентам, что и в параллельной реализации
// этого модуля (harmonic-ratios.ts): Bat AB=0.382-0.5XA/AD=0.886XA,
// Crab AB=0.382-0.618XA/AD=1.618XA, у обоих BC=0.382-0.886AB (тот же
// диапазон, что уже используется для Gartley/Butterfly) и CD — расширение
// BC, специфичное для каждого паттерна.
const XABCD_RULES: Record<XabcdType, XabcdRules> = {
  gartley: {
    ab_xa: point(0.618),
    bc_ab: range(0.382, 0.886),
    cd_bc: range(1.13, 1.618),
    ad_xa: point(0.786),
  },
  bat: {
    ab_xa: range(0.382, 0.5),
    bc_ab: range(0.382, 0.886),
    cd_bc: range(1.618, 2.618),
    ad_xa: point(0.886),
  },
  crab: {
    ab_xa: range(0.382, 0.618),
    bc_ab: range(0.382, 0.886),
    cd_bc: range(2.24, 3.618),
    ad_xa: point(1.618),
  },
  butterfly: {
    ab_xa: point(0.786),
    bc_ab: range(0.382, 0.886),
    cd_bc: range(1.618, 2.24),
    ad_xa: bestOf(1.27, 1.618),
  },
};

interface HarmonicMatch {
  harmonicType: XabcdType | 'ab-cd';
  confidence: number;
  ratios: { ab_xa: number; bc_ab: number; cd_bc: number; ad_xa: number };
}

/**
 * Проверяет геометрию X-A-B-C-D против коэффициентов Фибоначчи всех 4
 * XABCD-паттернов (Gartley/Bat/Crab/Butterfly) одновременно и возвращает
 * лучшее совпадение (по confidence), либо null, если ни одна геометрия не
 * проходит допуск.
 *
 * Примечание по терминологии: "AD" в исходном промте/источнике — это
 * длина сегмента A→D (а не X→D), измеряющая, насколько цена откатывается
 * (Gartley/Bat/Crab) или продолжает (Butterfly, за пределы X) от точки A
 * относительно длины ноги XA. Стандартное соглашение для точки завершения
 * D в литературе по гармоникам: Gartley D = точка, отстоящая от A на
 * 78.6% XA (в сторону X); Butterfly D = точка, отстоящая от A на
 * 127.2%/161.8% XA (за пределы X). Проверено численно на каноническом
 * примере X=0, A=100: D=21.4 даёт |A-D|/|A-X| = 0.786, тогда как
 * |X-D|/|A-X| = 0.214 — то есть именно |A-D|, а не |X-D|, воспроизводит
 * 0.786. Реализовано как adXa = |D - A| / |A - X| ниже.
 */
function matchXabcd(
  X: ZigZagPoint,
  A: ZigZagPoint,
  B: ZigZagPoint,
  C: ZigZagPoint,
  D: ZigZagPoint,
  tolerancePct: number,
): HarmonicMatch | null {
  const xa = legLength(X, A);
  const ab = legLength(A, B);
  const bc = legLength(B, C);
  const cd = legLength(C, D);
  const ad = legLength(A, D);
  if (xa === 0 || ab === 0 || bc === 0) return null;

  const abXa = ab / xa;
  const bcAb = bc / ab;
  const cdBc = cd / bc;
  const adXa = ad / xa;
  const ratios = { ab_xa: abXa, bc_ab: bcAb, cd_bc: cdBc, ad_xa: adXa };

  let best: HarmonicMatch | null = null;
  for (const harmonicType of Object.keys(XABCD_RULES) as XabcdType[]) {
    const rules = XABCD_RULES[harmonicType];
    const scores = [
      scoreLeg(abXa, rules.ab_xa, tolerancePct),
      scoreLeg(bcAb, rules.bc_ab, tolerancePct),
      scoreLeg(cdBc, rules.cd_bc, tolerancePct),
      scoreLeg(adXa, rules.ad_xa, tolerancePct),
    ];
    if (scores.some((s): s is null => s === null)) continue;
    const confidence = (scores as number[]).reduce((sum, s) => sum + s, 0) / scores.length;
    if (!best || confidence > best.confidence) {
      best = { harmonicType, confidence, ratios };
    }
  }
  return best;
}

/**
 * AB=CD: AB≈CD по длине, без точки X. BC должен быть валидным ретрейсом AB
 * (тот же 0.382-0.886 диапазон, что и у Gartley/Bat/Crab/Butterfly) —
 * стандартная практика подтверждения AB=CD, иначе почти любые 4 точки
 * прошли бы чисто по совпадению длин AB/CD.
 */
function matchAbCd(A: ZigZagPoint, B: ZigZagPoint, C: ZigZagPoint, D: ZigZagPoint, tolerancePct: number): HarmonicMatch | null {
  const ab = legLength(A, B);
  const bc = legLength(B, C);
  const cd = legLength(C, D);
  if (ab === 0 || bc === 0) return null;

  const bcAb = bc / ab;
  const cdAb = cd / ab;

  const sBc = scoreAgainstRange(bcAb, 0.382, 0.886, tolerancePct);
  const sCd = scoreAgainstPoint(cdAb, 1, tolerancePct);
  if (sBc === null || sCd === null) return null;

  return {
    harmonicType: 'ab-cd',
    confidence: (sBc + sCd) / 2,
    ratios: { ab_xa: NaN, bc_ab: bcAb, cd_bc: cdAb, ad_xa: NaN },
  };
}

function latestAtr(candles: Candle[], snapshot: IndicatorSnapshot | undefined, period: number): number {
  if (snapshot?.atr !== null && snapshot?.atr !== undefined && snapshot.atr > 0) return snapshot.atr;
  const values = atr(candles, period);
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && v > 0) return v;
  }
  const slice = candles.slice(-period);
  if (slice.length === 0) return 0;
  return slice.reduce((sum, c) => sum + (c.high - c.low), 0) / slice.length;
}

function toHarmonicPoint(p: ZigZagPoint): HarmonicPoint {
  return { price: p.price, time: p.time, index: p.index };
}

/**
 * Проверяет пересечение PRZ со свежим (< CONFLUENCE_FRESHNESS_MAX_AGE_BARS
 * баров), непробитым OB/FVG того же направления — тот же конфлюэнс-бонус,
 * что и у остальных многофакторных детекторов этого семейства
 * (order-block-continuation, fvg-breaker-block и т.п.), примененный здесь
 * к зоне PRZ вместо цены входа. Возвращает null, если конфлюэнса нет (или
 * smartMoney не передан), иначе — строку для confluenceFactors.
 */
function checkPrzConfluence(
  smartMoney: SmartMoneyResult | undefined,
  direction: SignalDirection,
  przLow: number,
  przHigh: number,
  lastCandle: Candle,
  intervalSec: number,
): string | null {
  if (!smartMoney) return null;
  const wantType = direction === 'buy' ? 'bullish' : 'bearish';
  const freshObs = pickFreshUnbrokenOrderBlocks(
    smartMoney.orderBlocks,
    wantType,
    lastCandle.time,
    intervalSec,
    CONFLUENCE_FRESHNESS_MAX_AGE_BARS,
  );
  const freshFvgs = pickFreshUnbrokenFvgs(
    smartMoney.fvgs,
    wantType,
    lastCandle.time,
    intervalSec,
    CONFLUENCE_FRESHNESS_MAX_AGE_BARS,
  );
  // Epsilon для устойчивости к floating-point неточностям — особенно
  // важно для AB=CD, где PRZ может вырождаться в точку (cdRange=[1,1]).
  const PRZ_EPS = 1e-9;
  const overlapsPrz = (top: number, bottom: number) => top >= przLow - PRZ_EPS && bottom <= przHigh + PRZ_EPS;
  const obConfluence = freshObs.some((ob) => overlapsPrz(ob.top, ob.bottom));
  if (obConfluence) return `PRZ confluence with ${wantType} order block`;
  const fvgConfluence = freshFvgs.some((f) => overlapsPrz(f.top, f.bottom));
  if (fvgConfluence) return `PRZ confluence with ${wantType} FVG`;
  return null;
}

/**
 * Проверяет ОДНО конкретное окно X-A-B-C-D (5 подряд идущих точек ZigZag)
 * и возвращает готовый PatternResult, либо null, если это окно не даёт
 * валидного паттерна ни по одной из проверок ниже (чередование типов,
 * геометрия Фибоначчи, свежесть точки D, актуальность сетапа). Вынесено в
 * отдельную функцию из detectHarmonicPattern, чтобы можно было применить
 * её к нескольким скользящим окнам (см. detectHarmonicPattern) — паттерн
 * мог "сложиться" не строго на самых последних 5 точках ZigZag, а на 1-2
 * точки раньше.
 */
function evaluateWindow(
  window: readonly ZigZagPoint[],
  candles: Candle[],
  lastCandle: Candle,
  intervalSec: number,
  cfg: HarmonicConfig,
  session: SessionRegime | undefined,
  smartMoney: SmartMoneyResult | undefined,
  snapshot: IndicatorSnapshot | undefined,
): PatternResult | null {
  const [X, A, B, C, D] = window;

  // Валидность чередования high/low гарантируется алгоритмом ZigZag, но
  // проверяем явно — самое опасное место для путаницы направления.
  const types = [X.type, A.type, B.type, C.type, D.type];
  for (let i = 1; i < types.length; i++) {
    if (types[i] === types[i - 1]) return null;
  }

  // ── Freshness gate (BUGFIX: изначально отсутствовал) ─────────────────────
  // ZigZag по построению подтверждает точку D только ПОСТФАКТУМ — после
  // того, как цена уже отошла от неё минимум на minLegAtr×ATR в обратную
  // сторону (см. computeZigZag: точка пушится в момент разворота, не в
  // момент своего образования). Без ограничения возраста это давало 2
  // независимых проблемных сценария:
  // 1) Один и тот же D мог совпадать с идеальной геометрией сколь угодно
  //    долго (пока не появится следующая точка ZigZag), и детектор заново
  //    "открывал" тот же самый паттерн на каждой свече — дублирующиеся
  //    сигналы 'harmonic-pattern' с одним и тем же time/PRZ, но по всё
  //    более невыгодной текущей цене.
  // 2) Точка D могла быть найдена спустя много баров после реального
  //    завершения паттерна (при большом htfFactor + плоском рынке), то есть
  //    сигнал не имел отношения к текущей торговой возможности вообще.
  // Тот же приём "age < maxAgeBars", что уже используют FVG/OB-семейства
  // (см. pickFreshUnbrokenFvgs/pickFreshUnbrokenOrderBlocks в
  // fvg-strategies-shared.ts / order-block-strategies-shared.ts) —
  // переиспользуем fvgAgeBars как есть (это чистая арифметика "сколько
  // баров прошло", не специфичная для FVG). Порог масштабируется по
  // htfFactor (при ресэмплинге на старший ТФ подтверждение точки D
  // естественно занимает больше "сырых" баров базового ТФ) с нижней
  // границей 30 — подобрано так, чтобы не отбрасывать штатное
  // подтверждение (9-14 баров на ручных фикстурах в harmonic-pattern.test.ts
  // при htfFactor=1), но не давать паттерну "висеть" бесконечно. Применяется
  // per-window (D может быть разной точкой в разных окнах), поэтому гейт
  // остаётся достаточным сам по себе и без отдельной "D = последняя или
  // предпоследняя точка ZigZag" проверки, которая нужна там, где окно
  // всего одно и всегда заканчивается на самой последней точке.
  const ageBars = fvgAgeBars(D.time, lastCandle.time, intervalSec);
  const maxAgeBars = Math.max(30, cfg.htfFactor * 6);
  if (ageBars < 0 || ageBars > maxAgeBars) return null;

  const xabcd = matchXabcd(X, A, B, C, D, cfg.fibTolerancePct);
  const abCd = matchAbCd(A, B, C, D, cfg.fibTolerancePct);

  const match = xabcd && (!abCd || xabcd.confidence >= abCd.confidence) ? xabcd : abCd;
  if (!match) return null;

  // Направление: bullish (D — минимум) → buy, bearish (D — максимум) → sell.
  const direction: SignalDirection = D.type === 'low' ? 'buy' : 'sell';

  // PRZ (Potential Reversal Zone) — диапазон пересечения 2-3 проекций:
  // AD-проекция от A (ретрейс/расширение XA, измеренное от A — см.
  // комментарий у matchXabcd про терминологию AD) + CD-диапазон,
  // спроецированный от C по BC. Знак берётся из фактического направления
  // соответствующей ноги (устойчиво к любой ориентации паттерна, buy/sell).
  const xa = legLength(X, A);
  const ab = legLength(A, B);
  const bc = legLength(B, C);
  // Движение A→D всегда направлено ОБРАТНО движению X→A (это и есть
  // "откат"/"расширение за X") — знак берём противоположным (A-X).
  const adSign = -(Math.sign(A.price - X.price) || 1);
  const cdSign = Math.sign(D.price - C.price) || 1;

  let adProjection: number | null = null;
  let cdRange: [number, number] = [1, 1];
  // Нога, от длины которой отсчитывается cdRange при проекции CD от C.
  // Для XABCD-типов matchXabcd проверяет cd/bc (см. XABCD_RULES) — база bc.
  // Для ab-cd matchAbCd проверяет cd/AB ≈ 1 (см. cdAb выше) — база ab, а
  // НЕ bc (BC там — самостоятельная ретрейс-нога 0.382-0.886×AB, обычно
  // короче AB, и подстановка её длины в проекцию, рассчитанную под
  // ratio-к-AB, даёт систематическую ошибку PRZ на |AB-BC|).
  let cdProjectionBase = bc;
  if (match.harmonicType === 'gartley') {
    adProjection = A.price + adSign * 0.786 * xa;
    cdRange = [1.13, 1.618];
  } else if (match.harmonicType === 'bat') {
    adProjection = A.price + adSign * 0.886 * xa;
    cdRange = [1.618, 2.618];
  } else if (match.harmonicType === 'crab') {
    adProjection = A.price + adSign * 1.618 * xa;
    cdRange = [2.24, 3.618];
  } else if (match.harmonicType === 'butterfly') {
    const ad = legLength(A, D);
    const ratio = Math.abs(ad / xa - 1.27) <= Math.abs(ad / xa - 1.618) ? 1.27 : 1.618;
    adProjection = A.price + adSign * ratio * xa;
    cdRange = [1.618, 2.24];
  }
  // ab-cd: своей A-проекции (от XA) нет (паттерн без точки X) — PRZ строится
  // только из CD-диапазона вокруг ~1.0×AB, спроецированного от C.
  else {
    cdRange = [1, 1];
    // BUGFIX (аудит модуля "гармоники" на синтетических данных, 2026-09):
    // здесь стояла база `bc` (унаследовано из XABCD-веток, где cdRange —
    // это именно cd/bc). Для ab-cd cdRange — это cd/AB (см. matchAbCd:
    // cdAb = cd/ab, sCd = scoreAgainstPoint(cdAb, 1, ...)), поэтому базой
    // обязана быть `ab`, а не `bc`. С неверной базой PRZ систематически
    // уезжал от реальной точки D на |AB-BC| (на синтетических данных —
    // до ~900 пунктов при цене ~50000, т.е. PRZ не содержал D вообще ни
    // разу из 10 проверенных ab-cd сетапов — см. docs/audit).
    cdProjectionBase = ab;
  }

  const cdProjectionLow = C.price + cdSign * cdRange[0] * cdProjectionBase;
  const cdProjectionHigh = C.price + cdSign * cdRange[1] * cdProjectionBase;
  const przCandidates = [cdProjectionLow, cdProjectionHigh, ...(adProjection !== null ? [adProjection] : [])];
  const przLow = Math.min(...przCandidates);
  const przHigh = Math.max(...przCandidates);

  // Структурные SL/TP — предвычисляются здесь (детектор — единственное
  // место с доступом к геометрии X-A-B-C-D), потребляются
  // computeHarmonicTradeLevels() в decision/trade-levels.ts.
  const currentAtr = latestAtr(candles, snapshot, 14);
  const STOP_ATR_BUFFER = 0.15;
  const harmonicStop =
    direction === 'buy'
      ? Math.min(D.price, X.price) - currentAtr * STOP_ATR_BUFFER
      : Math.max(D.price, X.price) + currentAtr * STOP_ATR_BUFFER;
  // Первая цель — 61.8% ретрейс последней ноги (C→D) обратно к точке C,
  // стандартный PT1 для гармонических разворотных сделок.
  const harmonicTarget = D.price + 0.618 * (C.price - D.price);

  // ── Инвалидация задним числом (BUGFIX: изначально отсутствовала) ────────
  // Между моментом образования D и моментом, когда ZigZag его ПОДТВЕРДИТ
  // (см. freshness-гейт выше), цена уже прошла часть пути — сам факт
  // подтверждения означает движение от D минимум на minLegAtr×ATR. Раз мы
  // теперь допускаем паттерн с ненулевым возрастом, нужно явно проверить,
  // что за это время сетап не был уже сломан или уже не отыгран целиком —
  // иначе детектор вернёт формально валидную геометрию по сделке, которой
  // по факту уже нет (стоп снесён или тейк уже достигнут до открытия
  // позиции). Проверяем экстремумы всех баров ПОСЛЕ D (не включая саму
  // свечу D) против уже посчитанных harmonicStop/harmonicTarget.
  const barsAfterD = candles.slice(-(Math.ceil(ageBars) + 2)).filter((c) => c.time > D.time);
  const alreadyBusted = barsAfterD.some((c) => (direction === 'buy' ? c.low <= harmonicStop : c.high >= harmonicStop));
  if (alreadyBusted) return null;
  const alreadyHitTarget = barsAfterD.some((c) => (direction === 'buy' ? c.high >= harmonicTarget : c.low <= harmonicTarget));
  if (alreadyHitTarget) return null;

  const confluenceFactors: string[] = [`fib-tolerance:${cfg.fibTolerancePct}%`];
  let confidence = match.confidence;

  // Конфлюэнс PRZ со свежим OB/FVG того же направления — перенесено из
  // параллельной реализации этого модуля (см. checkPrzConfluence выше).
  // Тот же бонус/порог свежести, что уже используют остальные
  // многофакторные SMC/ICT-детекторы этого семейства.
  const przConfluenceFactor = checkPrzConfluence(smartMoney, direction, przLow, przHigh, lastCandle, intervalSec);
  if (przConfluenceFactor) {
    confidence = Math.min(1, confidence + CONFLUENCE_BONUS);
    confluenceFactors.push(przConfluenceFactor);
  }

  // Небольшой конфлюэнс-бонус за высоколиквидную сессию — та же логика
  // "session boost", что уже применяется другими многофакторными
  // детекторами в этом семействе (см. patterns/index.ts комментарий про
  // "session boost, объёмные/ATR-мультипликаторы, HTF-конфлюэнс").
  if (session && isHighLiquiditySession(session)) {
    confidence = Math.min(1, confidence + 0.05);
    confluenceFactors.push('high-liquidity-session');
  }

  const strength: SignalStrength = confidence >= 0.75 ? 'strong' : confidence >= 0.5 ? 'moderate' : 'weak';

  return {
    name: 'harmonic-pattern',
    direction,
    confidence,
    strength,
    time: D.time,
    confluenceFactors,
    harmonicType: match.harmonicType,
    przLow,
    przHigh,
    harmonicStop,
    harmonicTarget,
    // Диагностика для чарта/постмортем-аналитики (см. HarmonicPoint в
    // domain.ts) — не потребляется trade-levels.ts/signal-builder.ts,
    // только дополнительная информация о том, на чём именно сматчилась
    // геометрия. ab-cd не считает ad_xa/ab_xa (нет точки X) — NaN
    // сигнализирует "неприменимо для этой геометрии", а не ошибку.
    harmonicPoints: {
      x: toHarmonicPoint(X),
      a: toHarmonicPoint(A),
      b: toHarmonicPoint(B),
      c: toHarmonicPoint(C),
      d: toHarmonicPoint(D),
    },
    harmonicRatios: match.ratios,
  };
}

export function detectHarmonicPattern(
  candles: Candle[],
  snapshot?: IndicatorSnapshot,
  session?: SessionRegime,
  structure?: MarketStructure,
  smartMoney?: SmartMoneyResult,
  config?: HarmonicConfig,
): PatternResult | null {
  // structure не используется в самой геометрии гармоник (в отличие от
  // OB/FVG-стратегий) — принят в сигнатуре по образцу
  // detectOrderBlockContinuation(candles, snapshot, session, structure,
  // smartMoney) для единообразия вызова в patterns/index.ts. smartMoney
  // ТЕПЕРЬ используется (конфлюэнс PRZ с OB/FVG, см. evaluateWindow) — в
  // отличие от исходной версии этого детектора, где он был помечен как
  // намеренно неиспользуемый.
  void structure;

  const cfg = config ?? DEFAULT_HARMONIC_CONFIG;
  // Минимум данных для ATR-адаптивного ZigZag на ресэмплированном старшем ТФ:
  // нужно htfFactor × (atrPeriod + 5) свечей базового ТФ, чтобы после
  // ресэмплинга получилось хотя бы atrPeriod HTF-свечей (для прогрева ATR) +
  // 5 точек ZigZag. Раньше стояло 40 — при htfFactor=5 это давало лишь 8
  // HTF-свечей, недостаточно для 14-периодного ATR. Нижняя граница 40
  // сохранена для htfFactor=1 (тесты с малыми фикстурами).
  const minHistory = Math.max(40, cfg.htfFactor * (14 + 5));
  if (candles.length < minHistory) return null;

  // Запрашиваем хвост из 7 точек ZigZag вместо ровно 5 — паттерн мог
  // "сложиться" на 1-2 точки ZigZag раньше самого последнего пятиточечного
  // окна (перенесено из параллельной реализации этого модуля: там это
  // называется "3 скользящих окна по 5 точек с конца"). tailCount — новый
  // необязательный параметр findHarmonicZigZagPoints (см. zigzag.ts),
  // остальные вызовы (ChartPanel.tsx) не затронуты — они не передают его и
  // получают, как и раньше, ровно последние 5 точек.
  const tail = findHarmonicZigZagPoints(candles, cfg.minLegAtr, cfg.htfFactor, 14, 7);
  if (!tail) return null;

  const windows: ZigZagPoint[][] = [];
  if (tail.length >= 5) windows.push(tail.slice(-5));
  if (tail.length >= 6) windows.push(tail.slice(-6, -1));
  if (tail.length >= 7) windows.push(tail.slice(-7, -2));

  const lastCandle = candles[candles.length - 1];
  const intervalSec = intervalSeconds(candles);

  let best: PatternResult | null = null;
  for (const window of windows) {
    if (window.length !== 5) continue;
    const candidate = evaluateWindow(window, candles, lastCandle, intervalSec, cfg, session, smartMoney, snapshot);
    if (candidate && (!best || candidate.confidence > best.confidence)) {
      best = candidate;
    }
  }
  // BUGFIX (Фаза 1, вычистка TP/SL/RR-языка): раньше здесь был комментарий
  // про minRR-гейт, применяемый ниже по цепочке в decision/trade-levels.ts —
  // тот файл целиком удалён (структурные SL/TP не нужны для бинарных
  // опционов с фиксированной экспирацией). harmonicStop/harmonicTarget на
  // PatternResult (ниже) остаются как диагностическая геометрия точки D/
  // проекции Фибоначчи — ничем не потребляются в решающем слое, только
  // для чарта/постмортем-анализа.
  return best;
}
