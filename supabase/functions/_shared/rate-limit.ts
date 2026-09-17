import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

function getAdminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function getClientIp(req: Request): string | null {
  for (const header of ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip']) {
    const value = req.headers.get(header);
    const ip = value?.split(',')[0].trim();
    if (ip) return ip;
  }
  return null;
}

export async function checkRateLimit(clientKey: string, bucket: string, limitPerMin: number): Promise<boolean> {
  const { data, error } = await getAdminClient().rpc('check_rate_limit', {
    p_client_key: clientKey,
    p_bucket: bucket,
    p_limit: limitPerMin,
  });
  if (error) {
    console.error('Rate limit check failed:', error.message);
    return true;
  }
  return data === true;
}

export function getSecret(name: string): string | undefined {
  return Deno.env.get(name);
}
