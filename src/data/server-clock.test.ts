import { describe, it, expect } from 'vitest';
import { ServerClock } from './server-clock';

describe('ServerClock', () => {
  it('starts with zero offset', () => {
    const clock = new ServerClock();
    expect(clock.now()).toBeCloseTo(Date.now(), -2);
  });

  it('applies offset from first sync', () => {
    const clock = new ServerClock();
    const serverTime = Date.now() + 5000;
    clock.sync(serverTime);
    expect(clock.now()).toBeCloseTo(serverTime, -2);
  });

  it('smooths small drift on subsequent syncs', () => {
    const clock = new ServerClock();
    clock.sync(Date.now() + 1000);
    const offsetBefore = clock.now() - Date.now();
    void offsetBefore;
    clock.sync(Date.now() + 1005);
    const offsetAfter = clock.now() - Date.now();
    expect(Math.abs(offsetAfter - 1000)).toBeLessThan(Math.abs(1005 - 1000));
  });

  it('snaps when drift exceeds tolerance', () => {
    const clock = new ServerClock();
    clock.sync(Date.now() + 1000);
    clock.sync(Date.now() + 60000);
    expect(clock.now()).toBeCloseTo(Date.now() + 60000, -2);
  });

  it('getOffset returns current offset', () => {
    const clock = new ServerClock();
    clock.sync(Date.now() + 5000);
    expect(clock.getOffset()).toBeCloseTo(5000, -1);
  });

  it('lastSync is zero before first sync', () => {
    const clock = new ServerClock();
    expect(clock.lastSync).toBe(0);
  });

  it('lastSync updates after sync', () => {
    const clock = new ServerClock();
    clock.sync(Date.now());
    expect(clock.lastSync).toBeGreaterThan(0);
  });
});
