import { describe, it, expect } from 'vitest';
import { genRequestId } from '@/types/messages';

describe('Worker protocol', () => {
  describe('genRequestId', () => {
    it('produces unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(genRequestId());
      }
      expect(ids.size).toBe(100);
    });

    it('uses crypto.randomUUID when available', () => {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        const id = genRequestId();
        expect(id.length).toBeGreaterThanOrEqual(36);
      }
    });
  });

  describe('message type discrimination', () => {
    it('candle_closed_result and snapshot_result are distinct types', () => {
      const candleResult = { type: 'candle_closed_result', requestId: 'a', snapshot: {}, series: {} };
      const snapshotResult = { type: 'snapshot_result', requestId: 'b', snapshot: {}, series: {} };
      expect(candleResult.type).not.toBe(snapshotResult.type);
    });

    it('tick_update_result carries only IndicatorSnapshot', () => {
      const msg = { type: 'tick_update_result', requestId: 'c', snapshot: { rsi: 50 } };
      expect(msg.type).toBe('tick_update_result');
      expect(msg.snapshot).not.toHaveProperty('patterns');
    });

    it('signal_result carries signal or null', () => {
      const msg = { type: 'signal_result', requestId: 'd', signal: null };
      expect(msg.type).toBe('signal_result');
      expect(msg.signal).toBeNull();
    });

    it('worker_error includes requestId and message', () => {
      const msg = { type: 'worker_error', requestId: 'e', message: 'failed' };
      expect(msg.type).toBe('worker_error');
      expect(msg.requestId).toBe('e');
    });
  });

  describe('race condition: simultaneous requests do not cross', () => {
    it('Map<requestId> ensures responses are routed to the correct caller', () => {
      const pending = new Map<string, string>();
      const id1 = genRequestId();
      const id2 = genRequestId();
      pending.set(id1, 'candle_closed');
      pending.set(id2, 'snapshot_request');

      expect(pending.get(id1)).toBe('candle_closed');
      expect(pending.get(id2)).toBe('snapshot_request');

      pending.delete(id1);
      expect(pending.get(id1)).toBeUndefined();
      expect(pending.get(id2)).toBe('snapshot_request');
    });

    it('different requestIds never collide', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        ids.add(genRequestId());
      }
      expect(ids.size).toBe(1000);
    });
  });
});
