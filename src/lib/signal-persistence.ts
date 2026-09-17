import type { Signal, SignalOutcome, Timeframe, CalibrationState, SignalFactor, RejectedPattern, EngineConfigSnapshot, ChartContext, MarketContext } from '@/types/domain';
import { EMPTY_CHART_CONTEXT } from '@/types/domain';
import type { CalibrationSample } from '@/decision/calibration-model';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';
import { addBreadcrumb } from '@/lib/sentry';
import { getClientId } from '@/lib/client-id';

const DELETE_PROXY_TIMEOUT_MS = 12_000;

export interface SignalRow {
  id: string;
  symbol_id: string;
  timeframe: string;
  direction: string;
  strength: string;
  score: number;
  calibrated_probability: number | null;
  entry_price: number;
  reason: string;
  pattern: string | null;
  indicators: Record<string, unknown>;
  outcome: string;
  is_revised: boolean;
  is_pre_close: boolean;
  revision_note: string | null;
  bars_to_resolve: number;
  spread: number | null;
  spread_source: string | null;
  recommended_expiry: number;
  // См. Signal.expiryBars в types/domain.ts. Nullable — колонка добавлена
  // после исходной таблицы (см. миграцию *_add_expiry_bars_column.sql);
  // старые строки хранят NULL, трактуется как 1 бар при чтении (rowToSignal).
  expiry_bars: number | null;
  feature_vector: number[];
  signal_time: number;
  frozen_at: number | null;
  created_at: string;
  // Атрибуция сигнала (см. supabase/migrations/2026090*_add_signal_attribution_columns.sql).
  // Nullable в самом типе строки (не в БД — там NOT NULL DEFAULT), потому
  // что старые SELECT * без явного .select() всё равно вернут значение по
  // умолчанию из миграции, но на всякий случай на стороне клиента не
  // полагаемся на это как на гарантию.
  factors: SignalFactor[] | null;
  rejected_patterns: RejectedPattern[] | null;
  engine_config_snapshot: EngineConfigSnapshot | null;
  chart_context: ChartContext | null;
  market_context: MarketContext | null;
}

// Экспортированы (были module-private) ради интеграционного теста Фазы 0
// п.5 ("карточка, БД-запись и фактическое закрытие сделки ссылаются на
// один и тот же expiryBars") — см. decision/expiry-consistency.test.ts.
// Раньше round-trip этого маппинга не был протестирован вообще:
// signal-persistence.test.ts проверяет только no-op-фолбэк при
// неподключённом Supabase, ни разу не вызывая ни одну из этих функций.
export function signalToRow(s: Signal): Record<string, unknown> {
  return {
    id: s.id,
    symbol_id: s.symbolId,
    timeframe: s.timeframe,
    direction: s.direction,
    strength: s.strength,
    score: s.score,
    calibrated_probability: s.calibratedProbability,
    entry_price: s.entryPrice,
    reason: s.reason,
    pattern: s.pattern,
    indicators: s.indicators,
    outcome: s.outcome,
    is_revised: s.isRevised,
    is_pre_close: s.isPreClose,
    revision_note: s.revisionNote,
    bars_to_resolve: s.barsToResolve,
    spread: s.spread,
    spread_source: s.spreadSource,
    recommended_expiry: s.recommendedExpiry,
    expiry_bars: s.expiryBars ?? null,
    feature_vector: s.featureVector,
    signal_time: s.time,
    frozen_at: s.frozenAt,
    factors: s.factors,
    rejected_patterns: s.rejectedPatterns,
    engine_config_snapshot: s.engineConfigSnapshot,
    chart_context: s.chartContext,
    market_context: s.marketContext,
  };
}

