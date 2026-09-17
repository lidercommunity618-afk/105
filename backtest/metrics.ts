import type { SimulatedTrade } from './simulator';
import { getSessionRegime, type SessionRegime } from '@/compute/session-regime';
import { nextLossStreak } from '@/decision/loss-streak-guard';

export interface ReliabilityBin {
  binStart: number;
  binEnd: number;
  count: number;
  avgPredicted: number;
  avgActual: number;
}

export interface BacktestMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;
  averageR: number;
  brierScore: number;
  maxDrawdownR: number;
  profitFactor: number;
  // АУДИТ 2026-09-13 ("не допустить 3 убыточные сделки подряд"): до этого
  // поля в бэктесте не было НИКАКОЙ метрики серийности вообще —
  // winRate/profitFactor усредняют по всей выборке и не видят порядок
  // сделок, поэтому нельзя было даже ИЗМЕРИТЬ, помогает ли то или иное
  // изменение именно с кластеризацией убытков, а не просто с общим
  // винрейтом (high-volatility régime автокоррелирован — см.
  // signal-filters.ts::HIGH_VOL_GATE_* — один и тот же winRate может
  // скрывать очень разное распределение длин убыточных серий). Считается
  // той же чистой nextLossStreak(), что и живой движок (см.
  // decision/loss-streak-guard.ts) — единый источник правды для обоих
  // путей, а не два независимых расчёта серийности.
  maxConsecutiveLosses: number;
  // Фаза 3 ("экономика выплаты и accuracy направления"): доля ВЕРНЫХ
  // ЗНАКОВ ДВИЖЕНИЯ (close на expiryBars выше/ниже entryPrice по
  // направлению сигнала) — считается по SimulatedTrade.rawOutcome, ДО
  // applySpreadToOutcome(). Намеренно НЕ то же самое, что winRate выше:
  // winRate зависит от того, что применена спред-поправка (пограничные по
  // спреду выигрыши уже стали timeout и выпали из decided=wins+losses);
  // directionAccuracy — нет, она вообще не знает о существовании спреда
  // или profitPercent. Это и есть та метрика, на вход которой рассчитана
  // Фаза 2 (patternWeightByAccuracy) и колонка "Backtest: лучший
  // expiryBars" в pattern-audit-checklist.md — не winRate.
  directionAccuracy: number;
  reliabilityBins: ReliabilityBin[];
}

export interface SplitMetrics {
  inSample: BacktestMetrics;
  outOfSample: BacktestMetrics;
  all: BacktestMetrics;
}

