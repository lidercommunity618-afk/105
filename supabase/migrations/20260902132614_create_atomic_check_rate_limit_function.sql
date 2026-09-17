/*
# Create atomic rate-limit check function

1. Changes
- Add `check_rate_limit(text, text, integer)`, which increments a minute-window counter atomically.
- Existing `rate_limits` columns and rows are preserved.

2. Security
- The function is SECURITY DEFINER with a fixed public search path.
- Only the edge-function roles need execute access; no browser table access is added.

3. Important notes
- The function uses INSERT ... ON CONFLICT DO UPDATE, preventing parallel requests from bypassing the limit.
- It returns TRUE when the incremented count is within the supplied limit.
*/

CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_client_key text,
  p_bucket text,
  p_limit integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.rate_limits (client_key, bucket, window_start, count)
  VALUES (p_client_key, p_bucket, date_trunc('minute', now()), 1)
  ON CONFLICT (client_key, bucket, window_start)
  DO UPDATE SET count = public.rate_limits.count + 1, updated_at = now()
  RETURNING count INTO v_count;
  RETURN v_count <= p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.check_rate_limit(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, text, integer) TO anon, authenticated, service_role;