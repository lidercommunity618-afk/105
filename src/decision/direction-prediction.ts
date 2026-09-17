import type { Candle, DirectionComponents, SignalDirection, Snapshot, SignalComponentToggles, FeatureName, SignalFactor, SignalFactorKind } from '@/types/domain';
import { DEFAULT_SIGNAL_TOGGLES } from '@/types/domain';
import { orderBlockStrength, detectImbalances, type OrderBlockZone } from '@/compute/indicators/order-block-strength';
import { liquidityPools } from '@/compute/indicators/liquidity-pools';
import { levelRejection } from '@/compute/indicators/level-rejection';
import { supportResistance } from '@/compute/indicators/support-resistance';
import { FEATURE_NAMES, DEFAULT_WEIGHTS } from './featureCalibration';
import { selectTopPattern } from './pattern-selection';
import { STRATEGY_BONUS_PATTERNS, getReliabilityMultiplier } from '@/lib/pattern-categories';

export interface DirectionScoreResult {
  direction: SignalDirection | null;
  score: number;
  components: DirectionComponents;
  reasons: string[];
  // Структурированная версия reasons — см. SignalFactor в types/domain.ts.
  // Каждый push(reasons, ...) ниже сопровождается ровно одним push(factors,
  // ...) с тем же текстом в поле `argument`, так что reasons и factors
  // всегда описывают одни и те же события, просто в разных представлениях
  // (человекочитаемая строка vs структура для агрегации/экспорта).
  factors: SignalFactor[];
}

