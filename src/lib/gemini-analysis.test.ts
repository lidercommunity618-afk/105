import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AIAnalysisSchema, GeminiError, runGeminiAnalysis } from './gemini-analysis';

// `isSupabaseConfigured` (src/lib/supabase.ts) is a module-level `const`
// evaluated once, at import time, from `import.meta.env`. `vi.stubEnv(...)`
// in `beforeEach` below runs AFTER this file's top-level `import` has
// already executed, so it can never influence that value (it is frozen at
// whatever env was present when the module first loaded — normally
// `false` in the test environment). Left as-is, this doesn't just fail
// the two tests that assert a successful response — it makes
// `runGeminiAnalysis` throw `GeminiError('Supabase is not configured...')`
// before any of the code under test ever runs, which also made
// 'honors external cancellation' and 'rejects malformed responses' pass
// for the wrong reason (any `GeminiError`/thrown value satisfies their
// loose `rejects.toThrow()` / `rejects.toBeInstanceOf(GeminiError)`
// assertions). Mocking the module directly sidesteps the import-order
// race and lets every test in this file exercise the real request path.
vi.mock('./supabase', () => ({ isSupabaseConfigured: true, getSupabase: vi.fn() }));

const analysis = {
  trend: 'bullish', confidence: 75,
  levels: { support: 100, resistance: 110 }, recommendation: 'buy',
  reasoning: 'Strong momentum with higher highs and higher lows.',
};

const candles = Array.from({ length: 5 }, (_, index) => ({
  time: index, open: 100, high: 101, low: 99, close: 100, volume: 10,
}));

describe('AIAnalysisSchema', () => {
  it('accepts the contract', () => expect(AIAnalysisSchema.safeParse(analysis).success).toBe(true));
  it('rejects unsupported trends', () => expect(AIAnalysisSchema.safeParse({ ...analysis, trend: 'neutral' }).success).toBe(false));
});

describe('runGeminiAnalysis', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-key');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('parses a successful response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(analysis), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await runGeminiAnalysis('EURUSD', candles);
    expect(result.recommendation).toBe('buy');
  });

  it('retries a network failure', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(new Response(JSON.stringify(analysis), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(runGeminiAnalysis('EURUSD', candles)).resolves.toEqual(analysis);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors external cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(runGeminiAnalysis('EURUSD', candles, controller.signal)).rejects.toThrow();
  });

  it('rejects malformed responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await expect(runGeminiAnalysis('EURUSD', candles)).rejects.toBeInstanceOf(GeminiError);
  });
});
