import type { Candle, SignalDirection, Snapshot, SignalComponentToggles, FeatureName } from '@/types/domain';
import { DEFAULT_SIGNAL_TOGGLES } from '@/types/domain';
import { orderBlockStrength, detectImbalances } from '@/compute/indicators/order-block-strength';
import { adx } from '@/compute/indicators/adx';
import { isPatternInRange } from './direction-prediction';

export const CONTEXT_PENALTY = 0.3;
export const CONFIRMATION_BONUS = 0.25;

// BUGFIX (аудит 2026-09-05): ADX ниже этого порога в связке с regime='range'
// означает угасающий/отсутствующий тренд — именно та обстановка, в которой
// все 6 подряд убыточных BTCUSDT M1 сделки из аудита были открыты (ADX
// падал с 39.8 до 25.3 на протяжении 13 минут, ни разу не остановив вход).
//
// САМОКОРРЕКЦИЯ (повторный аудит того же дня): первая версия использовала
// порог 25 — и он оказался НЕРАБОЧИМ на этих же данных: у трёх сделок с
// regime='range' ADX был 27.4 / 26.0 / 25.3 — все строго выше 25, гейт не
// сработал бы ни разу. Порог поднят до 30, при котором гейт реально
// срабатывает на всех трёх (проверено численно на исходных данных
// инцидента). Дополнительно, сам по себе множитель 0.35 не опускает score
// этих сделок (24.4 / 18.2 / 6.1) ниже scoreThreshold=2 — то есть гейт
// снижает уверенность, но НЕ гарантирует полную блокировку сильных по
// сырым компонентам сигналов; реальную блокировку двух из трёх дублей даёт
// кулдаун (см. signal-cooldown.ts). Считать одним гейтом достаточным —
// ошибка; см. итоговый прогон в конце файла-аудита.
export const REGIME_GATE_ADX_THRESHOLD = 30;
export const REGIME_GATE_PENALTY = 0.35;

// BUGFIX (аудит 2026-09-06): предыдущая версия гейта (порог 30, множитель
// 0.35) — реально снижает score, но НЕ гарантирует блокировку: 4 сделки
// BTCUSDT M1 подряд (2026-09-05 20:15-20:29, ADX 14.9/15.6/18.5/19.0, все
// строго ниже даже порога 20) получили именно этот штраф — "score reduced" —
// и всё равно прошли scoreThreshold=2 с итоговым score 4.3-7.0. Wilder,
// создатель ADX, и последующая литература (см. напр. babypips/Forexpedia
// "ADX") согласны в одном: ниже 20 — это "no trend"/"trendless", не просто
// "слабый тренд" — то есть зона, где само определение тренда для трендовых/
// реакционных SMC-сетапов (order-block reaction, continuation, breakout)
// перестаёт быть применимо, а не просто менее надёжно. Поэтому ниже 20 —
// теперь HARD VETO (invalidated=true, эквивалент return null из buildSignal
// в терминах итогового Signal), а не штраф. Диапазон [20, 30) — "emerging/
// developing trend" по той же классификации — остаётся мягким штрафом
// REGIME_GATE_PENALTY, т.к. там направленность уже частично складывается и
// полная блокировка была бы неоправданно консервативной.
export const REGIME_GATE_HARD_VETO_ADX_THRESHOLD = 20;

// BUGFIX (аудит, диагноз п.3 "ADX высокий, а режим — range"): ADX — Wilder-
// сглаженный, но всё равно запаздывающий индикатор, который может кратко
// подскочить на резком, но нестабильном шумовом импульсе внутри диапазона,
// а не только на устойчивом тренде. До этого фикса regime-гейт смотрел
// только на сырое, одноточечное значение ADX на баре входа: если оно было
// >= REGIME_GATE_ADX_THRESHOLD, сигнал проходил вообще без штрафа, даже
// если regime классифицирован как 'range' — 4 из 5 сделок в разборе имели
// ADX 33.6-45.8 при regime='range' и прошли без трения. Теперь высокий ADX
// в range-режиме дополнительно проверяется на персистентность за последние
// N баров, а не принимается по одному снимку.
export const REGIME_GATE_ADX_PERSISTENCE_BARS = 5;

