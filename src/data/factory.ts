import type { SourceId } from '@/types/domain';
import type { DataSource } from './source';
import { BinanceSource } from './sources/binance';
import { DerivSource } from './sources/deriv';
import { TwelveDataSource } from './sources/twelvedata';
import { FinnhubSource } from './sources/finnhub';
import { YahooSource } from './sources/yahoo';

export function createSource(id: SourceId): DataSource {
  switch (id) {
    case 'binance':
      return new BinanceSource();
    case 'deriv':
      return new DerivSource();
    case 'twelvedata':
      return new TwelveDataSource();
    case 'finnhub':
      return new FinnhubSource();
    case 'yahoo':
      return new YahooSource();
  }
}
