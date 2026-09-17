import { useEffect, useRef, useMemo, useState } from 'react';
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type IPriceLine,
  type Time,
} from 'lightweight-charts';
import type { Candle, IndicatorSnapshot, IndicatorSeries, SeriesPoint, Signal } from '@/types/market';
import { useSettingsStore } from '@/stores/settingsStore';
import { findSymbol } from '@/data/symbols';
import { computeStructure } from '@/compute/indicators/trend-structure';
import { supportResistance } from '@/compute/indicators/support-resistance';
import { ema } from '@/compute/indicators/ema';
import { macd } from '@/compute/indicators/macd';
import { calcSmartMoney } from '@/compute/indicators/smart-money';
import { detectHarmonicPattern } from '@/compute/patterns/harmonic-pattern';
import { findHarmonicZigZagPoints, type ZigZagPoint } from '@/compute/indicators/zigzag';
import { fvgRenderCutoff } from '@/compute/indicators/fvg-core';
import { BoxOverlayPrimitive, type ChartBoxData } from '@/ui/BoxOverlayPrimitive';
import { clsx, getSignalEntryTime } from '@/lib/utils';
import { useAnalyticsStore } from '@/stores/useAnalyticsStore';
import { EntryPointPopup } from '@/ui/EntryPointPopup';
import {
  CHART_BG,
  CHART_GRID_LINE,
  CHART_SCALE_BORDER,
  CHART_UP_COLOR,
  CHART_DOWN_COLOR,
} from '@/lib/chart-theme';

interface ChartPanelProps {
  candles: Candle[];
  snapshot: IndicatorSnapshot | null;
  series: IndicatorSeries | null;
  // История сигналов текущего символа/таймфрейма — источник точек входа,
  // отображаемых на графике (см. showEntryPoints в settingsStore). App.tsx
  // передаёт сюда useAnalyticsStore.signals, уже отфильтрованный по
  // symbolId+timeframe. Опционален (по умолчанию []) — существующие
  // сценарии использования ChartPanel без сигналов (если такие есть)
  // продолжают работать без изменений.
  signals?: Signal[];
}

interface ChartDataState {
  lastCandleTime: number | null;
  candleCount: number;
}

function toLineData(candles: Candle[], values: (number | null)[]): { time: Time; value: number }[] {
  const result: { time: Time; value: number }[] = [];
  for (let i = 0; i < candles.length && i < values.length; i++) {
    const v = values[i];
    if (v !== null && !Number.isNaN(v)) {
      result.push({ time: candles[i].time as Time, value: v });
    }
  }
  return result;
}

function seriesToLineData(points: SeriesPoint[]): { time: Time; value: number }[] {
  return points
    .filter((p) => p.value !== null && !Number.isNaN(p.value))
    .map((p) => ({ time: p.time as Time, value: p.value as number }));
}

