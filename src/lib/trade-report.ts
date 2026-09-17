import type { Signal, SignalFactor, RejectedPattern } from '@/types/domain';
import { formatDurationShort } from '@/lib/utils';

// Генерирует самодостаточный Markdown-отчёт по одной сделке — предназначен
// для вставки в чат с ИИ (или прочтения человеком) для постмортем-анализа
// убыточной/любой завершённой сделки: какие индикаторы/паттерны/стратегии
// повлияли на решение войти в позицию, какой был рыночный контекст, что
// было отклонено, и как цена вела себя после входа.
//
// ВАЖНО: signal.factors/rejectedPatterns/engineConfigSnapshot/chartContext/
// marketContext могут отсутствовать (undefined) на сигналах, сохранённых
// ДО того, как эти поля появились (старые записи в localStorage/Supabase,
// восстановленные persist-мидлваром без миграции значений) — везде ниже
// используется `?? []`/`?? null`-подобный доступ, а не прямое обращение,
// чтобы экспорт не падал на старой истории.
export function buildPostMortemReport(signal: Signal): string {
  const lines: string[] = [];

  const outcomeLabel = signal.outcome === 'win' ? 'WIN' : signal.outcome === 'loss' ? 'LOSS' : signal.outcome === 'timeout' ? 'TIMEOUT' : 'PENDING';
  const directionLabel = signal.direction === 'buy' ? 'BUY' : 'SELL';
  const dateStr = new Date(signal.time * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  lines.push(`## Сделка ${signal.symbolId} ${signal.timeframe} — ${outcomeLabel}`);
  lines.push('');
  // Реальные проблемы, п.2: SL/TP/recommendedExpiry раньше не попадали в
  // отчёт вообще (barsToResolve был, а уровней сделки — нет). BUGFIX (Фаза 1,
  // "честный бинарный опцион"): SL/TP удалены из движка целиком — бинарный
  // опцион с фиксированной экспирацией/выплатой не имеет структурного
  // стопа/цели, показывать их в постмортеме означало бы намекать на то,
  // чего в сделке не было. Вместо этого — реальная экспирация в барах
  // (expiryBars), тот же параметр, что фактически резолвит исход
  // (см. outcome-scheduler.ts).
  const expiryBars = signal.expiryBars ?? 1;
  lines.push(
    `**Вход:** ${dateStr} · ${directionLabel} · ${formatPrice(signal.entryPrice)} · ` +
    `экспирация ${formatDurationShort(signal.recommendedExpiry)} (${pluralizeBars(expiryBars)}) · ` +
    `score ${signal.score.toFixed(1)} (${signal.strength})` +
    (signal.calibratedProbability !== null
      ? ` · calibratedProbability ${signal.calibratedProbability.toFixed(2)}` +
        // BUGFIX (аудит 2026-09-05): без этой пометки calibratedProbability
        // выглядит как единая, всегда статистически откалиброванная величина
        // — на практике до накопления MIN_SAMPLES исходов это сырая
        // sigmoid-оценка score (см. signal-builder.ts, sigmoidFallback), а
        // не вероятность выигрыша. Постмортем-отчёт должен явно отличать
        // одно от другого, а не подавать оба как «calibratedProbability».
        (signal.calibrationSource === 'fallback' ? ' (не откалибровано — сырая оценка по score, не win-rate)' : '')
      : ''),
  );

  const closePrice = signal.chartContext?.candlesAfter?.[0]?.close ?? null;
  const priceMove = closePrice !== null ? closePrice - signal.entryPrice : null;
  lines.push(
    `**Итог:** ${outcomeLabel}` +
    (closePrice !== null ? ` · закрытие ${formatPrice(closePrice)} (${priceMove! >= 0 ? '+' : ''}${formatPrice(priceMove!)}${signalWentAgainst(signal, priceMove!) ? ' против позиции' : ' в пользу позиции'})` : '') +
    ` · барс до резолва: ${signal.barsToResolve}` +
    (signal.isRevised ? ' · сигнал был пересмотрен (isRevised)' : ''),
  );
  lines.push('');

  const mc = signal.marketContext;
  if (mc) {
    lines.push(
      `**Рынок:** trend=${mc.structure.trend}, regime=${mc.regime}, session=${mc.session}, ` +
      `BOS=${mc.structure.bos}, CHoCH=${mc.structure.choch}` +
      (signal.spread !== null ? `, spread=${signal.spread.toFixed(5)} (${signal.spreadSource ?? 'unknown'})` : ''),
    );
    lines.push('');
  }

  lines.push('**Индикаторы на входе:**');
  lines.push(formatIndicators(signal));
  lines.push('');

  const factors = signal.factors ?? [];
  if (factors.length > 0) {
    lines.push('**Факторы, повлиявшие на сигнал:**');
    for (const f of sortByAbsContribution(factors)) {
      lines.push(`- ${f.argument} (${f.kind}, contribution ${f.contribution >= 0 ? '+' : ''}${f.contribution.toFixed(2)})`);
    }
    lines.push('');
  } else {
    lines.push('**Факторы, повлиявшие на сигнал:** нет данных (сигнал создан до появления структурированной атрибуции)');
    lines.push('');
  }

  const rejected = signal.rejectedPatterns ?? [];
  if (rejected.length > 0) {
    lines.push('**Отклонённые сигналы на этой же свече:**');
    for (const r of rejected) {
      lines.push(`- ${r.name} (confidence ${(r.confidence * 100).toFixed(0)}%, ${r.direction}) — не выбран: ${translateRejectionReason(r.reasonNotSelected)}`);
    }
    lines.push('');
  }

  const cfg = signal.engineConfigSnapshot;
  if (cfg && cfg.indicatorConfig) {
    lines.push('**Конфигурация движка на момент сигнала:**');
    lines.push(
      `scoreThreshold=${cfg.indicatorConfig.scoreThreshold}, rsiOverbought=${cfg.indicatorConfig.rsiOverbought}/oversold=${cfg.indicatorConfig.rsiOversold}, ` +
      `spreadGateMultiplier=${cfg.indicatorConfig.spreadGateMultiplier}`,
    );
    lines.push(`активные паттерны: [${(cfg.activeFeatures ?? []).join(', ')}]`);
    lines.push('');
  }

  const cc = signal.chartContext;
  if (cc && (cc.maxFavorableExcursion !== null || cc.maxAdverseExcursion !== null)) {
    lines.push(
      `**Excursion:** MFE ${formatSigned(cc.maxFavorableExcursion)} · MAE ${formatSigned(cc.maxAdverseExcursion)}` +
      ` (свечей после входа в контексте: ${cc.candlesAfter?.length ?? 0}, до входа: ${cc.candlesBefore?.length ?? 0})`,
    );
    lines.push('');
  }

  lines.push(`**Текстовая сводка причин (as-is):** ${signal.reason}`);

  return lines.join('\n');
}

function pluralizeBars(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${n} баров`;
  if (mod10 === 1) return `${n} бар`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} бара`;
  return `${n} баров`;
}

function signalWentAgainst(signal: Signal, priceMove: number): boolean {
  return signal.direction === 'buy' ? priceMove < 0 : priceMove > 0;
}

function sortByAbsContribution(factors: SignalFactor[]): SignalFactor[] {
  return [...factors].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
}

function translateRejectionReason(reason: RejectedPattern['reasonNotSelected']): string {
  switch (reason) {
    case 'opposite-direction': return 'встречное направление';
    case 'lower-class-priority': return 'ниже по приоритету класса паттерна';
    case 'lower-confidence': return 'ниже по уверенности при равном приоритете';
  }
}

function formatPrice(v: number): string {
  // Достаточно знаков для форекс-пар (5 знаков) и крипты (2-8 в зависимости
  // от цены) — не идеально под каждый инструмент, но лучше, чем фиксированный
  // toFixed(2), который на EURUSD-подобных парах обнулял бы всю значимую
  // часть движения цены.
  const abs = Math.abs(v);
  const decimals = abs >= 100 ? 2 : abs >= 1 ? 4 : 5;
  return v.toFixed(decimals);
}

function formatSigned(v: number | null): string {
  if (v === null) return 'n/a';
  return `${v >= 0 ? '+' : ''}${formatPrice(v)}`;
}

function formatIndicators(signal: Signal): string {
  const ind = signal.indicators;
  if (!ind) return 'нет данных';
  const parts: string[] = [];
  if (ind.rsi !== null) parts.push(`RSI ${ind.rsi.toFixed(1)}`);
  if (ind.emaFast !== null) parts.push(`EMA fast ${formatPrice(ind.emaFast)}`);
  if (ind.emaSlow !== null) parts.push(`EMA slow ${formatPrice(ind.emaSlow)}`);
  if (ind.macdHistogram !== null) parts.push(`MACD hist ${ind.macdHistogram.toFixed(5)}`);
  if (ind.atr !== null) parts.push(`ATR ${formatPrice(ind.atr)}`);
  if (ind.bollingerUpper !== null) parts.push(`BB upper ${formatPrice(ind.bollingerUpper)}`);
  if (ind.bollingerLower !== null) parts.push(`BB lower ${formatPrice(ind.bollingerLower)}`);
  if (ind.adx !== null) parts.push(`ADX ${ind.adx.toFixed(1)}`);
  if (ind.vwap !== null) parts.push(`VWAP ${formatPrice(ind.vwap)}${ind.vwapIsProxyVolume ? ' (proxy volume)' : ''}`);
  return parts.join(' · ') || 'нет данных';
}
