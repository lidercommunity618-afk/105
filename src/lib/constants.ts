/**
 * Pre-close signal lead time in milliseconds.
 *
 * The signal engine freezes a signal this many milliseconds before the
 * current candle closes. The UI candle-timer uses the same value to show
 * the "closing soon" indicator, and the tick store uses it to gate the
 * pre-close evaluation window. Keeping a single source of truth here
 * guarantees the UI and the engine agree on the window by construction,
 * not by coincidence.
 */
export const PRE_CLOSE_SIGNAL_LEAD_MS = 5000;
