// Bar clock helpers (pure, no environment access).
export const BAR_MS = 4 * 3600_000
/** Rolling candle window kept per symbol (constant storage). */
export const WINDOW = 1000
export const barOpen = (ms: number) => Math.floor(ms / BAR_MS) * BAR_MS
/** Open time of the most recent fully closed candle at `now`. */
export const lastClosedBar = (now = Date.now()) => barOpen(now) - BAR_MS
/** Absolute 4h bar number (monotonic, restart-safe clock for cooldowns / pauses / windows). */
export const barIndex = (t: number) => Math.floor(t / BAR_MS)
/** After a bar closes, how long a bot waits for lagging symbols before evaluating the bar without them. */
export const BAR_GRACE_MS = 10 * 60_000
/** A UTC day = 6 bars; the day's last bar opens at 20:00 UTC (closes at 00:00). */
export const isDayEndBar = (t: number) => new Date(t).getUTCHours() === 20
/** Live mode: a closed bar is only evaluated (and its entry executed) within this long after it closed. Older bars are SKIPPED, never replayed. */
export const LIVE_BAR_MAX_AGE_MS = 15 * 60_000
