/**
 * Per-query and per-session cache metrics tracker for Phase 1 observability.
 *
 * Sits downstream of `extractCacheMetrics` (normalizer) and upstream of the
 * REPL display + `/cache-stats` command. The shim layers already report raw
 * usage into Anthropic-shaped fields, so this tracker listens for each
 * successful API response and folds the metrics into three buckets:
 *
 *   - currentTurn : cleared by callers at the start of each user turn
 *   - session     : accumulates from process start until `/clear`
 *   - history     : per-request log for `/cache-stats` breakdown view
 *
 * Design rationale:
 *   - Module-local state (not AppState, not bootstrap/state.ts) because
 *     this is strictly observability — nothing in the conversation flow
 *     depends on it and we don't want to couple the shim to React state.
 *   - `recordRequest()` takes an ALREADY-normalized CacheMetrics so the
 *     shim layer can resolve provider once and we avoid re-running env
 *     detection on every response.
 *   - `history` is bounded (DEFAULT_HISTORY_MAX) so a long-lived session
 *     can't grow memory unboundedly. Oldest entries drop first.
 *   - `supported: false` requests still land in history (so the user can
 *     see "6 requests, all N/A" rather than "no data"), but they add to
 *     sums as zero — `addCacheMetrics` preserves the supported flag.
 */
import { addCacheMetrics, type CacheMetrics } from './cacheMetrics.js'

/** One request's cache footprint — what the tracker remembers per turn. */
export type CacheStatsEntry = {
  /** Unix ms when the request completed. */
  timestamp: number
  /** Opaque label (usually the model string) for `/cache-stats` rows. */
  label: string
  /** Normalized metrics for this single request. */
  metrics: CacheMetrics
}

// Bound the per-session history. 500 requests ≈ a full day of active use;
// any more than that is noise for a diagnostic command and starts costing
// real memory (~100 bytes per entry with the labels).
const DEFAULT_HISTORY_MAX = 500

const EMPTY_METRICS: CacheMetrics = {
  read: 0,
  created: 0,
  total: 0,
  hitRate: null,
  supported: false,
}

type TrackerState = {
  currentTurn: CacheMetrics
  session: CacheMetrics
  history: CacheStatsEntry[]
  historyMax: number
}

const state: TrackerState = {
  currentTurn: EMPTY_METRICS,
  session: EMPTY_METRICS,
  history: [],
  historyMax: DEFAULT_HISTORY_MAX,
}

/**
 * Record a single API response's normalized cache metrics. Idempotent per
 * request (caller ensures this isn't double-counted) — safe to call from
 * the shim right after `addToTotalSessionCost`.
 */
export function recordRequest(
  metrics: CacheMetrics,
  label: string,
): void {
  state.currentTurn = addCacheMetrics(state.currentTurn, metrics)
  state.session = addCacheMetrics(state.session, metrics)
  state.history.push({
    timestamp: Date.now(),
    label,
    metrics,
  })
  if (state.history.length > state.historyMax) {
    state.history.splice(0, state.history.length - state.historyMax)
  }
}

/** Clear turn-level counters at the start of a new user turn. */
export function resetCurrentTurn(): void {
  state.currentTurn = EMPTY_METRICS
}

/** Clear all session state — used by `/clear`, `/compact`, tests. */
export function resetSessionCacheStats(): void {
  state.currentTurn = EMPTY_METRICS
  state.session = EMPTY_METRICS
  state.history = []
}

/** Snapshot of the current turn's aggregate. */
export function getCurrentTurnCacheMetrics(): CacheMetrics {
  return state.currentTurn
}

/** Snapshot of the session-wide aggregate. */
export function getSessionCacheMetrics(): CacheMetrics {
  return state.session
}

/**
 * Recent per-request entries, oldest-first. Returns a copy so callers
 * can freely sort/filter without perturbing the tracker.
 */
export function getCacheStatsHistory(): CacheStatsEntry[] {
  return state.history.slice()
}

/** Test/debug hook — do not use in production paths. */
export function _setHistoryCapForTesting(cap: number): void {
  state.historyMax = cap
  if (state.history.length > cap) {
    state.history.splice(0, state.history.length - cap)
  }
}
