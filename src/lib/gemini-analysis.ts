import { z } from 'zod';
import { isSupabaseConfigured } from '@/lib/supabase';
import { getClientId } from '@/lib/client-id';
import { captureError } from '@/lib/sentry';

export const AIAnalysisSchema = z.object({
  trend: z.enum(['bullish', 'bearish', 'sideways']),
  confidence: z.number().min(0).max(100),
  levels: z.object({ support: z.number(), resistance: z.number() }),
  recommendation: z.enum(['buy', 'sell', 'wait']),
  reasoning: z.string().min(10),
  keyLevels: z.array(z.number()).optional(),
  riskNote: z.string().optional(),
});

export type AIAnalysis = z.infer<typeof AIAnalysisSchema>;

export class GeminiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'GeminiError';
  }
}

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const REQUEST_TIMEOUT_MS = 38_000;
const MAX_RETRIES = 1;

function getProxyUrl(): string {
  const url = import.meta.env.VITE_SUPABASE_URL;
  if (!url) throw new GeminiError('Supabase URL is not configured.');
  return `${url}/functions/v1/proxy-gemini`;
}

function getAnonKey(): string {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!key) throw new GeminiError('Supabase anon key is not configured.');
  return key;
}

function extractJson(text: string): unknown {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(cleaned);
}

function isRetryableNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError'));
}

async function fetchOnce(symbol: string, candles: Candle[], externalSignal?: AbortSignal): Promise<AIAnalysis> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
  let res: Response;
  try {
    res = await fetch(getProxyUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getAnonKey()}`,
        'X-Client-Key': getClientId(),
      },
      body: JSON.stringify({ symbol, candles }),
      signal,
    });
  } catch (err) {
    if (externalSignal?.aborted) throw err;
    throw new GeminiError(err instanceof Error ? `Network error: ${err.message}` : 'Network error reaching Gemini proxy.');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    const msg = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new GeminiError(
      res.status === 429
        ? 'Rate limit reached. Please wait a minute.'
        : res.status === 500
          ? msg
          : `Gemini proxy error (${res.status}): ${msg}`,
      res.status,
    );
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch {
    throw new GeminiError('Gemini returned invalid JSON.', 422);
  }
  const result = AIAnalysisSchema.safeParse(parsed);
  if (!result.success) {
    throw new GeminiError('Gemini returned an invalid response format.', 422);
  }
  return result.data;
}

export async function runGeminiAnalysis(symbol: string, candles: Candle[], externalSignal?: AbortSignal): Promise<AIAnalysis> {
  if (!isSupabaseConfigured) {
    throw new GeminiError('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  }
  if (candles.length < 5) throw new GeminiError('Not enough candles for analysis (need at least 5).');

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetchOnce(symbol, candles, externalSignal);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (externalSignal?.aborted) throw err;
      if (err instanceof GeminiError) {
        if (err.status === 401) throw err;
        if (attempt < MAX_RETRIES && (err.status === undefined || err.status === 429 || err.status >= 500)) continue;
        captureError(err, { context: 'gemini-analysis', status: err.status, attempt });
        throw err;
      }
      if (isRetryableNetworkError(err) && attempt < MAX_RETRIES) continue;
      const normalized = new GeminiError(lastError.message);
      captureError(normalized, { context: 'gemini-analysis', attempt, networkError: true });
      throw normalized;
    }
  }
  throw lastError ?? new GeminiError('Failed to reach Gemini API.');
}