export function rowToSignal(r: SignalRow): Signal {
  return {
    id: r.id,
    symbolId: r.symbol_id,
    timeframe: r.timeframe as Timeframe,
    direction: r.direction as Signal['direction'],
    strength: r.strength as Signal['strength'],
    score: r.score,
    calibratedProbability: r.calibrated_probability,
    entryPrice: r.entry_price,
    reason: r.reason,
    pattern: r.pattern as Signal['pattern'],
    indicators: r.indicators as unknown as Signal['indicators'],
    outcome: r.outcome as SignalOutcome,
    frozenAt: r.frozen_at,
    isRevised: r.is_revised,
    isPreClose: r.is_pre_close,
    revisionNote: r.revision_note,
    barsToResolve: r.bars_to_resolve,
    spread: r.spread,
    spreadSource: r.spread_source as Signal['spreadSource'],
    recommendedExpiry: r.recommended_expiry,
    expiryBars: r.expiry_bars ?? undefined,
    featureVector: r.feature_vector,
    time: r.signal_time,
    // ?? — строки, сохранённые ДО миграции атрибуции (или прочитанные до
    // бэкофилла), могут не содержать этих колонок в ответе PostgREST в
    // редких edge-кейсах кэширования схемы; безопасные пустые дефолты,
    // те же, что EMPTY_CHART_CONTEXT/DEFAULT_SIGNAL_TOGGLES используют
    // в остальном приложении.
    factors: r.factors ?? [],
    rejectedPatterns: r.rejected_patterns ?? [],
    engineConfigSnapshot: r.engine_config_snapshot ?? ({} as EngineConfigSnapshot),
    chartContext: r.chart_context ?? EMPTY_CHART_CONTEXT,
    marketContext: r.market_context ?? {
      regime: 'range',
      structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false },
      session: 'closed',
    },
  };
}

/**
 * Save a signal to the database. Silently does nothing if Supabase is not configured.
 */
export async function saveSignal(signal: Signal): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from('trading_signals')
      .upsert(signalToRow(signal), { onConflict: 'id' });
    if (error) {
      addBreadcrumb('saveSignal failed', { error: error.message });
    }
  } catch {
    // Non-fatal: app works in-memory without persistence
  }
}

/**
 * Update a signal's outcome in the database.
 */
export async function updateSignalOutcome(
  signalId: string,
  outcome: SignalOutcome,
): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from('trading_signals')
      .update({ outcome })
      .eq('id', signalId);
    if (error) {
      addBreadcrumb('updateSignalOutcome failed', { error: error.message });
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Update a signal's chart context (candlesAfter + MFE/MAE) in the database —
 * computed separately from the outcome, in the moment the outcome resolves
 * (see tick-store/outcomes.ts::maybeResolveOutcomes). Purely descriptive,
 * used only by the post-mortem export (lib/trade-report.ts) — never read by
 * any decision-making code, so failures here are safe to swallow same as
 * every other function in this module.
 */
export async function updateSignalChartContext(
  signalId: string,
  chartContext: ChartContext,
): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from('trading_signals')
      .update({ chart_context: chartContext })
      .eq('id', signalId);
    if (error) {
      addBreadcrumb('updateSignalChartContext failed', { error: error.message });
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Load recent signals for a symbol+timeframe, newest first.
 * Returns empty array if Supabase is not configured.
 */
export async function loadRecentSignals(
  symbolId: string,
  timeframe: Timeframe,
  limit: number,
): Promise<Signal[]> {
  if (!isSupabaseConfigured) return [];
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('trading_signals')
      .select('*')
      .eq('symbol_id', symbolId)
      .eq('timeframe', timeframe)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      addBreadcrumb('loadRecentSignals failed', { error: error.message });
      return [];
    }
    if (!data || data.length === 0) return [];
    return (data as SignalRow[]).map(rowToSignal);
  } catch {
    return [];
  }
}


/**
 * Delete every row from trading_signals — used when the user explicitly
 * clears the signal history from the sidebar ("Удалить всё"). Unlike
 * saveSignal/updateSignalOutcome (per-signal, id-scoped), this wipes the
 * whole table: the sidebar history is not filtered by symbol/timeframe, so
 * a partial (symbol-scoped) delete would leave rows behind that the user
 * already saw removed from the UI, silently resurrecting them the moment
 * anything ever reads trading_signals back (e.g. a future loadRecentSignals
 * call). Silently does nothing if Supabase is not configured — same
 * fallback contract as every other function in this module.
 *
 * Аудит, п.3 (security): раньше это был прямой `.delete()` анонимным
 * ключом (anon-политика DELETE на trading_signals). Anon-ключ встроен в
 * клиентский бандл и публично виден в каждом сетевом запросе — то есть
 * ЛЮБОЙ, кто его скопировал, мог одним запросом мгновенно стереть общую
 * историю сигналов для всех пользователей деплоя, без ограничения частоты.
 * Теперь массовое удаление проксируется через edge-функцию
 * `delete-all-signals`, которая сама выполняет DELETE service-role ключом
 * на сервере (anon-ключ такого права больше не имеет — см. миграцию
 * 20260828_lock_down_signals_and_calibration_delete.sql) и ограничена
 * rate-limit'ом (см. supabase/functions/delete-all-signals/index.ts).
 */
