import { corsHeaders, preflightResponse } from '../_shared/cors.ts';
import { checkRateLimit, getSecret } from '../_shared/rate-limit.ts';

const RATE_LIMIT_PER_MIN = 30;

const INTERVAL_MAP: Record<string, string> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '1h',
  '4h': '4h',
  '1d': '1day',
};

const REST_URL = 'https://api.twelvedata.com/time_series';
const REQUEST_TIMEOUT_MS = 10_000;

Deno.serve(async (req: Request) => {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;

  try {
    const clientKey = req.headers.get('X-Client-Key') ?? 'anonymous';

    const allowed = await checkRateLimit(clientKey, 'proxy-twelvedata', RATE_LIMIT_PER_MIN);
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded. Max 30 requests per minute.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const body = await req.json();
    const { symbol, timeframe, outputsize } = body as {
      symbol?: string;
      timeframe?: string;
      outputsize?: number;
    };

    if (!symbol || !timeframe) {
      return new Response(
        JSON.stringify({ error: 'symbol and timeframe are required.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const interval = INTERVAL_MAP[timeframe];
    if (!interval) {
      return new Response(
        JSON.stringify({ error: `Unsupported timeframe: ${timeframe}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const apiKey = getSecret('TWELVEDATA_API_KEY');
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'TwelveData API key is not configured on the server.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const count = outputsize ?? 1000;
    const url = `${REST_URL}?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${count}&format=JSON&apikey=${apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ error: `TwelveData request failed: ${msg}` }),
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


