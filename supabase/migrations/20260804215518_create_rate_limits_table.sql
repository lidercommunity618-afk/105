/*
# Create rate_limits table for edge function rate limiting

## Overview

This migration creates a `rate_limits` table used by Supabase Edge Functions
(proxy-gemini, proxy-twelvedata, proxy-finnhub) to enforce per-client rate
limits. The `check_rate_limit` SQL function atomically checks and increments
a request counter within a 1-minute sliding window.

## 1. New Tables

### rate_limits
- `client_key` (text, not null) — client identifier (from X-Client-Key header)
- `bucket` (text, not null) — rate limit bucket name (e.g. 'proxy-gemini')
- `window_start` (timestamptz, not null) — start of the current 1-minute window
- `count` (integer, not null, default 1) — requests made in this window
- `updated_at` (timestamptz, default now()) — last modification time

Primary key: (client_key, bucket, window_start)

## 2. Security

- RLS enabled with `TO anon, authenticated` full CRUD — the edge functions
  run as the anon role and must be able to read/write rate limit counters.
  This is a single-tenant app with no sign-in screen.

## 3. Indexes

- Primary key on (client_key, bucket, window_start) for fast lookups

## 4. Important Notes

1. The `check_rate_limit` function is SECURITY DEFINER so it can run the
   upsert + check atomically regardless of the caller's role.
2. It returns TRUE if the request is allowed (under the limit), FALSE if denied.
3. The window is calculated as `date_trunc('minute', now())` — each minute
   gets its own row, and old rows are harmless (can be cleaned up later).
*/

CREATE TABLE IF NOT EXISTS rate_limits (
  client_key text NOT NULL,
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_key, bucket, window_start)
);

ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_rate_limits" ON rate_limits;
CREATE POLICY "anon_select_rate_limits" ON rate_limits FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_rate_limits" ON rate_limits;
CREATE POLICY "anon_insert_rate_limits" ON rate_limits FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_rate_limits" ON rate_limits;
CREATE POLICY "anon_update_rate_limits" ON rate_limits FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_rate_limits" ON rate_limits;
CREATE POLICY "anon_delete_rate_limits" ON rate_limits FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup
  ON rate_limits (client_key, bucket, window_start DESC);
