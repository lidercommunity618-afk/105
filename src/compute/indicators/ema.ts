import { nullArray } from './helpers';

export function sma(values: number[], period: number): (number | null)[] {
  const result = nullArray(values.length);
  if (period <= 0) return result;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) result[i] = sum / period;
  }
  return result;
}

export function ema(values: number[], period: number): (number | null)[] {
  const result = nullArray(values.length);
  if (period <= 0 || values.length === 0) return result;
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += values[j];
      prev = sum / period;
      result[i] = prev;
    } else if (i >= period && prev !== null) {
      prev = v * k + prev * (1 - k);
      result[i] = prev;
    }
  }
  return result;
}

export class StreamingSMA {
  private buffer: number[] = [];
  private sum = 0;

  constructor(private readonly period: number) {}

  seed(value: number): void {
    this.buffer = [];
    this.sum = 0;
    for (let i = 0; i < this.period; i++) {
      this.buffer.push(value);
      this.sum += value;
    }
  }

  update(price: number): number {
    if (this.buffer.length < this.period) {
      this.buffer.push(price);
      this.sum += price;
      if (this.buffer.length < this.period) return NaN;
    } else {
      this.sum -= this.buffer[0];
      this.sum += price;
      this.buffer.push(price);
      this.buffer.shift();
    }
    return this.sum / this.period;
  }

  get value(): number {
    if (!this.isReady) return NaN;
    return this.sum / this.period;
  }

  get isReady(): boolean {
    return this.buffer.length >= this.period;
  }

  reset(): void {
    this.buffer = [];
    this.sum = 0;
  }
}

export class StreamingEMA {
  private prev: number | null = null;
  private readonly k: number;

  constructor(private readonly period: number) {
    this.k = 2 / (period + 1);
  }

  /** Must be called with the SMA of the first `period` values before update(). */
  seed(value: number): void {
    this.prev = value;
  }

  update(price: number): number {
    if (this.prev === null) {
      if (import.meta.env?.DEV) {
        throw new Error(
          `StreamingEMA.update() called before seed() — call seed(smaOfFirstNValues) first (period=${this.period})`,
        );
      }
      return NaN;
    }
    this.prev = price * this.k + this.prev * (1 - this.k);
    return this.prev;
  }

  get value(): number {
    return this.prev ?? NaN;
  }

  get isReady(): boolean {
    return this.prev !== null;
  }

  reset(): void {
    this.prev = null;
  }
}