export async function deleteAllSignals(): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const url = import.meta.env.VITE_SUPABASE_URL;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anonKey) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELETE_PROXY_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${url}/functions/v1/delete-all-signals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${anonKey}`,
          'X-Client-Key': getClientId(),
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      addBreadcrumb('deleteAllSignals failed', { error: body.error ?? `HTTP ${res.status}` });
    }
  } catch (err) {
    // Non-fatal: local/in-memory history is still cleared by the caller
    // even if the DB delete fails.
    addBreadcrumb('deleteAllSignals failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Save calibration state (weights, bias, samples) to the database.
 *
 * Этап 1 аудита ("КАЛИБРОВКА"/"АНАЛИТИКА ПО ФАКТОРАМ" не связаны, п.2):
 * раньше calibration_state был singleton-таблицей (один фиксированный
 * CALIBRATION_ROW_ID на всё приложение) — теперь строка на инструмент,
 * ключ конфликта — symbol_id (см. миграцию, добавляющую этот столбец и
 * снимающую singleton-CHECK). symbolId по умолчанию 'BTCUSDT' сохраняет
 * обратную совместимость с вызовами без параметра (см.
 * signal-persistence.test.ts), где Supabase всё равно не сконфигурирован
 * и до реального запроса дело не доходит.
 */
export async function saveCalibrationState(
  state: CalibrationState,
  samples: CalibrationSample[],
  symbolId: string = 'BTCUSDT',
): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from('calibration_state')
      .upsert({
        symbol_id: symbolId,
        weights: state.weights,
        bias: state.bias,
        sample_count: state.sampleCount,
        samples: samples as unknown as Record<string, unknown>,
        // BUGFIX (аудит "калибровка: 0 сигналов после 100"): персистим
        // z-score статистики нормализации вместе с weights — без них
        // weights, загруженные обратно на другом устройстве/вкладке через
        // loadCalibrationStateFromDb(), интерпретировались бы неверно (тот
        // же класс бага, что и в CalibrationModel — см.
        // calibration-model.ts::trainLogisticRegression). null допустим —
        // столбцы nullable для обратной совместимости со старыми строками
        // (см. миграцию calibration_state_feature_normalization).
        feature_mean: state.featureMean ?? null,
        feature_std: state.featureStd ?? null,
      }, { onConflict: 'symbol_id' });
    if (error) {
      addBreadcrumb('saveCalibrationState failed', { error: error.message });
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Load calibration state for a given instrument from the database.
 * Returns null if Supabase is not configured or no state exists yet for
 * this symbolId.
 */
export async function loadCalibrationStateFromDb(symbolId: string = 'BTCUSDT'): Promise<{
  state: CalibrationState;
  samples: CalibrationSample[];
} | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('calibration_state')
      .select('weights, bias, sample_count, samples, feature_mean, feature_std')
      .eq('symbol_id', symbolId)
      .maybeSingle();
    if (error) {
      addBreadcrumb('loadCalibrationStateFromDb failed', { error: error.message, symbolId });
      return null;
    }
    if (!data) return null;
    return {
      state: {
        weights: data.weights as number[],
        bias: data.bias as number,
        sampleCount: data.sample_count as number,
        // BUGFIX (аудит "калибровка: 0 сигналов после 100"): столбцы
        // nullable (старые строки, записанные до этого фикса, их не имеют)
        // — приводим null к undefined, а не к [], чтобы
        // CalibrationModel.loadState() корректно отличило "легаси-строка,
        // нормализации нет вообще" от "нормализация — пустой массив"
        // (последнего не бывает, но undefined — явный, а не угаданный сигнал).
        featureMean: (data.feature_mean as number[] | null) ?? undefined,
        featureStd: (data.feature_std as number[] | null) ?? undefined,
      },
      samples: Array.isArray(data.samples) ? (data.samples as CalibrationSample[]) : [],
    };
  } catch {
    return null;
  }
}
