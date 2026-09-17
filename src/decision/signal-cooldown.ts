import type { SignalDirection } from '@/types/domain';

// BUGFIX (аудит 2026-09-05): в реальном инциденте движок за 13 минут выдал
// 3 BUY-сигнала подряд (08:20, 08:21, 08:22) почти на одной и той же цене
// (79664.47 / 79664.47 / 79663.19), пока предыдущий с экспирацией 3m ещё не
// резолвился — по сути "усреднение" в уже проигрывающую зону без единой
// проверки. DecisionEngine раньше не хранил никакой истории уже выданных
// сигналов между вызовами evaluate(), поэтому каждый бар оценивался так,
// будто рынок увидели впервые.
//
// Этот модуль — чистая, независимо тестируемая функция: держит ли ещё
// "кулдаун" предыдущий сигнал той же стороны и той же ценовой зоны. Сама
// история сигналов хранится в DecisionEngine (см. engine.ts).

export interface RecentSignalRecord {
  direction: SignalDirection;
  entryPrice: number;
  /** Время закрытой свечи, на которой был выдан этот сигнал (секунды). */
  candleTime: number;
  /** До какого времени (секунды) сигнал считается ещё не резолвленным. */
  resolvesAtTime: number;
}

export interface CooldownCheckParams {
  recent: RecentSignalRecord[];
  direction: SignalDirection;
  entryPrice: number;
  candleTime: number;
  /** ATR на момент нового сигнала — определяет ширину "той же зоны". */
  atrValue: number | null;
  /** Во сколько ATR считать цену "той же зоной". */
  zoneAtrMultiplier?: number;
}

export const DEFAULT_COOLDOWN_ZONE_ATR_MULTIPLIER = 2;

/**
 * true, если новый сигнал нужно подавить: в его направлении и ценовой зоне
 * уже есть недавний сигнал, который ещё не должен был резолвиться
 * (candleTime нового сигнала раньше recent.resolvesAtTime).
 */
export function isSuppressedByCooldown(params: CooldownCheckParams): boolean {
  const { recent, direction, entryPrice, candleTime, atrValue } = params;
  if (recent.length === 0) return false;
  if (!atrValue || atrValue <= 0) return false;

  const zoneMultiplier = params.zoneAtrMultiplier ?? DEFAULT_COOLDOWN_ZONE_ATR_MULTIPLIER;
  const zoneWidth = atrValue * zoneMultiplier;

  return recent.some((r) => {
    if (r.direction !== direction) return false;
    if (candleTime >= r.resolvesAtTime) return false; // предыдущий сигнал уже должен был резолвиться
    return Math.abs(entryPrice - r.entryPrice) <= zoneWidth;
  });
}

/** Отбрасывает записи, чьё окно резолва уже прошло — не даём массиву расти бесконечно. */
export function pruneResolvedSignals(recent: RecentSignalRecord[], nowCandleTime: number): RecentSignalRecord[] {
  return recent.filter((r) => nowCandleTime < r.resolvesAtTime);
}

// BUGFIX (аудит 2026-09-06, п.5 "кулдаун не ловит пилу"): isSuppressedByCooldown
// выше подавляет только повтор ТОГО ЖЕ направления в той же зоне — реальный
// инцидент был BUY (20:16) → SELL (20:23) → BUY (20:29), три РАЗНЫХ сигнала
// каждый своего направления, за 13 минут в одном и том же диапазоне
// 79680-79850 — ни один из них не повторял направление предыдущего, так что
// исходный кулдаун не подавил ни одного. Это торговля обеих границ одного и
// того же флэта — "пила" — а не пере-набор позиции, для которого кулдаун
// выше и был написан.
//
// Chop-guard проверяет отдельную, не завязанную на резолв историю (сигнал
// остаётся в ней CHOP_GUARD_WINDOW_SECONDS независимо от того, когда он
// резолвится): если в той же ценовой зоне за последние 15 минут уже
// встречались сигналы ХОТЯ БЫ 2 разных направлений, зона считается "пилой" и
// новый сигнал (независимо от его собственного направления) подавляется.
export const CHOP_GUARD_WINDOW_SECONDS = 15 * 60;
export const CHOP_GUARD_MIN_DISTINCT_DIRECTIONS = 2;

export interface ChopGuardCheckParams {
  /** История сигналов за окно CHOP_GUARD_WINDOW_SECONDS, НЕ фильтрованная по резолву. */
  history: RecentSignalRecord[];
  direction: SignalDirection;
  entryPrice: number;
  candleTime: number;
  atrValue: number | null;
  zoneAtrMultiplier?: number;
  windowSeconds?: number;
}

