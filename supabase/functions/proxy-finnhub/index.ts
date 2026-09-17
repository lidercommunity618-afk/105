import { corsHeaders, preflightResponse } from '../_shared/cors.ts';
import { checkRateLimit, getSecret } from '../_shared/rate-limit.ts';

const RATE_LIMIT_PER_MIN = 30;

const TF_TO_RESOLUTION: Record<string, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '4h': '240',
  '1d': 'D',
};

const BASE_URL = 'https://finnhub.io/api/v1';
const REQUEST_TIMEOUT_MS = 10_000;

Deno.serve(async (req: Request) => {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;

  try {
    const clientKey = req.headers.get('X-Client-Key') ?? 'anonymous';

    const allowed = await checkRateLimit(clientKey, 'proxy-finnhub', RATE_LIMIT_PER_MIN);
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded. Max 30 requests per minute.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const body = await req.json();
    const { symbol, timeframe, from, to } = body as {
      symbol?: string;
      timeframe?: string;
      from?: number;
      to?: number;
    };

    if (!symbol || !timeframe) {
      return new Response(
        JSON.stringify({ error: 'symbol and timeframe are required.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const resolution = TF_TO_RESOLUTION[timeframe];
    if (!resolution) {
      return new Response(
        JSON.stringify({ error: `Unsupported timeframe: ${timeframe}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const apiKey = getSecret('FINNHUB_API_KEY');
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'Finnhub API key is not configured on the server.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const fromSec = from ?? nowSec - 500 * 60;
    const toSec = to ?? nowSec;

    const url = `${BASE_URL}/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${fromSec}&to=${toSec}&token=${apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ error: `Finnhub request failed: ${msg}` }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    clearTimeout(timer);

    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: res.ok ? 200 : res.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});


