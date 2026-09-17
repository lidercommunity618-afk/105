# Volume Bonus Double-Count Fix + Dead Code Cleanup

**Date:** 2026-09-13
**Scope:** `src/compute/patterns/index.ts`

## Changes

### 1. Removed volume double-counting in `applyConfidenceHierarchy`

**Problem:** `applyConfidenceHierarchy` added a flat `+0.1` volume bonus when `p.volumeConfirmed` was true. For most patterns (single/double/triple, FVG/OB family, impulse-breakout, liquidity-sweep-reaction) each detector already factors volume into its computed confidence via `volumeFactor(volumeRatio)`, explicit volume multipliers, or its own additive `+= 0.10` adjustment — so the flat bonus was a double-count.

**Fix (initial, over-broad):** Removed the `volumeBonus` addition from `applyConfidenceHierarchy` entirely.

**Regression fix (same session):** The removal was too broad — three patterns (`liquidity-sweep`, `rising-three-methods`, `falling-three-methods`) do NOT include volume in their confidence formula. For these three, `volumeConfirmed` was the sole source of volume gradation, and removing the bonus flattened the signal from "passed the hard volume gate" to "no volume information at all". The bonus is now restored, but only for these three pattern names, via a `PATTERNS_WITHOUT_OWN_VOLUME_GRADATION` set. All other patterns remain without the bonus (their detectors already graduate volume internally).

### 2. Removed dead `patternDirection` function

**Problem:** `patternDirection` was exported but never imported or called anywhere in the codebase. It also had an incorrect default (`return 'buy'`) for all SMC/structural patterns (mean-reversion, FVG, OB, liquidity-sweep, harmonic, etc.), which would have returned wrong directions for bearish variants of those patterns had it ever been used.

**Fix:** Deleted the function entirely.

### 3. Added `htfStructureOverride` parameter to `detectAllPatterns` (undocumented in initial change)

**Problem:** The `htfStructureOverride?: MarketStructure` parameter was added to the `detectAllPatterns` signature to allow tests to inject a fixed HTF structure without depending on `computeHtfStructure`'s M15 resampling, but was not documented in the initial changelog entry and had no explanatory comment at the declaration site.

**Fix:** Added a JSDoc comment at the parameter declaration explaining it is a test-only override that is never passed in production (`full-snapshot.ts` always uses the real `computeHtfStructure`). Documented here retroactively.

## Verification

- `npm run typecheck` — pass
- `npm run test` — 835/835 pass