// АУДИТ 2026-09-13 ("не допустить 3 убыточные сделки подряд" — без
// изменений в мартингейле и без занижения весов/порогов): regime='range'
// выше давно и подробно защищён этим же ADX-гейтом (включая hard veto и
// persistence-проверку), а вот у 'high-volatility' до сих пор не было
// вообще НИКАКОГО детерминированного гейта — только фича regime_vol в
// ML-калибровке (см. signal-builder.ts::buildFeatureVector), которая (а)
// не активна до накопления MIN_SAMPLES исходов и (б) даже активная, как
// линейная логистическая регрессия, может выучить только постоянный
// сдвиг лог-одды по этой фиче, а не взаимодействие "именно ЭТОТ паттерн
// плохо работает именно в high-volatility" — то есть тот же класс риска
// "гейта фактически нет, ждём пока модель молча наберёт статистику",
// который уже был найден и закрыт для 'range' (см. комментарий у
// REGIME_GATE_ADX_THRESHOLD выше и у REGIME_GATE_HARD_VETO_ADX_THRESHOLD).
// (Тест 'does not gate outside regime=range even with a low ADX' в
// signal-filters.test.ts фиксировал именно этот пробел как текущее
// поведение — не как осознанное архитектурное решение с обоснованием,
// в отличие от 'range'-гейта; обновлён вместе с этим фиксом.)
//
// Методологически high-volatility (residualStdDev/ATR > 1.5 — см.
// market-regime.ts, §5.2: волатильность ВОКРУГ тренда, дрейф уже вычтен)
// без сопутствующего направленного давления (низкий ADX) — это
// разнонаправленный "шторм" (новостной спайк/охота за ликвидностью/резкое
// расширение диапазона без единого направления), а не трендовое движение,
// от которого можно оттолкнуться order-block/FVG/S-R сетапом. Именно в
// таких условиях фитили чаще всего сносят структурные уровни насквозь —
// а поскольку волатильность автокоррелирована (кластеризуется на
// соседних барах, GARCH-эффект), убытки в такие окна тоже кластеризуются
// подряд, а не распределяются случайно между прибыльными сделками.
// Пороги ADX намеренно переиспользованы 1:1 из уже проверенного
// range-гейта (не новые константы) — то же самое определение
// "нет связного направления" (Wilder: ADX < 20 = no trend), применённое
// к соседнему регтиму, а не отдельная новая ручка для подбора.
export const HIGH_VOL_GATE_ADX_THRESHOLD = REGIME_GATE_ADX_THRESHOLD;
export const HIGH_VOL_GATE_HARD_VETO_ADX_THRESHOLD = REGIME_GATE_HARD_VETO_ADX_THRESHOLD;
export const HIGH_VOL_GATE_PENALTY = REGIME_GATE_PENALTY;

export interface FilterResult {
  scoreMultiplier: number;
  confirmed: boolean;
  invalidated: boolean;
  reasons: string[];
}

