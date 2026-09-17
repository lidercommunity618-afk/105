import type {
  ISeriesPrimitive,
  SeriesAttachedParameter,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

export interface ChartBoxData {
  id: string;
  fromTime: number;
  toTime: number | null;
  topPrice: number;
  bottomPrice: number;
  fillColor: string;
  borderColor: string;
  label?: string;
  /** Draw the box border dashed instead of solid — used to visually distinguish e.g. Inversion FVG zones from regular ones. */
  borderDashed?: boolean;
  /** Draw a thin dashed horizontal line through the vertical middle of the box — used for the FVG Consequent Encroachment (CE) midline. */
  midLine?: boolean;
  /**
   * Draw the dashed reaction line at this specific price instead of the
   * box's geometric middle. Used for the Order Block "mean threshold" —
   * the 50% level of the OB candle's BODY (open/close), which does not
   * coincide with the geometric middle of the drawn zone when the zone
   * itself spans the candle's full high/low range (i.e. whenever the
   * candle has wicks). Takes precedence over `midLine` when both are set.
   */
  midLinePrice?: number;
}

interface PixelBox {
  x1: number; x2: number;
  y1: number; y2: number;
  fill: string; border: string;
  label?: string;
  borderDashed?: boolean;
  midLine?: boolean;
  midLineY?: number;
}

class BoxPaneRenderer implements IPrimitivePaneRenderer {
  constructor(private _boxes: PixelBox[]) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const b of this._boxes) {
        const left = Math.min(b.x1, b.x2);
        const width = Math.max(1, Math.abs(b.x2 - b.x1));
        const top = Math.min(b.y1, b.y2);
        const height = Math.max(1, Math.abs(b.y2 - b.y1));

        ctx.fillStyle = b.fill;
        ctx.fillRect(left, top, width, height);
        ctx.strokeStyle = b.border;
        ctx.lineWidth = 1;
        if (b.borderDashed) ctx.setLineDash([4, 3]);
        ctx.strokeRect(left + 0.5, top + 0.5, Math.max(0, width - 1), Math.max(0, height - 1));
        if (b.borderDashed) ctx.setLineDash([]);

        if (b.midLine || b.midLineY !== undefined) {
          const midY = b.midLineY !== undefined ? b.midLineY : top + height / 2;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(left, midY + 0.5);
          ctx.lineTo(left + width, midY + 0.5);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        if (b.label && width > 30) {
          ctx.font = '10px Inter, sans-serif';
          ctx.fillStyle = b.border;
          ctx.textBaseline = 'top';
          ctx.fillText(b.label, left + 3, top + 2);
        }
      }
    });
  }
}

class BoxPaneView implements IPrimitivePaneView {
  private _renderer = new BoxPaneRenderer([]);
  update(boxes: PixelBox[]) { this._renderer = new BoxPaneRenderer(boxes); }
  renderer(): IPrimitivePaneRenderer { return this._renderer; }
}

export class BoxOverlayPrimitive implements ISeriesPrimitive<Time> {
  private _param: SeriesAttachedParameter<Time> | null = null;
  private _data: ChartBoxData[] = [];
  private _paneView = new BoxPaneView();

  attached(param: SeriesAttachedParameter<Time>): void {
    this._param = param;
    this.updateAllViews();
  }

  detached(): void {
    this._param = null;
  }

  setBoxes(boxes: ChartBoxData[]): void {
    this._data = boxes;
    this.updateAllViews();
    this._param?.requestUpdate();
  }

  updateAllViews(): void {
    if (!this._param) return;
    const chart = this._param.chart;
    const series = this._param.series;
    const timeScale = chart.timeScale();
    const rightEdgePx = timeScale.width();

    const pixelBoxes: PixelBox[] = [];
    for (const b of this._data) {
      const x1 = timeScale.timeToCoordinate(b.fromTime as Time);
      const x2 = b.toTime === null ? rightEdgePx : timeScale.timeToCoordinate(b.toTime as Time);
      const y1 = series.priceToCoordinate(b.topPrice);
      const y2 = series.priceToCoordinate(b.bottomPrice);
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
      const midLineY = b.midLinePrice !== undefined
        ? series.priceToCoordinate(b.midLinePrice) ?? undefined
        : undefined;
      pixelBoxes.push({
        x1, x2, y1, y2,
        fill: b.fillColor,
        border: b.borderColor,
        label: b.label,
        borderDashed: b.borderDashed,
        midLine: b.midLine,
        midLineY,
      });
    }
    this._paneView.update(pixelBoxes);
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._paneView];
  }
}