// BUGFIX (аудит 2026-09-13, "R-модель бэктеста не совпадает с реальной
// экономикой демо-счёта"): раньше здесь стояли WIN_R=2/LOSS_R=-1 —
// классическая модель со стоп-лоссом/тейк-профитом 2:1 (риск $1 → цель
// $2). Реальный демо-счёт (useDemoAccountStore.ts) и калибровка
// (pattern-reliability-calibration.ts) считают исход как бинарный
// контракт с фиксированной выплатой profitPercent% при выигрыше (по
// умолчанию 80%) и потерей ВСЕЙ ставки при проигрыше — две принципиально
// разные модели экономики с разной точкой безубыточности: 2:1-модель
// безубыточна уже при winRate=33.3%, тогда как payout=80% требует
// winRate>=55.56%. averageR/profitFactor, посчитанные по старой модели,
// не переводились напрямую в то, что реально произойдёт на демо-счёте.
//
// Теперь win/loss/timeout считаются в тех же единицах, что и pnl на
// реальном демо-счёте: доля возврата НА ЕДИНИЦУ СТАВКИ.
//   win     -> +profitPercent/100 (напр. +0.8 при payout 80%)
//   loss    -> -1 (вся ставка)
//   timeout -> 0 (ставка возвращается — см. isTie/isWithinSpread в
//               useDemoAccountStore.ts::resolveTrade)
// Поля averageR/maxDrawdownR в интерфейсе ниже НЕ переименованы (чтобы не
// расширять блast radius правки на report.ts/JSON-потребителей без
// отдельного решения), но по смыслу это больше не "R" в традиционном
// смысле мультипликатора риска, а "доходность на $1 ставки" — см.
// docs/audit/WALK_FORWARD_PROTOCOL.md, раздел про это ограничение
// (теперь устранённое).
//
// spreadCostR (per-trade диагностика, не убрана) больше НЕ вычитается из
// R: в бинарном контракте с фиксированной выплатой payout не
// масштабируется непрерывно от того, насколько сильно цена прошла
// пороговое значение (в этом и есть смысл "бинарности" — либо получаешь
// весь payout, либо ничего), поэтому непрерывная "спред съел X% движения"
// поправка не имеет экономического смысла поверх уже дискретного win/loss.
// Реальная стоимость спреда для экономики уже полностью учтена ВЫШЕ по
// пайплайну — decision/apply-spread.ts::applySpreadToOutcome()
// переразмечает пограничные 'win' в 'timeout' ДО того, как сделка вообще
// попадает сюда (см. simulator.ts). Оставлять после этого ещё и
// непрерывное вычитание было бы двойным учётом одной и той же стоимости.
export function computeMetrics(trades: SimulatedTrade[], profitPercent: number): BacktestMetrics {
  const total = trades.length;
  const wins = trades.filter((t) => t.outcome === 'win').length;
  const losses = trades.filter((t) => t.outcome === 'loss').length;
  const timeouts = trades.filter((t) => t.outcome === 'timeout').length;

  // BUGFIX (аудит 2026-09-13, тот же разбор): раньше winRate = wins/total
  // включал timeouts в знаменатель — единственное место во всём проекте,
  // считавшее винрейт так; useAnalyticsStore.recomputeStats() (реальные
  // демо-сделки, видимые пользователю) и computeForwardTestReport() из
  // change-registry.ts, использующий это же поле для вердикта, всегда
  // исключают timeout из знаменателя (timeout — не выигрыш и не проигрыш,
  // ставка просто возвращается). Расхождение делало winRate здесь
  // занижённым на любой выборке с ненулевыми timeout — и напрямую искажало
  // вердикт forward-теста в сторону "below-breakeven" сильнее, чем
  // обосновано данными.
  const decided = wins + losses;
  const winRate = decided > 0 ? wins / decided : 0;

  const winReturn = profitPercent / 100;
  const rValues = trades.map((t) => {
    if (t.outcome === 'win') return winReturn;
    if (t.outcome === 'loss') return -1;
    return 0;
  });

  const averageR = total > 0 ? rValues.reduce((a, b) => a + b, 0) / total : 0;

  const brierScore =
    total > 0
      ? trades.reduce((sum, t) => {
          const prob = t.signal.calibratedProbability ?? 0.5;
          const actual = t.outcome === 'win' ? 1 : 0;
          return sum + (prob - actual) ** 2;
        }, 0) / total
      : 0;

  let cumulative = 0;
  let peak = 0;
  let maxDD = 0;
  for (const r of rValues) {
    cumulative += r;
    peak = Math.max(peak, cumulative);
    maxDD = Math.max(maxDD, peak - cumulative);
  }

  const grossProfit = rValues.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rValues.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // АУДИТ 2026-09-13: серия считается в исходном хронологическом порядке
  // `trades` (как переданы вызывающим кодом — computeSplitMetrics/
  // computeMetricsBySession передают сюда уже отфильтрованные, но
  // ПОРЯДОК-СОХРАНЯЮЩИЕ подмассивы, см. .filter() ниже в этом файле), а не
  // пересортировывается здесь — как и остальные метрики в этой функции.
  // 'timeout' пропускается (не продолжает и не обрывает серию) — та же
  // конвенция, что уже использует winRate чуть выше (decided = wins +
  // losses).
  let streak = 0;
  let maxConsecutiveLosses = 0;
  for (const t of trades) {
    if (t.outcome !== 'win' && t.outcome !== 'loss') continue;
    streak = nextLossStreak(streak, t.outcome);
    if (streak > maxConsecutiveLosses) maxConsecutiveLosses = streak;
  }

  // Фаза 3: то же исключение timeout из знаменателя, что и у winRate выше
  // (см. её собственный комментарий про decided = wins + losses) — но по
  // rawOutcome (до спред-поправки), не по outcome. На rawOutcome timeout
  // возможен только при ТОЧНОМ равенстве close === entryPrice (см.
  // resolveOutcome) — на практике почти никогда, в отличие от outcome,
  // где спред-поправка регулярно превращает пограничные win в timeout.
  const rawWins = trades.filter((t) => t.rawOutcome === 'win').length;
  const rawLosses = trades.filter((t) => t.rawOutcome === 'loss').length;
  const rawDecided = rawWins + rawLosses;
  const directionAccuracy = rawDecided > 0 ? rawWins / rawDecided : 0;

  return {
    totalTrades: total,
    wins,
    losses,
    timeouts,
    winRate,
    averageR,
    brierScore,
    maxDrawdownR: maxDD,
    profitFactor,
    maxConsecutiveLosses,
    directionAccuracy,
    reliabilityBins: computeReliabilityBins(trades),
  };
}