// False-signal filter: apply context penalty, confirmation bonuses, and invalidation check.
export function applySignalFilters(
  candles: Candle[],
  snapshot: Snapshot,
  direction: SignalDirection,
  _baseScore: number,
  toggles: SignalComponentToggles = DEFAULT_SIGNAL_TOGGLES,
  activeFeatures: FeatureName[] = [],
): FilterResult {
  // ВАЖНО: пустой activeFeatures означает «ничего не выбрано», а не «фильтра
  // нет — считать всё активным» (см. тот же фикс в direction-prediction.ts,
  // IndicatorAggregator.ts, patterns/index.ts, full-snapshot.ts).
  const hasFeature = (name: FeatureName) => activeFeatures.includes(name);
  const reasons: string[] = [];
  let scoreMultiplier = 1;
  let confirmed = false;
  let invalidated = false;

  // Context: pattern in the middle of a range with no tie to S/R/OB → weight × 0.3
  // Only applies when a pattern was actually detected
  const hasPattern = snapshot.patterns.length > 0;
  if (toggles.contextPenalty && hasPattern && isPatternInRange(candles, snapshot)) {
    scoreMultiplier *= CONTEXT_PENALTY;
    reasons.push('Pattern in range with no S/R/OB context — score reduced');
  }

  // BUGFIX (аудит 2026-09-05): ADX и regime раньше вычислялись, но никогда
  // не гейтили решение — только шли фичами в ML-калибровку, которая не
  // активна до накопления MIN_SAMPLES. Теперь слабый/угасающий тренд в
  // диапазоне режет score явным, детерминированным множителем, а не ждёт,
  // пока модель наберёт статистику молча теряя деньги.
  if (toggles.regimeGate && snapshot.regime === 'range') {
    const adxValue = snapshot.indicators.adx;
    if (adxValue !== null && adxValue < REGIME_GATE_HARD_VETO_ADX_THRESHOLD) {
      // Hard veto: below Wilder's "no trend" threshold, a trend/reaction
      // SMC setup has no directional structure to react to at all — this is
      // not the same failure mode as a merely weak trend, so it isn't a
      // multiplier the rest of the score can outweigh.
      invalidated = true;
      reasons.push(`Range regime with no trend (ADX ${adxValue.toFixed(1)} < ${REGIME_GATE_HARD_VETO_ADX_THRESHOLD}) — signal vetoed`);
    } else if (adxValue !== null && adxValue < REGIME_GATE_ADX_THRESHOLD) {
      scoreMultiplier *= REGIME_GATE_PENALTY;
      reasons.push(`Range regime with weak/fading trend (ADX ${adxValue.toFixed(1)} < ${REGIME_GATE_ADX_THRESHOLD}) — score reduced`);
    } else if (adxValue !== null) {
      // ADX >= REGIME_GATE_ADX_THRESHOLD but regime is still 'range': confirm
      // this isn't a lone noise spike by requiring the last N bars to have
      // also been at/above the threshold. A single-bar snapshot can't tell a
      // sustained trend build from a brief impulse inside a range.
      const adxSeries = adx(candles, 14);
      const recentAdx = adxSeries.slice(-REGIME_GATE_ADX_PERSISTENCE_BARS);
      // Only judge persistence when there's actually a full window of ADX
      // history available (enough candles for the ADX seed period plus N
      // more bars) — with too little history to say either way, don't
      // penalize on top of an ambiguous read.
      const hasFullPersistenceWindow =
        recentAdx.length === REGIME_GATE_ADX_PERSISTENCE_BARS && recentAdx.every((v) => v !== null);
      const persistent =
        !hasFullPersistenceWindow ||
        recentAdx.every((v) => v !== null && v >= REGIME_GATE_ADX_THRESHOLD);
      if (!persistent) {
        scoreMultiplier *= REGIME_GATE_PENALTY;
        reasons.push(`Range regime, ADX momentarily above ${REGIME_GATE_ADX_THRESHOLD} (${adxValue.toFixed(1)}) but not sustained over last ${REGIME_GATE_ADX_PERSISTENCE_BARS} bars — score reduced`);
      }
    }
  }

  // High-volatility regime gate (см. комментарий у HIGH_VOL_GATE_* выше):
  // тот же принцип, что и range-гейт, — trend/reaction сетап нуждается в
  // связном направлении, которого разнонаправленный volatility-спайк без
  // сопутствующего ADX не даёт. Без persistence-проверки (в отличие от
  // range-гейта выше): там она чинила конкретный ложный сценарий —
  // однобарный ADX-всплеск ВНУТРИ range, который сам ADX (сглаженный, но
  // с задержкой) мог на мгновение показать высоким. Здесь наоборот: ADX
  // НИЗКИЙ при уже подтверждённом (через residualStdDev, см.
  // market-regime.ts) высоком разбросе — противоречия "мгновенный шум vs
  // устойчивое состояние" тут нет, поэтому добавлять тот же механизм
  // ради симметрии без своего собственного инцидента-обоснования не
  // стали (см. дисциплину проекта в market-regime.ts §5.3 — не чинить
  // вслепую по аналогии).
  if (toggles.regimeGate && snapshot.regime === 'high-volatility') {
    const adxValue = snapshot.indicators.adx;
    if (adxValue !== null && adxValue < HIGH_VOL_GATE_HARD_VETO_ADX_THRESHOLD) {
      invalidated = true;
      reasons.push(`High-volatility regime with no trend (ADX ${adxValue.toFixed(1)} < ${HIGH_VOL_GATE_HARD_VETO_ADX_THRESHOLD}) — signal vetoed`);
    } else if (adxValue !== null && adxValue < HIGH_VOL_GATE_ADX_THRESHOLD) {
      scoreMultiplier *= HIGH_VOL_GATE_PENALTY;
      reasons.push(`High-volatility regime with weak/fading trend (ADX ${adxValue.toFixed(1)} < ${HIGH_VOL_GATE_ADX_THRESHOLD}) — score reduced`);
    }
  }

  // Confirmation: signal strengthened if there's an active OB of same direction near current price
  const lastClose = candles[candles.length - 1].close;
  // Reuses snapshot.indicators.atr (config.atrPeriod-driven, computed once by
  // IndicatorAggregator) instead of a hardcoded-period recompute.
  const atrValue = snapshot.indicators.atr ?? 0;
  const proximity = atrValue * 3;
  const obZones = (toggles.obConfirmation && hasFeature('order-block-strength')) ? orderBlockStrength(candles, 50, snapshot.structure, true) : [];
  const nearbyOBs = (toggles.obConfirmation && hasFeature('order-block-strength')) ? obZones.filter((z) =>
    z.status !== 'broken' &&
    z.low - proximity <= lastClose && lastClose <= z.high + proximity &&
    ((direction === 'buy' && z.direction === 'bullish') ||
      (direction === 'sell' && z.direction === 'bearish')),
  ) : [];
  if (nearbyOBs.length > 0) {
    const bestOB = nearbyOBs.reduce((best, z) => z.strengthScore > best.strengthScore ? z : best);
    scoreMultiplier += CONFIRMATION_BONUS * bestOB.strengthScore;
    confirmed = true;
    if (bestOB.status === 'tested-hold') {
      reasons.push(`Tested OB holding (${bestOB.touchCount} touch${bestOB.touchCount !== 1 ? 'es' : ''}) — bounce signal strengthened`);
    } else {
      reasons.push('Untouched OB of same direction nearby — score strengthened');
    }
  }

  // Confirmation: untouched FVG nearby (FVG detection follows the order-block-strength indicator toggle)
  const fvgConfirmationActive = toggles.fvgConfirmation && hasFeature('order-block-strength');
  const fvgs = fvgConfirmationActive ? detectImbalances(candles) : [];
  const activeFvgs = fvgConfirmationActive ? fvgs.filter((f) => !f.invalidated) : [];
  const hasSameDirFVG = activeFvgs.some((f) =>
    (direction === 'buy' && f.direction === 'bullish') ||
    (direction === 'sell' && f.direction === 'bearish'),
  );
  // BUGFIX (повторный аудит): предыдущий фикс отключил этот бонус, посчитав
  // его тем же фактором, что и "liquidity-pools: 49% винрейт, N=58" в
  // факторной таблице. Это была ошибка атрибуции — тот 49%-фактор на самом
  // деле собирался из components.liquidity в direction-prediction.ts
  // (FVG-proximity + liquidity-pool-proximity, склеенные под одним именем;
  // см. фикс/переименование там же: 'liquidity-fvg'/'liquidity-pool', теперь
  // с нулевой контрибуцией для FVG-proximity). Этот же бонус здесь
  // публикуется под совсем другим именем — kind:'filter', name:'signal-filter'
  // (см. signal-builder.ts) — и относится к бакету с измеренным винрейтом
  // 55%/92, который документ с факторным анализом явно перечислял как
  // "хороший фактор, не трогаем". Бонус восстановлен.
  if (hasSameDirFVG) {
    scoreMultiplier += CONFIRMATION_BONUS * 0.8;
    confirmed = true;
    reasons.push('Untouched FVG nearby — score strengthened');
  }

  // Confirmation: BOS in the signal's direction (only on closed candles)
  const structure = snapshot.structure;
  const hasStructConfirm =
    (direction === 'buy' && structure.bos && structure.trend === 'up' && !structure.provisional) ||
    (direction === 'sell' && structure.bos && structure.trend === 'down' && !structure.provisional);
  if (hasStructConfirm) {
    scoreMultiplier += CONFIRMATION_BONUS;
    confirmed = true;
    reasons.push('BOS confirms signal direction');
  }

  // CHoCH is a reversal signal — if it fires against the signal direction,
  // the structure is breaking down, so penalize rather than confirm.
  const hasStructWarning =
    (direction === 'buy' && structure.choch && structure.trend === 'up') ||
    (direction === 'sell' && structure.choch && structure.trend === 'down');
  if (hasStructWarning) {
    scoreMultiplier *= CONTEXT_PENALTY;
    reasons.push('CHoCH against signal direction — structure weakening');
  }

  // Invalidation: price closes past the pattern's extreme in the opposite direction
  if (candles.length >= 2) {
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const invalidationAtr = snapshot.indicators.atr;
    const extremeBuffer = invalidationAtr ? invalidationAtr * 0.1 : 0;

    if (direction === 'buy') {
      // For a buy signal, invalidation if price closes below the prior candle's low
      if (last.close < prev.low - extremeBuffer) {
        invalidated = true;
        reasons.push('Price closed below pattern extreme — signal invalidated');
      }
    } else {
      // For a sell signal, invalidation if price closes above the prior candle's high
      if (last.close > prev.high + extremeBuffer) {
        invalidated = true;
        reasons.push('Price closed above pattern extreme — signal invalidated');
      }
    }
  }

  if (invalidated) {
    scoreMultiplier = 0;
  }

  return { scoreMultiplier, confirmed, invalidated, reasons };
}
