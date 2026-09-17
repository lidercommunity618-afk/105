/*
# Lock down DELETE on trading_signals and calibration_state

## Overview

Audit finding (item 3, "Supabase / RLS — безопасность бэкенда"): both
`trading_signals` and `calibration_state` were left with a fully open
`TO anon, authenticated USING (true)` DELETE policy from the original
migration (20260804012847_create_trading_signals_tables.sql). The
Supabase anon key is embedded in the client bundle and is visible in
every network request the browser makes — anyone who copies it from
DevTools could, with a single unauthenticated REST call, permanently
wipe the entire shared signal history or the shared calibration model
for every user of this single-tenant deployment. There is no undo.

This is the single most damaging anon-reachable operation on the
schema (unlike a stray INSERT/UPDATE, a bulk DELETE is instant,
total, and irreversible), and — unlike `rate_limits`/`app_settings` in
the previous lockdown migration — these two tables ARE legitimately
read/written by the browser client for core app functionality
(saveSignal, updateSignalOutcome, saveCalibrationState), so this
migration narrows access rather than revoking it entirely.

## What changes

- **trading_signals**: DROP the `anon_delete_signals` policy. SELECT/
  INSERT/UPDATE policies are left untouched (saveSignal/updateSignalOutcome
  need them for normal, frequent, per-row operation). The app's "delete
  all history" button (`SignalFeed.tsx` → `deleteAllSignals()`) now goes
  through the new `delete-all-signals` edge function instead, which
  performs the DELETE with the service-role key on the server (bypassing
  RLS) and is rate-limited via the existing `rate_limits` table — the
  same pattern already used by the `proxy-*` edge functions for
  outbound API keys.
- **calibration_state**: DROP the `anon_delete_calibration` policy.
  No client code ever deletes this row (only upserts via
  `saveCalibrationState` and reads via `loadCalibrationStateFromDb`),
  so removing DELETE has zero functional impact and closes an
  anon-reachable way to destroy the shared calibration model.

## Explicitly out of scope (documented, not fixed here)

UPDATE on both tables remains open to `anon, authenticated` with
`USING (true)`, because it backs continuous, core, per-row
functionality (`updateSignalOutcome` on every signal resolution,
`saveCalibrationState` upsert on every training step) and moving it
behind an edge function is a larger architectural change that needs
its own testing pass — it is not the catastrophic, one-shot,
irreversible risk that unrestricted DELETE is. If this deployment
grows beyond a single-tenant demo, revisit UPDATE the same way DELETE
was revisited here.

## Important notes

1. No data is lost, no rows are deleted, no columns are changed, no
   tables are dropped or have RLS disabled. Only the two DELETE
   policies are dropped.
2. RLS stays enabled on both tables (defense in depth) — with the
   DELETE policy gone, `anon`/`authenticated` simply have no matching
   policy for DELETE, so PostgREST correctly rejects such requests.
3. The `delete-all-signals` edge function uses
   `SUPABASE_SERVICE_ROLE_KEY` (server-side only, never shipped to the
   client), so it is unaffected by this policy change.
*/

-- ─── trading_signals: drop anon DELETE ──────────────────────────────

DROP POLICY IF EXISTS "anon_delete_signals" ON trading_signals;

-- ─── calibration_state: drop anon DELETE ────────────────────────────

DROP POLICY IF EXISTS "anon_delete_calibration" ON calibration_state;

-- RLS stays enabled on both tables — no DELETE policy means anon/
-- authenticated simply have no way to delete rows anymore. SELECT/
-- INSERT/UPDATE policies from the original migration are untouched.
