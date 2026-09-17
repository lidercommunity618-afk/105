/*
# Add composite index and fix score constraint for signal persistence

## Overview

This migration adds a composite index on (symbol_id, timeframe, created_at)
to optimize the `loadRecentSignals(symbolId, timeframe, limit)` query, and
fixes the `score` CHECK constraint which was incorrectly scoped to 0-100
integer — the decision engine produces float scores (e.g. 3.75, 5.2) from
weighted feature calculations, so the column must accept any numeric value.

## 1. Schema Changes

### trading_signals.score
- Changed from `integer NOT NULL CHECK (score >= 0 AND score <= 100)`
  to `double precision NOT NULL` — the decision engine produces float scores
  from weighted feature calculations. The 0-100 constraint would cause
  INSERT failures when the app starts persisting signals.

## 2. New Indexes

- `idx_trading_signals_symbol_tf_created` — composite index on
  (symbol_id, timeframe, created_at DESC) for the loadRecentSignals query
  that filters by symbol + timeframe and orders by most recent first.

## 3. Security

No policy changes — the existing `TO anon, authenticated` policies from the
original migration are correct for this single-tenant no-auth terminal.

## 4. Important Notes

1. The score column type change is necessary because signal scores are
   computed as weighted sums of feature contributions (e.g. 2.0 * structure
   + 1.5 * zones + ...) producing float values, not 0-100 integers.
2. The existing indexes (idx_trading_signals_symbol_timeframe,
   idx_trading_signals_outcome, idx_trading_signals_signal_time) are
   preserved — this migration only adds one more.
*/

-- Drop the score CHECK constraint if it exists (named trading_signals_score_check)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'trading_signals'
      AND constraint_name = 'trading_signals_score_check'
  ) THEN
    ALTER TABLE trading_signals DROP CONSTRAINT trading_signals_score_check;
  END IF;
END $$;

-- Fix score column: integer → double precision (engine produces floats)
ALTER TABLE trading_signals
  ALTER COLUMN score TYPE double precision USING score::double precision;

-- Composite index for loadRecentSignals(symbolId, timeframe, limit)
CREATE INDEX IF NOT EXISTS idx_trading_signals_symbol_tf_created
  ON trading_signals (symbol_id, timeframe, created_at DESC);