export function ChartPanel({ candles, series, signals = [] }: ChartPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ema20Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ema50Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ema200Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const bollUpperRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bollLowerRef = useRef<ISeriesApi<'Line'> | null>(null);
  const macdHistRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  // Отдельный слой маркеров от markersRef (BOS/CHOCH) — разные жизненные
  // циклы: BOS-маркер перерисовывается на каждую свечу и держит максимум
  // 2 актуальных маркера, точки входа — исторический накопительный список
  // по signals, который обновляется независимо (см. useEffect ниже).
  const entryMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  // Сигналы, чьи маркеры сейчас реально нарисованы на entryMarkersRef —
  // читается синхронно внутри handleChartClick (см. setup-эффект ниже),
  // который регистрируется один раз и не может напрямую видеть свежий
  // React-стейт/props без пересоздания подписки на каждый рендер.
  const entrySignalsRef = useRef<Signal[]>([]);
  // Третий независимый слой маркеров (после markersRef и entryMarkersRef) —
  // подписанные буквами точки X/A/B/C/D гармонического паттерна. MVP-версия
  // визуализации без соединяющей ломаной линии (см. комментарий у
  // findHarmonicZigZagPoints/ChartBoxData PRZ выше) — полноценный
  // LinePathOverlayPrimitive по архитектуре BoxOverlayPrimitive планируется
  // отдельной итерацией.
  const harmonicMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const boxPrimitiveRef = useRef<BoxOverlayPrimitive | null>(null);
  const srPriceLinesRef = useRef<IPriceLine[]>([]);
  const bosPriceLinesRef = useRef<IPriceLine[]>([]);
  const dataStateRef = useRef<ChartDataState>({ lastCandleTime: null, candleCount: 0 });
  const symbolId = useSettingsStore((s) => s.symbolId);
  const timeframe = useSettingsStore((s) => s.timeframe);
  const harmonicMinLegAtr = useSettingsStore((s) => s.indicators.harmonicMinLegAtr);
  const harmonicFibTolerancePct = useSettingsStore((s) => s.indicators.harmonicFibTolerancePct);
  const harmonicHtfFactor = useSettingsStore((s) => s.indicators.harmonicHtfFactor);
  const showBosLayer = useSettingsStore((s) => s.showBosLayer);
  const showOrderBlocks = useSettingsStore((s) => s.showOrderBlocks);
  const showImbalances = useSettingsStore((s) => s.showImbalances);
  const showSupportResistance = useSettingsStore((s) => s.showSupportResistance);
  const showEma20 = useSettingsStore((s) => s.showEma20);
  const showEma50 = useSettingsStore((s) => s.showEma50);
  const showEma200 = useSettingsStore((s) => s.showEma200);
  const showBollinger = useSettingsStore((s) => s.showBollinger);
  const showMacd = useSettingsStore((s) => s.showMacd);
  const showRejectionBlocks = useSettingsStore((s) => s.showRejectionBlocks);
  const showHarmonicPatterns = useSettingsStore((s) => s.showHarmonicPatterns);
  const showEntryPoints = useSettingsStore((s) => s.showEntryPoints);
  // Выбор конкретных сигналов для отображения стрелкой на графике —
  // управляется кликом по строке в ИСТОРИЯ СИГНАЛОВ (SignalFeed.tsx/
  // SignalCard.tsx), а не автоматическим показом всех сигналов в
  // видимом диапазоне (см. JSDoc у selectedChartSignalIds в
  // useAnalyticsStore.ts).
  const selectedChartSignalIds = useAnalyticsStore((s) => s.selectedChartSignalIds);
  const symbol = findSymbol(symbolId);
  // Сигнал, по которому кликнули на графике — попап с факторами/экспортом
  // (EntryPointPopup). Локальный UI-стейт компонента, не персистится и не
  // трогает settingsStore/analyticsStore.
  const [selectedSignal, setSelectedSignal] = useState<Signal | null>(null);

  const closes = useMemo(() => candles.map((c) => c.close), [candles]);
  const ema20Data = useMemo(() => ema(closes, 20), [closes]);
  const ema50Data = useMemo(() => ema(closes, 50), [closes]);
  const ema200Data = useMemo(() => ema(closes, 200), [closes]);
  const macdData = useMemo(() => macd(closes, 12, 26, 9), [closes]);
  const smartMoney = useMemo(() => calcSmartMoney(candles), [candles]);
  // Гармонический паттерн для отображения на графике — считается локально
  // из candles (та же декуплированная от движка визуализация, что и
  // smartMoney/EMA/MACD выше в этом компоненте), с параметрами из
  // индикаторного конфига пользователя (SettingsPanel → HARMONIC_FIELDS),
  // чтобы отрисовка совпадала с тем, что реально настроено. structure/
  // smartMoney/session не критичны для геометрии — передаём undefined для
  // session (влияет только на небольшой confidence-бонус, не на
  // геометрию/направление).
  const harmonicPattern = useMemo(() => {
    if (!showHarmonicPatterns) return null;
    const structureForHarmonic = computeStructure(candles);
    return detectHarmonicPattern(candles, undefined, undefined, structureForHarmonic, smartMoney, {
      minLegAtr: harmonicMinLegAtr,
      fibTolerancePct: harmonicFibTolerancePct,
      htfFactor: harmonicHtfFactor,
      // BUGFIX (Фаза 1, "честный бинарный опцион"): minRR удалён из
      // HarmonicConfig целиком — детектор его никогда не читал (см.
      // комментарий в compute/patterns/harmonic-pattern.ts), это был
      // мёртвый параметр, плюс сюда же передан не был бы объект
      // HarmonicConfig, если добавить лишнее поле.
    });
  }, [candles, smartMoney, showHarmonicPatterns, harmonicMinLegAtr, harmonicFibTolerancePct, harmonicHtfFactor]);
  // Сырые X-A-B-C-D точки — отдельно от harmonicPattern (который несёт
  // только тип/PRZ/направление), для отрисовки подписанных маркеров ниже.
  // Тот же вход, что и у детектора выше, поэтому если harmonicPattern
  // найден, эти точки гарантированно тоже найдутся.
  const harmonicZigZagPoints: ZigZagPoint[] | null = useMemo(() => {
    if (!harmonicPattern) return null;
    return findHarmonicZigZagPoints(candles, harmonicMinLegAtr, harmonicHtfFactor);
  }, [candles, harmonicPattern, harmonicMinLegAtr, harmonicHtfFactor]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: CHART_BG },
        textColor: '#8294b0',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: CHART_GRID_LINE },
        horzLines: { color: CHART_GRID_LINE },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#3385ff', width: 1, style: 2 },
        horzLine: { color: '#3385ff', width: 1, style: 2 },
      },
      rightPriceScale: { borderColor: CHART_SCALE_BORDER },
      timeScale: { borderColor: CHART_SCALE_BORDER, timeVisible: true, secondsVisible: false },
      width: container.clientWidth,
      height: container.clientHeight,
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: CHART_UP_COLOR,
      downColor: CHART_DOWN_COLOR,
      wickUpColor: CHART_UP_COLOR,
      wickDownColor: CHART_DOWN_COLOR,
      borderVisible: false,
    });
    candleSeriesRef.current = candleSeries;
    markersRef.current = createSeriesMarkers(candleSeries, []);
    entryMarkersRef.current = createSeriesMarkers(candleSeries, []);
    harmonicMarkersRef.current = createSeriesMarkers(candleSeries, []);

    // Клик по точке входа: lightweight-charts не даёт "клик по маркеру"
    // напрямую — сопоставляем время клика (param.time, привязано к ближайшей
    // свече) с сигналами, чьи маркеры сейчас нарисованы. entrySignalsRef
    // обновляется в отдельном эффекте ниже (по [signals, showEntryPoints]),
    // читается здесь через .current, чтобы не пересоздавать подписку на
    // каждое изменение signals.
    const handleChartClick = (param: { time?: Time }) => {
      if (!param.time) { setSelectedSignal(null); return; }
      // Сопоставляем время клика с временем свечи ВХОДА (см.
      // getSignalEntryTime), а не с sig.time (свеча сигнала) — маркер
      // теперь рисуется на свече входа, клик должен попадать туда же.
      const clicked = entrySignalsRef.current.find(
        (s) => (getSignalEntryTime(s) as unknown as Time) === param.time,
      );
      setSelectedSignal(clicked ?? null);
    };
    chart.subscribeClick(handleChartClick);

    const primitive = new BoxOverlayPrimitive();
    candleSeries.attachPrimitive(primitive);
    boxPrimitiveRef.current = primitive;

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      color: 'rgba(130, 148, 176, 0.4)',
    });
    chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });
    volumeSeriesRef.current = volumeSeries;

    const ema20 = chart.addSeries(LineSeries, {
      color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    });
    ema20Ref.current = ema20;

    const ema50 = chart.addSeries(LineSeries, {
      color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    });
    ema50Ref.current = ema50;

    const ema200 = chart.addSeries(LineSeries, {
      color: '#a855f7', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    });
    ema200Ref.current = ema200;

    const bollUpper = chart.addSeries(LineSeries, {
      color: 'rgba(51, 133, 255, 0.5)', lineWidth: 1, lineStyle: 2,
      priceLineVisible: false, lastValueVisible: false,
    });
    bollUpperRef.current = bollUpper;

    const bollLower = chart.addSeries(LineSeries, {
      color: 'rgba(51, 133, 255, 0.5)', lineWidth: 1, lineStyle: 2,
      priceLineVisible: false, lastValueVisible: false,
    });
    bollLowerRef.current = bollLower;

    const macdHist = chart.addSeries(HistogramSeries, {
      color: '#22c55e', priceScaleId: 'macd',
      priceLineVisible: false, lastValueVisible: false,
    });
    chart.priceScale('macd').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    macdHistRef.current = macdHist;

    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
      boxPrimitiveRef.current?.updateAllViews();
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.unsubscribeClick(handleChartClick);
      if (boxPrimitiveRef.current && candleSeriesRef.current) {
        candleSeriesRef.current.detachPrimitive(boxPrimitiveRef.current);
      }
      boxPrimitiveRef.current = null;
      for (const line of srPriceLinesRef.current) {
        candleSeriesRef.current?.removePriceLine(line);
      }
      srPriceLinesRef.current = [];
      for (const line of bosPriceLinesRef.current) {
        candleSeriesRef.current?.removePriceLine(line);
      }
      bosPriceLinesRef.current = [];
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      ema20Ref.current = null;
      ema50Ref.current = null;
      ema200Ref.current = null;
      bollUpperRef.current = null;
      bollLowerRef.current = null;
      macdHistRef.current = null;
      markersRef.current = null;
      entryMarkersRef.current = null;
      harmonicMarkersRef.current = null;
      dataStateRef.current = { lastCandleTime: null, candleCount: 0 };
    };
  }, []);

  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;
    if (candles.length === 0) {
      dataStateRef.current = { lastCandleTime: null, candleCount: 0 };
      return;
    }

    const ds = dataStateRef.current;
    const lastCandle = candles[candles.length - 1];

    if (ds.lastCandleTime === null || ds.candleCount === 0 || candles.length < ds.candleCount) {
      const candleData = candles.map((c) => ({
        time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
      }));
      const volumeData = candles.map((c) => ({
        time: c.time as Time, value: c.volume,
        color: c.close >= c.open ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)',
      }));
      candleSeriesRef.current.setData(candleData);
      volumeSeriesRef.current.setData(volumeData);
      ds.lastCandleTime = lastCandle.time;
      ds.candleCount = candles.length;
      return;
    }

    candleSeriesRef.current.update({
      time: lastCandle.time as Time, open: lastCandle.open, high: lastCandle.high,
      low: lastCandle.low, close: lastCandle.close,
    });
    volumeSeriesRef.current.update({
      time: lastCandle.time as Time, value: lastCandle.volume,
      color: lastCandle.close >= lastCandle.open ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)',
    });
    if (lastCandle.time > ds.lastCandleTime) {
      ds.lastCandleTime = lastCandle.time;
      ds.candleCount = candles.length;
    }
  }, [candles]);

  useEffect(() => {
    ema20Ref.current?.setData(showEma20 ? toLineData(candles, ema20Data) : []);
  }, [candles, ema20Data, showEma20]);

  useEffect(() => {
    ema50Ref.current?.setData(showEma50 ? toLineData(candles, ema50Data) : []);
  }, [candles, ema50Data, showEma50]);

  useEffect(() => {
    ema200Ref.current?.setData(showEma200 ? toLineData(candles, ema200Data) : []);
  }, [candles, ema200Data, showEma200]);

  useEffect(() => {
    if (showBollinger && series) {
      bollUpperRef.current?.setData(seriesToLineData(series.bollingerUpper));
      bollLowerRef.current?.setData(seriesToLineData(series.bollingerLower));
    } else {
      bollUpperRef.current?.setData([]);
      bollLowerRef.current?.setData([]);
    }
  }, [series, showBollinger]);

  useEffect(() => {
    if (!macdHistRef.current) return;
    if (!showMacd || candles.length === 0) {
      macdHistRef.current.setData([]);
      return;
    }
    const histData = macdData.histogram
      .map((v, i) => ({
        time: candles[i].time as Time,
        value: v,
        color: v !== null && v >= 0 ? '#22c55e' : '#ef4444',
      }))
      .filter((d) => d.value !== null && !Number.isNaN(d.value));
    macdHistRef.current.setData(histData);
  }, [candles, macdData, showMacd]);

  useEffect(() => {
    if (!boxPrimitiveRef.current) return;
    if (candles.length < 10) {
      boxPrimitiveRef.current.setBoxes([]);
      return;
    }

    const boxes: ChartBoxData[] = [];

    if (showOrderBlocks) {
      for (const ob of smartMoney.orderBlocks) {
        // Three visually distinct states, matching the ICT lifecycle
        // Fresh → Tested (mitigation) → Invalidated:
        // - fresh: solid border, full strength-scaled opacity, extends to
        //   the current bar, shows the mean-threshold reaction line.
        // - tested-hold: price re-entered the zone but never closed beyond
        //   it — still a live zone, but visually softer + dashed border so
        //   it reads as "already reacted once", still shows the line.
        // - broken: fully invalidated (closed beyond the zone). Rendered
        //   in neutral gray rather than the direction color so a dead zone
        //   is never mistaken for an active one, fixed at the candle where
        //   invalidation happened (not extended to "now"), no entry line.
        const isBroken = ob.status === 'broken';
        const isTested = ob.status === 'tested-hold';

        let fillColor: string;
        let borderColor: string;
        let label: string;
        let alpha: number;

        if (isBroken) {
          alpha = 0.05;
          fillColor = 'rgba(148,163,184,' + alpha + ')';
          borderColor = 'rgba(148,163,184,0.5)';
          label = 'iOB';
        } else if (isTested) {
          alpha = 0.10;
          fillColor = ob.type === 'bullish' ? `rgba(34,197,94,${alpha})` : `rgba(239,68,68,${alpha})`;
          borderColor = ob.type === 'bullish' ? 'rgba(34,197,94,0.6)' : 'rgba(239,68,68,0.6)';
          label = `mOB×${ob.touchCount}`;
        } else {
          alpha = 0.10 + 0.10 * ob.strengthScore;
          fillColor = ob.type === 'bullish' ? `rgba(34,197,94,${alpha})` : `rgba(239,68,68,${alpha})`;
          borderColor = ob.type === 'bullish' ? 'rgba(34,197,94,0.6)' : 'rgba(239,68,68,0.6)';
          label = 'OB';
        }

        boxes.push({
          id: `ob_${ob.time}_${ob.type}`,
          fromTime: ob.time,
          toTime: ob.endTime ?? (isBroken ? ob.time : null),
          topPrice: ob.top,
          bottomPrice: ob.bottom,
          fillColor,
          borderColor,
          label,
          borderDashed: isTested || isBroken,
          // Mean threshold (50% of the OB candle's body) — the standard ICT
          // reaction/entry level — only shown while the zone is still live
          // (fresh or tested); a broken zone has nothing left to react at.
          midLinePrice: isBroken ? undefined : ob.meanThreshold,
        });
      }

      // OB Breaker Block: an order block above that got fully invalidated,
      // re-purposed with inverted polarity (see smart-money.ts for the
      // generation rule). Same Fresh/Tested/Invalidated lifecycle and same
      // status-driven styling as a regular OB, but rendered in a distinct
      // indigo/rose hue rather than green/red — a breaker is a different
      // entity (a former OB now trading in the OPPOSITE direction), not
      // just another order block, and must never be visually confused with
      // one. Bundled under the same `showOrderBlocks` toggle and the same
      // "OB" legend swatch, the same way IFVG bundles under the FVG toggle
      // above — no new settings/legend surface for a derived sub-zone.
      for (const brk of smartMoney.breakerBlocks) {
        const isBroken = brk.status === 'broken';
        const isTested = brk.status === 'tested-hold';

        let fillColor: string;
        let borderColor: string;
        let label: string;

        if (isBroken) {
          fillColor = 'rgba(148,163,184,0.05)';
          borderColor = 'rgba(148,163,184,0.5)';
          label = 'iBRK';
        } else if (isTested) {
          fillColor = brk.type === 'bullish' ? 'rgba(99,102,241,0.10)' : 'rgba(244,63,94,0.10)';
          borderColor = brk.type === 'bullish' ? 'rgba(99,102,241,0.6)' : 'rgba(244,63,94,0.6)';
          label = `mBRK×${brk.touchCount}`;
        } else {
          const alpha = 0.10 + 0.10 * brk.strengthScore;
          fillColor = brk.type === 'bullish' ? `rgba(99,102,241,${alpha})` : `rgba(244,63,94,${alpha})`;
          borderColor = brk.type === 'bullish' ? 'rgba(99,102,241,0.6)' : 'rgba(244,63,94,0.6)';
          label = 'BRK';
        }

        boxes.push({
          id: `brk_${brk.time}_${brk.type}`,
          fromTime: brk.time,
          toTime: brk.endTime ?? (isBroken ? brk.time : null),
          topPrice: brk.top,
          bottomPrice: brk.bottom,
          fillColor,
          borderColor,
          label,
          borderDashed: true, // always dashed — visually a "derived" zone, distinct from a fresh solid OB even in its own live state
          midLinePrice: isBroken ? undefined : brk.meanThreshold,
        });
      }
    }

    if (showImbalances) {
      for (const fvg of smartMoney.fvgs) {
        // A box's right edge closes only on full invalidation (a candle
        // closing through the far boundary) — never on a mere CE wick touch.
        // The signal engine (fvg-return.ts, fvg-rejection.ts, fvg-nested.ts,
        // fvg-breaker-block.ts, via pickFreshUnbrokenFvgs) already treats a
        // touched-but-not-invalidated zone as live and tradeable; cutting the
        // box short at touchedTime would show it as "finished" on the chart
        // while a signal can still fire on it. See fvgRenderCutoff for the
        // full rationale. touchedTime is intentionally not used here.
        const cutoff = fvgRenderCutoff(fvg);
        boxes.push({
          id: `fvg_${fvg.time}_${fvg.type}`,
          fromTime: fvg.time,
          toTime: cutoff,
          topPrice: fvg.top,
          bottomPrice: fvg.bottom,
          fillColor: fvg.type === 'bullish' ? 'rgba(6,182,212,0.12)' : 'rgba(249,115,22,0.12)',
          borderColor: fvg.type === 'bullish' ? 'rgba(6,182,212,0.5)' : 'rgba(249,115,22,0.5)',
          label: 'FVG',
          // Consequent Encroachment (50% midline) — standard ICT FVG reaction level.
          midLine: true,
        });
      }

      // Inversion FVG: a FVG that got invalidated by a close through it and
      // now works as a zone of the opposite polarity. Dashed border keeps it
      // visually distinct from a live FVG above. Same invalidation-only
      // cutoff rule as above — an inversion zone can itself be touched or
      // broken, and only `broken` should end its box.
      for (const ifvg of smartMoney.inversionFvgs) {
        const cutoff = fvgRenderCutoff(ifvg);
        boxes.push({
          id: `ifvg_${ifvg.time}_${ifvg.type}`,
          fromTime: ifvg.time,
          toTime: cutoff,
          topPrice: ifvg.top,
          bottomPrice: ifvg.bottom,
          fillColor: ifvg.type === 'bullish' ? 'rgba(6,182,212,0.08)' : 'rgba(249,115,22,0.08)',
          borderColor: ifvg.type === 'bullish' ? 'rgba(6,182,212,0.6)' : 'rgba(249,115,22,0.6)',
          label: 'IFVG',
          borderDashed: true,
          midLine: true,
        });
      }
    }

    if (showRejectionBlocks) {
      for (const rb of smartMoney.rejectionBlocks) {
        boxes.push({
          id: `rjb_${rb.time}_${rb.type}`,
          fromTime: rb.time,
          toTime: null,
          topPrice: rb.top,
          bottomPrice: rb.bottom,
          fillColor: rb.type === 'bullish' ? 'rgba(45,212,191,0.15)' : 'rgba(244,114,182,0.15)',
          borderColor: rb.type === 'bullish' ? 'rgba(45,212,191,0.55)' : 'rgba(244,114,182,0.55)',
          label: 'RJB',
        });
      }
    }

    // Гармонический паттерн (Gartley/Butterfly/AB=CD) — PRZ (Potential
    // Reversal Zone) вокруг точки D, тот же примитив BoxOverlayPrimitive,
    // что уже рисует зоны OB/FVG выше. toTime: null тянет зону до правого
    // края, как у OB/RJB.
    if (showHarmonicPatterns && harmonicPattern && harmonicPattern.przLow !== undefined && harmonicPattern.przHigh !== undefined) {
      const isBuy = harmonicPattern.direction === 'buy';
      // Bat/Crab добавлены при интеграции детектора (см. harmonic-pattern.ts) —
      // те же подписи PRZ-бокса, что и у уже отображавшихся Gartley/Butterfly.
      const label =
        harmonicPattern.harmonicType === 'gartley' ? 'Gartley PRZ'
        : harmonicPattern.harmonicType === 'bat' ? 'Bat PRZ'
        : harmonicPattern.harmonicType === 'crab' ? 'Crab PRZ'
        : harmonicPattern.harmonicType === 'butterfly' ? 'Butterfly PRZ'
        : 'AB=CD PRZ';
      boxes.push({
        id: `harmonic-${harmonicPattern.time}`,
        fromTime: harmonicPattern.time,
        toTime: null,
        topPrice: harmonicPattern.przHigh,
        bottomPrice: harmonicPattern.przLow,
        fillColor: isBuy ? 'rgba(168,85,247,0.12)' : 'rgba(251,146,60,0.12)',
        borderColor: isBuy ? 'rgba(168,85,247,0.65)' : 'rgba(251,146,60,0.65)',
        label,
        borderDashed: true,
      });
    }

    boxPrimitiveRef.current.setBoxes(boxes);
  }, [candles, smartMoney, showBosLayer, showOrderBlocks, showImbalances, showRejectionBlocks, showHarmonicPatterns, harmonicPattern]);

  useEffect(() => {
    if (!candleSeriesRef.current || !markersRef.current) return;
    if (!showBosLayer || candles.length === 0) {
      if (markersRef.current) markersRef.current.setMarkers([]);
      return;
    }
    const structure = computeStructure(candles);
    const markers: SeriesMarker<Time>[] = [];
    const last = candles[candles.length - 1];
    if (structure.bos) {
      markers.push({ time: last.time as Time, position: 'belowBar', color: '#1de6c2', shape: 'arrowUp', text: 'BOS' });
    }
    if (structure.choch) {
      markers.push({ time: last.time as Time, position: 'aboveBar', color: '#f59e0b', shape: 'arrowDown', text: 'CHOCH' });
    }
    markersRef.current.setMarkers(markers);
  }, [candles, showBosLayer]);

  // Точки X-A-B-C-D гармонического паттерна — MVP-визуализация без
  // соединяющей ломаной линии (см. комментарий у harmonicMarkersRef выше):
  // подписанные буквами маркеры на найденных зигзаг-точках, третий
  // независимый слой ISeriesMarkersPluginApi (markersRef — под BOS/CHOCH,
  // entryMarkersRef — под точки входа, этот — под гармоники).
  useEffect(() => {
    if (!candleSeriesRef.current || !harmonicMarkersRef.current) return;
    if (!showHarmonicPatterns || !harmonicZigZagPoints) {
      harmonicMarkersRef.current.setMarkers([]);
      return;
    }

    const labels = ['X', 'A', 'B', 'C', 'D'] as const;
    const markers: SeriesMarker<Time>[] = harmonicZigZagPoints.map((point, i) => ({
      time: point.time as Time,
      position: point.type === 'high' ? 'aboveBar' : 'belowBar',
      color: '#a855f7',
      shape: point.type === 'high' ? 'arrowDown' : 'arrowUp',
      text: labels[i] ?? '',
    }));
    harmonicMarkersRef.current.setMarkers(markers);
  }, [showHarmonicPatterns, harmonicZigZagPoints]);

  // Точки входа в позицию (пример на скриншоте пользователя). Раньше сюда
  // попадали ВСЕ сигналы из видимого диапазона свечей, как только был
  // включён showEntryPoints — при активной торговле график зарастал
  // десятками стрелок разом ("хаос", см. аудит). Теперь показываются
  // ТОЛЬКО сигналы, явно выбранные кликом по строке в ИСТОРИЯ СИГНАЛОВ
  // (selectedChartSignalIds, см. useAnalyticsStore.ts) — showEntryPoints
  // остаётся общим переключателем функции целиком (выключен — стрелок нет
  // вообще, независимо от выбора).
  //
  // Маркер рисуется на свече ВХОДА (getSignalEntryTime = sig.time +
  // tfSeconds), а не на свече, где сигнал был сгенерирован — см. её JSDoc
  // в lib/utils.ts. Дедуп по времени входа на случай (в теории) нескольких
  // выбранных сигналов, указывающих на одну и ту же свечу.
  useEffect(() => {
    if (!candleSeriesRef.current || !entryMarkersRef.current) return;
    if (!showEntryPoints || selectedChartSignalIds.size === 0 || signals.length === 0 || candles.length === 0) {
      entryMarkersRef.current.setMarkers([]);
      entrySignalsRef.current = [];
      return;
    }

    const earliestVisible = candles[0].time;
    const latestVisible = candles[candles.length - 1].time;
    const seenTimes = new Set<number>();
    const visibleSignals: Signal[] = [];
    for (const sig of signals) {
      if (!selectedChartSignalIds.has(sig.id)) continue;
      const entryTime = getSignalEntryTime(sig);
      if (entryTime < earliestVisible || entryTime > latestVisible) continue;
      if (seenTimes.has(entryTime)) continue;
      seenTimes.add(entryTime);
      visibleSignals.push(sig);
    }

    const markers: SeriesMarker<Time>[] = visibleSignals.map((sig) => {
      const isBuy = sig.direction === 'buy';
      const outcomeColor = sig.outcome === 'win' ? CHART_UP_COLOR
        : sig.outcome === 'loss' ? CHART_DOWN_COLOR
        : sig.outcome === 'timeout' ? '#8294b0'
        : (isBuy ? CHART_UP_COLOR : CHART_DOWN_COLOR);
      return {
        time: getSignalEntryTime(sig) as Time,
        position: isBuy ? 'belowBar' : 'aboveBar',
        color: outcomeColor,
        shape: isBuy ? 'arrowUp' : 'arrowDown',
        text: sig.pattern ?? sig.strength,
        // Вдвое меньше дефолтного размера (1) — раньше при нескольких
        // одновременно видимых маркерах стрелки визуально сливались друг
        // с другом и со свечами ("хаос", см. аудит).
        size: 0.5,
      };
    });
    entryMarkersRef.current.setMarkers(markers);
    entrySignalsRef.current = visibleSignals;
  }, [candles, signals, showEntryPoints, selectedChartSignalIds]);

  useEffect(() => {
    if (!candleSeriesRef.current) return;
    for (const line of bosPriceLinesRef.current) {
      candleSeriesRef.current.removePriceLine(line);
    }
    bosPriceLinesRef.current = [];
    if (!showBosLayer || candles.length < 10) return;
    for (const bos of smartMoney.bosEvents.slice(-5)) {
      const pl = candleSeriesRef.current.createPriceLine({
        price: bos.price,
        color: bos.type === 'bullish' ? '#22c55e88' : '#ef444488',
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: 'BoS',
      });
      bosPriceLinesRef.current.push(pl);
    }
  }, [candles, smartMoney, showBosLayer]);

  useEffect(() => {
    if (!candleSeriesRef.current) return;
    for (const line of srPriceLinesRef.current) {
      candleSeriesRef.current.removePriceLine(line);
    }
    srPriceLinesRef.current = [];
    if (!showSupportResistance || candles.length < 20) return;
    const levels = supportResistance(candles).slice(0, 6);
    for (const level of levels) {
      const isSupport = level.type === 'support';
      const line = candleSeriesRef.current.createPriceLine({
        price: level.price,
        color: isSupport ? 'rgba(16, 185, 129, 0.45)' : 'rgba(239, 68, 68, 0.45)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: isSupport ? `S (${level.touches})` : `R (${level.touches})`,
      });
      srPriceLinesRef.current.push(line);
    }
  }, [candles, showSupportResistance]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {symbol && (
        <div className="pointer-events-none absolute left-3 top-2 flex flex-col gap-1">
          <div className="flex items-center gap-2 text-xs font-semibold text-base-300">
            <span className="text-base-100">{symbol.displaySymbol}</span>
            <span className="text-base-400">·</span>
            <span className={clsx('text-base-400', !timeframe && 'text-base-500')}>{timeframe}</span>
            {showBosLayer && (
              <span className="ml-1 rounded bg-secondary-700/30 px-1.5 py-0.5 text-2xs font-bold uppercase text-secondary-400">
                BOS
              </span>
            )}
            {showEntryPoints && selectedChartSignalIds.size > 0 && (
              <span className="ml-1 rounded bg-success-700/30 px-1.5 py-0.5 text-2xs font-bold uppercase text-success-400">
                Входы
              </span>
            )}
          </div>
          {showBosLayer && (showOrderBlocks || showImbalances || showRejectionBlocks) && (
            <div className="flex flex-wrap gap-1.5 text-2xs font-semibold uppercase">
              {showOrderBlocks && (
                <span className="flex items-center gap-1 rounded bg-base-900/70 px-1.5 py-0.5 text-success-400">
                  <span className="h-2 w-2 rounded-sm bg-success-500/50" /> OB
                </span>
              )}
              {showImbalances && (
                <span className="flex items-center gap-1 rounded bg-base-900/70 px-1.5 py-0.5 text-secondary-400">
                  <span className="h-2 w-2 rounded-sm bg-secondary-500/50" /> FVG
                </span>
              )}
              {showRejectionBlocks && (
                <span className="flex items-center gap-1 rounded bg-base-900/70 px-1.5 py-0.5 text-teal-400">
                  <span className="h-2 w-2 rounded-sm bg-teal-500/50" /> RJB
                </span>
              )}
            </div>
          )}
          {(showEma20 || showEma50 || showEma200) && (
            <div className="flex flex-wrap gap-1.5 text-2xs font-semibold uppercase">
              {showEma20 && (
                <span className="flex items-center gap-1 rounded bg-base-900/70 px-1.5 py-0.5 text-amber-400">
                  <span className="h-2 w-2 rounded-sm bg-amber-500/50" /> EMA20
                </span>
              )}
              {showEma50 && (
                <span className="flex items-center gap-1 rounded bg-base-900/70 px-1.5 py-0.5 text-blue-400">
                  <span className="h-2 w-2 rounded-sm bg-blue-500/50" /> EMA50
                </span>
              )}
              {showEma200 && (
                <span className="flex items-center gap-1 rounded bg-base-900/70 px-1.5 py-0.5 text-purple-400">
                  <span className="h-2 w-2 rounded-sm bg-purple-500/50" /> EMA200
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {selectedSignal && (
        <EntryPointPopup signal={selectedSignal} onClose={() => setSelectedSignal(null)} />
      )}
    </div>
  );
}