export function computeDirectionScore(
  candles: Candle[],
  snapshot: Snapshot,
  toggles: SignalComponentToggles = DEFAULT_SIGNAL_TOGGLES,
  activeFeatures: FeatureName[] = [],
  atrPeriod: number = 14,
  rsiOverbought: number = 70,
  rsiOversold: number = 30,
  // FIX (аудит калибровки Этапа 2, п.4 — "множитель глобальный, не
  // per-symbol"): новый опциональный параметр, добавлен последним, чтобы не
  // ломать существующие вызовы/тесты (все текущие вызовы в
  // direction-prediction.test.ts зовут функцию с 2 аргументами). Если не
  // передан — getReliabilityMultiplier() ниже отдаёт общий дефолт
  // PATTERN_RELIABILITY_MULTIPLIER, т.е. поведение идентично тому, что было
  // до фикса.
  symbolId?: string,
): DirectionScoreResult {
  // Individual indicator/pattern gating ("Активные индикаторы" / "Активные паттерны").
  // Distinct from `toggles`, which is the separate "Компоненты сигнала" category switch.
  // ВАЖНО: пустой activeFeatures означает «ничего не выбрано», а не «фильтра
  // нет — считать всё активным» (иначе кнопка «выключить все индикаторы/
  // паттерны» в UI включала бы вообще все фичи — см. IndicatorAggregator.ts).
  const hasFeature = (name: FeatureName) => activeFeatures.includes(name);
  const components: DirectionComponents = {
    structure: 0,
    zones: 0,
    liquidity: 0,
    trigger: 0,
    indicator: 0,
    bos: 0,
    macd: 0,
    meanReversion: 0,
  };

  const buyReasons: string[] = [];
  const sellReasons: string[] = [];
  const buyFactors: SignalFactor[] = [];
  const sellFactors: SignalFactor[] = [];
  const last = candles[candles.length - 1];
  const entryPrice = last.close;

  function pushBuy(kind: SignalFactorKind, name: string, contribution: number, argument: string, value: number | null = null): void {
    buyReasons.push(argument);
    buyFactors.push({ kind, name, direction: 'buy', contribution, argument, value });
  }
  function pushSell(kind: SignalFactorKind, name: string, contribution: number, argument: string, value: number | null = null): void {
    sellReasons.push(argument);
    sellFactors.push({ kind, name, direction: 'sell', contribution, argument, value });
  }

  // 1. Structure (BOS/CHoCH)
  // BUGFIX (аудит: score=64.2 против нормы 5-7 на сделке с одиночным BOS):
  // раньше одно и то же событие BOS одновременно писалось и в
  // components.structure, и в components.bos — у обоих вес 2.0 в
  // featureCalibration.ts, то есть один булев факт получал совокупный вес
  // 4.0 вместо 2.0. Данные факторного анализа (bos: 67% винрейт, N=9)
  // показывают, что сам BOS — хороший фактор; проблема была не в доверии к
  // нему, а в случайном удвоении веса. Теперь components.structure отвечает
  // только за CHoCH, components.bos — только за BOS; тумблеры toggles.structure
  // и toggles.bos остаются независимыми (см. блок зануления ниже — не менять).
  const struct = snapshot.structure;
  if (struct.bos) {
    if (struct.trend === 'up') {
      components.bos = 1;
      pushBuy('bos', 'bos', 1, 'BOS bullish');
    } else if (struct.trend === 'down') {
      components.bos = -1;
      pushSell('bos', 'bos', -1, 'BOS bearish');
    }
  }
  if (struct.choch) {
    if (struct.trend === 'up') {
      components.structure = 0.5;
      pushBuy('structure', 'choch', 0.5, 'CHoCH bullish');
    } else if (struct.trend === 'down') {
      components.structure = -0.5;
      pushSell('structure', 'choch', -0.5, 'CHoCH bearish');
    }
  }

  // 2. Zones (OB proximity) — only when the "order-block-strength" indicator is active
  // Reuses snapshot.indicators.atr (computed by IndicatorAggregator from
  // config.atrPeriod) instead of recomputing ATR with a hardcoded period, so
  // there is a single source of truth for the ATR value across the pipeline.
  const atrValue = snapshot.indicators.atr;
  const proximity = atrValue ? atrValue * 2 : 0;

  if (hasFeature('order-block-strength')) {
    const obZones = orderBlockStrength(candles, 50, snapshot.structure, true);
    // BUGFIX (аудит стратегий/паттернов, 2026-09): orderBlockStrength()
    // возвращает зоны в ХРОНОЛОГИЧЕСКОМ порядке обнаружения (от старых к
    // новым, без сортировки) — цикл ниже раньше брал ПЕРВУЮ подходящую по
    // цене зону через `break`, то есть при нескольких валидных OB одного
    // направления в пределах proximity от текущей цены (обычный случай на
    // рэйндже/консолидации) в score попадал strengthScore СТАРЕЙШЕГО блока,
    // а не самого актуального. Это расходится с тем, как эта же функция
    // уже обрабатывает соседние по смыслу зоны: FVG чуть ниже явно берёт
    // `.slice(-3)` (последние = самые свежие), а S/R-уровни в
    // level-rejection приходят из supportResistance(), отсортированной по
    // strength. Для order block'ов в SMC-методологии именно САМЫЙ СВЕЖИЙ
    // неотработанный блок считается актуальным (более старые к текущему
    // движению цены отношения обычно не имеют, даже если формально ещё не
    // "broken") — сортируем по time по убыванию, чтобы `break` брал именно
    // его, а не случайно самый старый совпавший по цене.
    const byRecency = (a: OrderBlockZone, b: OrderBlockZone) => b.time - a.time;
    const activeBullOB = obZones.filter((z) => z.direction === 'bullish' && z.status !== 'broken').sort(byRecency);
    const activeBearOB = obZones.filter((z) => z.direction === 'bearish' && z.status !== 'broken').sort(byRecency);

    for (const ob of activeBullOB) {
      if (Math.abs(entryPrice - ob.low) <= proximity || (entryPrice >= ob.low && entryPrice <= ob.high)) {
        components.zones = ob.strengthScore;
        const label = ob.status === 'tested-hold'
          ? `Tested bullish OB holding (${ob.touchCount} touch${ob.touchCount !== 1 ? 'es' : ''})`
          : 'Untouched bullish OB nearby';
        pushBuy('strategy', 'order-block-strength', ob.strengthScore, label);
        break;
      }
    }
    for (const ob of activeBearOB) {
      if (Math.abs(entryPrice - ob.high) <= proximity || (entryPrice >= ob.low && entryPrice <= ob.high)) {
        components.zones = -ob.strengthScore;
        const label = ob.status === 'tested-hold'
          ? `Tested bearish OB holding (${ob.touchCount} touch${ob.touchCount !== 1 ? 'es' : ''})`
          : 'Untouched bearish OB nearby';
        pushSell('strategy', 'order-block-strength', -ob.strengthScore, label);
        break;
      }
    }
  }

  // 3. Liquidity (FVG + liquidity pools) — each gated by its own indicator toggle.
  // FVG detection ships from the order-block-strength module, so it follows that indicator's toggle.
  // BUGFIX (аудит: коллизия имени 'liquidity-pools'): эта FVG-proximity
  // контрибуция раньше публиковалась под тем же именем 'liquidity-pools',
  // что и не связанная с ней liquidity-pool-proximity контрибуция ниже
  // (п. 3b/«liquidity pools»-блок) — обе схлопывались в одну строку
  // факторной таблицы ('liquidity-pools: 49% винрейт, N=58'), хотя это два
  // разных по природе сигнала. Из-за этого более ранний фикс (доки
  // "фикс BOS-задвоения + пересчёт весов") по ошибке отключил бонус
  // 'signal-filter'-уровня в signal-filters.ts (отдельный, статистически
  // хороший бакет — 55%/92, см. STRATEGY_BONUS_PATTERNS-документ), вместо
  // того чтобы обнулить именно эту контрибуцию. Переименовано в
  // 'liquidity-fvg', чтобы факторная аналитика считала винрейт раздельно, и
  // контрибуция обнулена (как rsi/bollinger выше) до появления отдельных,
  // раздельных данных по винрейту — но детекция по-прежнему логируется в
  // factors/reasons для постмортема. Бонус в signal-filters.ts восстановлен
  // (см. его собственный комментарий).
  if (hasFeature('order-block-strength')) {
    const fvgs = detectImbalances(candles);
    // detectImbalances() already filters out invalidated zones internally;
    // this is a defence-in-depth re-filter kept under the correct field name
    // (invalidated = full-close invalidation, not touched = CE-touch).
    const activeFvgs = fvgs.filter((f) => !f.invalidated);
    for (const fvg of activeFvgs.slice(-3)) {
      if (fvg.direction === 'bullish' && entryPrice >= fvg.lower && entryPrice <= fvg.upper) {
        pushBuy('strategy', 'liquidity-fvg', 0, 'Untouched bullish FVG nearby (contribution disabled — see factor analysis)');
        break;
      }
      if (fvg.direction === 'bearish' && entryPrice >= fvg.lower && entryPrice <= fvg.upper) {
        pushSell('strategy', 'liquidity-fvg', 0, 'Untouched bearish FVG nearby (contribution disabled — see factor analysis)');
        break;
      }
    }
  }

  // 3b. Level rejection — touch + wick-ratio + failure-to-close on clustered
  // S/R levels. Replaces the removed 'level-reaction' pattern.
  // Uses += so OB proximity contribution in components.zones is not overwritten;
  // an order block and a naked S/R level are distinct phenomena and can co-exist.
  if (hasFeature('level-rejection')) {
    const levelZones = levelRejection(candles, 100, atrPeriod);
    for (const zone of levelZones) {
      const nearZone = Math.abs(entryPrice - zone.price) <= proximity ||
        (entryPrice >= zone.zoneLow && entryPrice <= zone.zoneHigh);
      if (!nearZone) continue;
      const contribution = zone.direction === 'bullish' ? zone.strengthScore : -zone.strengthScore;
      components.zones += contribution;
      const label = zone.status === 'tested-hold'
        ? `Level rejection at ${zone.type} holding (${zone.touchCount} touch${zone.touchCount !== 1 ? 'es' : ''})`
        : `Level ${zone.type} reaction in progress`;
      if (zone.direction === 'bullish') pushBuy('indicator', 'level-rejection', contribution, label);
      else pushSell('indicator', 'level-rejection', contribution, label);
      break;
    }
  }

  // Переименовано 'liquidity-pools' → 'liquidity-pool' (см. комментарий к
  // FVG-блоку выше) — это отдельный от FVG-proximity сигнал, его винрейт
  // ранее не измерялся отдельно, контрибуция сохранена без изменений.
  if (hasFeature('liquidity-pools')) {
    const pools = liquidityPools(candles);
    if (pools.length > 0) {
      const nearestPool = pools.reduce((a, b) =>
        Math.abs(b.price - entryPrice) < Math.abs(a.price - entryPrice) ? b : a,
      );
      if (nearestPool.type === 'buy-side' && Math.abs(nearestPool.price - entryPrice) <= proximity) {
        components.liquidity += 0.3;
        pushBuy('strategy', 'liquidity-pool', 0.3, 'Buy-side liquidity pool nearby');
      } else if (nearestPool.type === 'sell-side' && Math.abs(nearestPool.price - entryPrice) <= proximity) {
        components.liquidity -= 0.3;
        pushSell('strategy', 'liquidity-pool', -0.3, 'Sell-side liquidity pool nearby');
      }
    }
  }

  // 4. Trigger (candlestick pattern) — select by confidence, not array order
  const patterns = snapshot.patterns;
  const selection = selectTopPattern(patterns);
  if (selection) {
    const { top: topPattern, sameDir, fusionConfidence: fusionBoost } = selection;
    const fusionLabel = sameDir.length >= 2
      ? ` + ${sameDir.length - 1} confirming pattern${sameDir.length > 2 ? 's' : ''}`
      : '';
    // Continuation vs. reversal-at-key-level (Spring/Upthrust) label for
    // liquidity-sweep/-reaction — surfaced in reason text so the two setup
    // types can be told apart in the signal history and, eventually,
    // calibrated/reviewed separately (see strategy doc §11 and audit
    // finding #7: they have different false-positive profiles by
    // construction and shouldn't be pooled).
    const setupLabel = topPattern.setupType ? ` [${topPattern.setupType}]` : '';
    const patternArgument = `${topPattern.name} pattern (${(topPattern.confidence * 100).toFixed(0)}%)${fusionLabel}${setupLabel}`;
    // BUGFIX (аудит 2026-09-06, п.4): паттерны в STRATEGY_BONUS_PATTERNS уже
    // получают свой персональный вклад в score через strategy-бонус в
    // signal-builder.ts (evaluateEvidence) — не дублируем его здесь через
    // components.trigger. Реализовано как pushBuy/pushSell с contribution=0
    // (не пропуск целиком), чтобы factors/reasons по-прежнему показывали,
    // что паттерн был обнаружен и выбран как top — это полезная информация
    // для постмортема, — но explicit contribution=0 делает очевидным в
    // самих данных сигнала, что счёт по нему не начислен здесь.
    const isStrategyBonusPattern = STRATEGY_BONUS_PATTERNS.includes(topPattern.name);
    const reliabilityMultiplier = getReliabilityMultiplier(topPattern.name, symbolId);
    const triggerContribution = isStrategyBonusPattern ? 0 : fusionBoost * reliabilityMultiplier;
    if (topPattern.direction === 'buy') {
      components.trigger = triggerContribution;
      pushBuy('pattern', topPattern.name, triggerContribution, patternArgument, topPattern.confidence);
    } else if (topPattern.direction === 'sell') {
      components.trigger = -triggerContribution;
      pushSell('pattern', topPattern.name, -triggerContribution, patternArgument, topPattern.confidence);
    }
  }

  // 5. Indicator (EMA/RSI/Bollinger)
  const ind = snapshot.indicators;
  if (ind.emaFast !== null && ind.emaSlow !== null) {
    if (ind.emaFast > ind.emaSlow) {
      components.indicator += 0.5;
      pushBuy('indicator', 'ema', 0.5, 'EMA fast above slow', ind.emaFast - ind.emaSlow);
    } else if (ind.emaFast < ind.emaSlow) {
      components.indicator -= 0.5;
      pushSell('indicator', 'ema', -0.5, 'EMA fast below slow', ind.emaFast - ind.emaSlow);
    }
  }
  // BUGFIX (факторный анализ): RSI oversold/overbought как автономный сигнал —
  // 25% винрейт на N=10 резолвнутых сделок. Контрибуция обнулена; факт
  // остаётся в reasons/factors для постмортема.
  if (ind.rsi !== null) {
    if (ind.rsi < rsiOversold) {
      pushBuy('indicator', 'rsi', 0, `RSI oversold (${ind.rsi.toFixed(1)}) — contribution disabled, see factor analysis`, ind.rsi);
    } else if (ind.rsi > rsiOverbought) {
      pushSell('indicator', 'rsi', 0, `RSI overbought (${ind.rsi.toFixed(1)}) — contribution disabled, see factor analysis`, ind.rsi);
    }
  }
  components.indicator = Math.max(-1, Math.min(1, components.indicator));

  // 6. MACD histogram — normalized by ATR so the contribution is comparable
  // across instruments/timeframes instead of raw price units.
  if (ind.macdHistogram !== null && atrValue && atrValue > 0) {
    const normalized = ind.macdHistogram / atrValue;
    if (normalized > 0) {
      components.macd = Math.min(1, normalized);
      pushBuy('indicator', 'macd', components.macd, 'MACD histogram positive', ind.macdHistogram);
    } else if (normalized < 0) {
      components.macd = Math.max(-1, normalized);
      pushSell('indicator', 'macd', components.macd, 'MACD histogram negative', ind.macdHistogram);
    }
  }

  // 7. Mean reversion (Bollinger + RSI)
  // BUGFIX (факторный анализ): bollinger touch как автономный сигнал — 0%
  // винрейт на N=8 резолвнутых сделок. Контрибуция обнулена до пересмотра
  // логики/порогов; факт касания полосы по-прежнему логируется для
  // постмортема (contribution=0 делает это явным в самих данных).
  if (ind.bollingerLower !== null && ind.bollingerUpper !== null && ind.bollingerMiddle !== null) {
    if (entryPrice <= ind.bollingerLower) {
      pushBuy('indicator', 'bollinger', 0, 'Price at lower Bollinger band (contribution disabled — see factor analysis)', ind.bollingerLower);
    } else if (entryPrice >= ind.bollingerUpper) {
      pushSell('indicator', 'bollinger', 0, 'Price at upper Bollinger band (contribution disabled — see factor analysis)', ind.bollingerUpper);
    }
  }

  if (!toggles.structure) components.structure = 0;
  if (!toggles.zones) components.zones = 0;
  if (!toggles.liquidity) components.liquidity = 0;
  if (!toggles.trigger) components.trigger = 0;
  if (!toggles.indicator) components.indicator = 0;
  if (!toggles.bos) components.bos = 0;
  if (!toggles.macd) components.macd = 0;
  if (!toggles.meanReversion) components.meanReversion = 0;

  // Compute weighted score, scaled to match the 0-10 evidence range
  let weightedScore = 0;
  for (let i = 0; i < FEATURE_NAMES.length; i++) {
    const name = FEATURE_NAMES[i];
    const weight = DEFAULT_WEIGHTS[name];
    const componentValue = components[name];
    weightedScore += weight * componentValue;
  }
  // Scale from raw weighted sum to the 0-10 score range used by the signal builder
  const scaledScore = weightedScore * 10;

  // Tie (scaledScore === 0): the weighted buy/sell evidence exactly cancels
  // out. That is "no signal", not a silent default to 'buy' — an explicit
  // null keeps buildSignal() from ever emitting a directional signal on a
  // genuine draw, rather than relying on the UI's score-threshold minimum
  // (SettingsPanel.tsx `min: 0.5`) to incidentally filter it out.
  const direction: SignalDirection | null =
    scaledScore > 0 ? 'buy' : scaledScore < 0 ? 'sell' : null;
  const score = Math.abs(scaledScore);

  // Toggles that zeroed out a component above (см. блок if (!toggles.X) ...)
  // must also drop the matching factor(s) — иначе `factors` показывал бы
  // вклад, который реально не попал в score. Тот же принцип, что уже
  // применяется к score через components, просто теперь применяется и к
  // структурной копии причин.
  //
  // BUGFIX (аудит, п.2.2): toggles.structure раньше добавлял сюда и 'bos', и
  // 'choch' — это осталось от старой модели, где BOS был частью structure.
  // После фикса задвоения BOS/CHoCH (см. блок 1 выше) components.bos
  // зануляется ИСКЛЮЧИТЕЛЬНО тумблером toggles.bos (независимо от
  // toggles.structure) — но эта строка по-прежнему прятала честно
  // посчитанный вклад BOS из factors/факторной аналитики, стоило
  // пользователю выключить только «Структуру». Тумблеры должны быть
  // независимы и по score, и по видимости в factors — теперь toggles.structure
  // скрывает только 'choch', а 'bos' скрывается исключительно toggles.bos
  // (см. отдельную строку ниже, она уже была корректной).
  const disabledFactorNames = new Set<string>();
  if (!toggles.structure) { disabledFactorNames.add('choch'); }
  if (!toggles.zones) { disabledFactorNames.add('order-block-strength'); disabledFactorNames.add('level-rejection'); }
  if (!toggles.liquidity) { disabledFactorNames.add('liquidity-fvg'); disabledFactorNames.add('liquidity-pool'); }
  if (!toggles.indicator) { disabledFactorNames.add('rsi'); disabledFactorNames.add('ema'); }
  if (!toggles.bos) { disabledFactorNames.add('bos'); }
  if (!toggles.macd) { disabledFactorNames.add('macd'); }
  if (!toggles.meanReversion) { disabledFactorNames.add('bollinger'); }

  const rawFactors = direction === 'buy' ? buyFactors : direction === 'sell' ? sellFactors : [];
  const factors = rawFactors.filter((f) => {
    if (disabledFactorNames.has(f.name)) return false;
    if (!toggles.trigger && f.kind === 'pattern') return false;
    return true;
  });

  // BUGFIX (аудит, п.2.3): reasons (сырой текстовый массив для UI/history)
  // раньше наполнялся из buyReasons/sellReasons безусловно, до применения
  // toggles — то есть, например, при toggles.indicator=false в reasons всё
  // равно попадал текст "EMA fast below slow", хотя вклад в score уже был
  // равен 0. Это расхождение между "почему сигнал сработал" (текст) и "что
  // реально считалось" (score/factors) вводило в заблуждение постмортем/UI.
  // Теперь reasons строится из того же отфильтрованного набора factors, что
  // и гарантирует 1:1 соответствие текста и структурированных данных.
  const reasons = factors.map((f) => f.argument);

  return { direction, score, components, reasons, factors };
}

export function isPatternInRange(candles: Candle[], snapshot: Snapshot): boolean {
  const levels = supportResistance(candles);
  const last = candles[candles.length - 1];
  // Reuses snapshot.indicators.atr (config.atrPeriod-driven) rather than a
  // hardcoded-period recompute — see computeDirectionScore above.
  const atrValue = snapshot.indicators.atr;
  if (!atrValue || atrValue <= 0) return false;

  const nearLevel = levels.some((l) => Math.abs(last.close - l.price) <= atrValue);
  const obZones = orderBlockStrength(candles, 50, snapshot.structure, true);
  const nearOB = obZones.some((z) =>
    z.status !== 'broken' && last.close >= z.low - atrValue * 0.5 && last.close <= z.high + atrValue * 0.5,
  );
  return !nearLevel && !nearOB;
}
