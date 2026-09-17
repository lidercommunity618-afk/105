import type { Candle } from '@/types/domain';

export interface VolumeProfileLevel {
  price: number;
  volume: number;
}

export interface VolumeProfileResult {
  bins: VolumeProfileLevel[];
  poc: number | null;
  isProxyVolume: boolean;
}

export function volumeProfile(
  candles: Candle[],
  binCount: number = 50,
): VolumeProfileResult {
  if (candles.length === 0 || binCount < 2) return { bins: [], poc: null, isProxyVolume: false };

  const hasVolume = candles.some((c) => c.volume > 0);
  const allZeroVolume = candles.every((c) => c.volume === 0);
  const useProxy = allZeroVolume;
  if (!hasVolume && !useProxy) return { bins: [], poc: null, isProxyVolume: false };

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const maxPrice = Math.max(...highs);
  const minPrice = Math.min(...lows);
  const range = maxPrice - minPrice;
  if (range <= 0) return { bins: [], poc: null, isProxyVolume: useProxy };

  const binSize = range / binCount;
  const bins = new Array(binCount).fill(0).map((_, i) => ({
    price: minPrice + binSize * (i + 0.5),
    volume: 0,
  }));

  for (const c of candles) {
    const weight = useProxy ? c.high - c.low : c.volume;
    const typical = (c.high + c.low + c.close) / 3;
    const idx = Math.min(binCount - 1, Math.floor((typical - minPrice) / binSize));
    bins[idx].volume += weight;
  }

  const pocBin = bins.reduce((max, b) => (b.volume > max.volume ? b : max), bins[0]);
  return {
    bins,
    poc: pocBin.volume > 0 ? pocBin.price : null,
    isProxyVolume: useProxy,
  };
}

export function volumeProfilePoc(candles: Candle[], binCount?: number): number | null {
  return volumeProfile(candles, binCount).poc;
}

export interface VolumeProfilePocWithMeta {
  poc: number | null;
  isProxyVolume: boolean;
}

export function volumeProfilePocWithMeta(
  candles: Candle[],
  binCount?: number,
): VolumeProfilePocWithMeta {
  const { poc, isProxyVolume } = volumeProfile(candles, binCount);
  return { poc, isProxyVolume };
}