/**
 * true, если в ценовой зоне нового сигнала за последнее windowSeconds уже
 * было >= CHOP_GUARD_MIN_DISTINCT_DIRECTIONS разных направлений — то есть
 * зона уже торгуется "пилой" и новый сигнал (любого направления) должен
 * быть подавлен, а не только повтор той же стороны.
 */
export function isSuppressedByChopGuard(params: ChopGuardCheckParams): boolean {
  const { history, entryPrice, candleTime, atrValue } = params;
  if (history.length === 0) return false;
  if (!atrValue || atrValue <= 0) return false;

  const zoneMultiplier = params.zoneAtrMultiplier ?? DEFAULT_COOLDOWN_ZONE_ATR_MULTIPLIER;
  const zoneWidth = atrValue * zoneMultiplier;
  const windowSeconds = params.windowSeconds ?? CHOP_GUARD_WINDOW_SECONDS;

  const directionsInZone = new Set<SignalDirection>();
  for (const r of history) {
    if (candleTime - r.candleTime > windowSeconds) continue;
    if (Math.abs(entryPrice - r.entryPrice) > zoneWidth) continue;
    directionsInZone.add(r.direction);
  }
  return directionsInZone.size >= CHOP_GUARD_MIN_DISTINCT_DIRECTIONS;
}

/** Отбрасывает записи старше windowSeconds от nowCandleTime — для chop-guard истории (не по резолву). */
export function pruneChopGuardHistory(
  history: RecentSignalRecord[],
  nowCandleTime: number,
  windowSeconds: number = CHOP_GUARD_WINDOW_SECONDS,
): RecentSignalRecord[] {
  return history.filter((r) => nowCandleTime - r.candleTime <= windowSeconds);
}

// BUGFIX (аудит, п. "Кулдаун на переоткрытие по инструменту после подряд
// идущих сигналов в одном направлении без смены структуры" — из
// приоритетного списка диагноза, пп. 5 остались непокрытыми):
// isSuppressedByCooldown выше подавляет повтор ТОГО ЖЕ направления только
// пока предыдущий сигнал ещё не резолвился — на M1 с коротким expiry к
// моменту третьего сигнала предыдущий уже успевает резолвиться, и гейт не
// срабатывает. isSuppressedByChopGuard требует >=2 РАЗНЫХ направлений в
// зоне — а серия из трёх SELL подряд (06:30, 06:41, 06:48, диагноз) состоит
// из одного и того же направления, так что chop-guard тоже её не ловит.
// Итого сценарий "N сигналов одного направления в одной ценовой зоне за
// окно без подтверждённой смены структуры" проходит сквозь оба
// существующих гейта — этот, третий, гейт использует ту же
// не-завязанную-на-резолв историю (chopGuardHistory), что и chop-guard,
// и подавляет, если в зоне/окне уже накопилось
// SAME_DIRECTION_SERIAL_LIMIT+ сигналов ТОГО ЖЕ направления.
export const SAME_DIRECTION_SERIAL_LIMIT = 2;

/**
 * true, если в ценовой зоне нового сигнала за последнее windowSeconds уже
 * было >= SAME_DIRECTION_SERIAL_LIMIT сигналов ТОГО ЖЕ направления, что и
 * новый — то есть движок уже несколько раз подряд пытался войти в одну
 * сторону в одном диапазоне без ожидания реальной смены структуры.
 */
export function isSuppressedBySameDirectionSerial(params: ChopGuardCheckParams): boolean {
  const { history, direction, entryPrice, candleTime, atrValue } = params;
  if (history.length === 0) return false;
  if (!atrValue || atrValue <= 0) return false;

  const zoneMultiplier = params.zoneAtrMultiplier ?? DEFAULT_COOLDOWN_ZONE_ATR_MULTIPLIER;
  const zoneWidth = atrValue * zoneMultiplier;
  const windowSeconds = params.windowSeconds ?? CHOP_GUARD_WINDOW_SECONDS;

  let sameDirectionCount = 0;
  for (const r of history) {
    if (candleTime - r.candleTime > windowSeconds) continue;
    if (Math.abs(entryPrice - r.entryPrice) > zoneWidth) continue;
    if (r.direction !== direction) continue;
    sameDirectionCount++;
  }
  return sameDirectionCount >= SAME_DIRECTION_SERIAL_LIMIT;
}