export function computeSplitMetrics(trades: SimulatedTrade[], profitPercent: number): SplitMetrics {
  const inSample = trades.filter((t) => t.inSample);
  const outOfSample = trades.filter((t) => !t.inSample);
  return {
    inSample: computeMetrics(inSample, profitPercent),
    outOfSample: computeMetrics(outOfSample, profitPercent),
    all: computeMetrics(trades, profitPercent),
  };
}

// Задача 1.2.3 — group trades by the same session-regime classification
// signal-builder.ts's sessionFilter gate uses (getSessionRegime), so
// backtest/report.ts can show whether e.g. the Asian session really does
// have a worse winRate on a given pair — measured from data, not assumed.
// 'closed' is included for completeness even though signal-builder.ts's
// gate never blocks on it (see isSessionAllowed) — a nonzero count there
// would itself be worth investigating.
export function computeMetricsBySession(
  trades: SimulatedTrade[],
  profitPercent: number,
): Record<SessionRegime, BacktestMetrics> {
  const groups: Record<SessionRegime, SimulatedTrade[]> = {
    sydney: [], tokyo: [], london: [], newyork: [], overlap: [], closed: [],
  };
  for (const trade of trades) {
    const session = getSessionRegime(trade.signal.time * 1000);
    groups[session].push(trade);
  }
  return {
    sydney: computeMetrics(groups.sydney, profitPercent),
    tokyo: computeMetrics(groups.tokyo, profitPercent),
    london: computeMetrics(groups.london, profitPercent),
    newyork: computeMetrics(groups.newyork, profitPercent),
    overlap: computeMetrics(groups.overlap, profitPercent),
    closed: computeMetrics(groups.closed, profitPercent),
  };
}

function computeReliabilityBins(trades: SimulatedTrade[]): ReliabilityBin[] {
  const numBins = 10;
  const bins: ReliabilityBin[] = [];

  for (let i = 0; i < numBins; i++) {
    const binStart = i / numBins;
    const binEnd = (i + 1) / numBins;
    const inBin = trades.filter((t) => {
      const prob = t.signal.calibratedProbability ?? 0.5;
      if (i === numBins - 1) return prob >= binStart && prob <= binEnd;
      return prob >= binStart && prob < binEnd;
    });

    bins.push({
      binStart,
      binEnd,
      count: inBin.length,
      avgPredicted:
        inBin.length > 0
          ? inBin.reduce((s, t) => s + (t.signal.calibratedProbability ?? 0.5), 0) / inBin.length
          : 0,
      avgActual:
        inBin.length > 0 ? inBin.filter((t) => t.outcome === 'win').length / inBin.length : 0,
    });
  }

  return bins;
}
