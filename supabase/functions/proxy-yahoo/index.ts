import { corsHeaders, preflightResponse } from '../_shared/cors.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

const RATE_LIMIT_PER_MIN = 30;

const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '60m',
  '4h': '4h',
  '1d': '1d',
};

const REQUEST_TIMEOUT_MS = 10_000;

Deno.serve(async (req: Request) => {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;

  try {
    const clientKey = req.headers.get('X-Client-Key') ?? 'anonymous';

    const allowed = await checkRateLimit(clientKey, 'proxy-yahoo', RATE_LIMIT_PER_MIN);
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded. Max 30 requests per minute.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const body = await req.json();
    const { symbol, timeframe, range } = body as {
      symbol?: string;
      timeframe?: string;
      range?: string;
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

    const yahooSymbol = symbol.includes('=') ? symbol : `${symbol}=X`;
    const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range ?? '1mo'}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(target, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ error: `Yahoo request failed: ${msg}` }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    clearTimeout(timer);

    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: res.ok ? 200 : res.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});


