import { corsHeaders, preflightResponse } from '../_shared/cors.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

// Аудит, п.3 (security): раньше клиент удалял ВСЮ таблицу trading_signals
// напрямую через anon-ключ (RLS-политика "anon_delete_signals" с
// USING (true)). Anon-ключ по конструкции публичен (виден в каждом сетевом
// запросе браузера), поэтому любой человек, скопировавший его из DevTools,
// мог одним curl-запросом мгновенно стереть общую историю сигналов для ВСЕХ
// пользователей этого single-tenant деплоя — без rate-limit и без следа.
//
// Теперь массовое удаление выполняется только здесь: RLS-политика DELETE
// для anon/authenticated на trading_signals удалена (см. миграцию
// 20260828_lock_down_signals_and_calibration_delete.sql), единственный путь
// очистить таблицу — вызвать эту edge-функцию, которая:
//   1) rate-limit'ится через существующую таблицу rate_limits (как и прокси
//      источников котировок), чтобы один клиент не мог спамить очистку;
//   2) использует service-role ключ (доступен только на сервере, обходит
//      RLS изнутри Deno-рантайма edge-функции, никогда не попадает в
//      клиентский бандл) — то есть сам анонимный ключ фронтенда больше не
//      даёт права на DELETE вообще.
const RATE_LIMIT_PER_MIN = 3;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

Deno.serve(async (req: Request) => {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed. Use POST.' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  try {
    const clientKey = req.headers.get('X-Client-Key') ?? 'anonymous';

    const allowed = await checkRateLimit(clientKey, 'delete-all-signals', RATE_LIMIT_PER_MIN);
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded. Max 3 requests per minute.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return new Response(
        JSON.stringify({ error: 'Server is not configured for this operation.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Тот же паттерн "delete all", что был в клиенте: DELETE требует фильтр,
    // `id is not null` matches каждую строку (id — non-null primary key).
    const { error } = await admin.from('trading_signals').delete().not('id', 'is', null);

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
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


