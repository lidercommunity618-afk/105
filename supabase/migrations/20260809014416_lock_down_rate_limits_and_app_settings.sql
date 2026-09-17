/*
# Lock down rate_limits and app_settings tables

## Overview

This migration closes an access-control gap on two tables that were
intentionally shared (single-tenant, no sign-in) but should never have
been reachable from the browser:

1. **rate_limits** — used ONLY by Supabase Edge Functions to enforce
   per-client rate limiting. The edge functions connect with the
   service role key (which bypasses RLS), so they do not need any anon
   policies. With the old `USING (true)` policies, anyone holding the
   public anon key could DELETE all rate-limit counters (silently
   disabling rate limiting for the whole app) or INSERT inflated
   counts (locking out other users). Neither table is read or written
   by any browser code.

2. **app_settings** — created as a singleton settings store but never
   wired into the app (no client code references it; settings still
   live in browser localStorage). Leaving it open lets anyone with the
   anon key read/overwrite/delete the single settings row.

## Security changes

- **rate_limits**: REVOKE all privileges from `anon` and
  `authenticated`. DROP all four open policies. RLS remains ENABLED
  (defense in depth) — with no policies and no grants, the anon role
  can no longer read or modify the table. Edge functions continue to
  work because they use the service role key, which bypasses RLS.

- **app_settings**: same treatment — REVOKE all privileges, DROP all
  four open policies, keep RLS enabled. The table is unused by the app;
  locking it down prevents anonymous tampering with no functional
  impact.

## Important notes

1. No data is lost. No rows are deleted, no columns are changed, no
   tables are dropped. Only grants and policies are removed.
2. The edge functions' `checkRateLimit` helper in
   `supabase/functions/_shared/rate-limit.ts` creates its Supabase
   client with `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS entirely.
   Removing anon policies does not affect it.
3. `trading_signals` and `calibration_state` keep their existing
   `TO anon, authenticated` policies unchanged — those tables ARE
   read and written by the browser client and the data is intentionally
   shared across this single-tenant deployment.
4. If `app_settings` is wired into the app later, re-add scoped
   policies at that time rather than re-opening it now.
*/

-- ─── rate_limits: revoke anon access, drop open policies ───────────

REVOKE ALL ON rate_limits FROM anon;
REVOKE ALL ON rate_limits FROM authenticated;

DROP POLICY IF EXISTS "anon_select_rate_limits" ON rate_limits;
DROP POLICY IF EXISTS "anon_insert_rate_limits" ON rate_limits;
DROP POLICY IF EXISTS "anon_update_rate_limits" ON rate_limits;
DROP POLICY IF EXISTS "anon_delete_rate_limits" ON rate_limits;

-- RLS stays enabled — no policies means no anon access at all.
-- Service role (used by edge functions) bypasses RLS.

-- ─── app_settings: revoke anon access, drop open policies ──────────

REVOKE ALL ON app_settings FROM anon;
REVOKE ALL ON app_settings FROM authenticated;

DROP POLICY IF EXISTS "anon_select_settings" ON app_settings;
DROP POLICY IF EXISTS "anon_insert_settings" ON app_settings;
DROP POLICY IF EXISTS "anon_update_settings" ON app_settings;
DROP POLICY IF EXISTS "anon_delete_settings" ON app_settings;

-- RLS stays enabled — no policies means no anon access at all.
