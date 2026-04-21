/**
 * Cross-provider cache usage normalizer for Phase 1 observability.
 *
 * Each provider reports cache hits in a different shape and different unit
 * conventions. The rest of the codebase (cost-tracker, logging, REPL display)
 * should never have to care about that — this module is the single place
 * that knows how to read a raw `usage` object per provider and distill it
 * into a common `CacheMetrics` value.
 *
 * Design rationale:
 *   - Pure function, no globals: callers pass the provider explicitly so
 *     that tests, background agents and teammates get consistent results
 *     even when the process-level provider flag differs.
 *   - Honest N/A: Copilot (non-Claude) and Ollama do not expose cache data
 *     at all. Returning 0 would lie and corrupt aggregate hit-rate, so we
 *     return `supported: false` and let the display decide how to render.
 *   - `hitRate` is null whenever there is no input to compare against
 *     (0 read + 0 created). A 0% hit rate would suggest "cold" when in
 *     reality the turn had no cacheable content to begin with.
 *   - After normalization, `read + created ≤ total`, with any remainder
 *     being fresh (non-cacheable) input tokens. This invariant is
 *     intentionally asymmetric — we never fabricate totals from partial
 *     data because only Anthropic gives all three numbers directly.
 *
 * Sources (as of 2026-04):
 *   - Anthropic:        usage.cache_read_input_tokens,
 *                       usage.cache_creation_input_tokens,
 *                       usage.input_tokens (fresh only)
 *   - OpenAI / Codex:   usage.prompt_tokens_details.cached_tokens,
 *                       usage.prompt_tokens (includes cached)
 *   - Kimi / Moonshot:  usage.cached_tokens, usage.prompt_tokens
 *   - DeepSeek:         usage.prompt_cache_hit_tokens,
 *                       usage.prompt_cache_miss_tokens
 *   - Gemini:           usage.cached_content_token_count,
 *                       usage.prompt_token_count
 *   - Copilot (non-Claude) / Ollama: not reported → supported=false
 */
import type { APIProvider } from '../../utils/model/providers.js'

/** Providers for which we know how to read cache fields. */
export type CacheAwareProvider =
  | 'anthropic'
  | 'openai'
  | 'codex'
  | 'kimi'
  | 'deepseek'
  | 'gemini'
  | 'ollama'
  | 'copilot'
  | 'copilot-claude'

/** Unified cache metrics for one API response. */
export type CacheMetrics = {
  /** Tokens served from cache on this request. */
  read: number
  /**
   * Tokens written INTO the cache on this request. Only non-zero for
   * providers with explicit caching (Anthropic family).
   */
  created: number
  /**
   * Total input tokens charged for this request (cached + fresh, by
   * provider convention — see per-provider branches for specifics).
   * Used as denominator for hit-rate when available.
   */
  total: number
  /**
   * `read / total`, or null when the denominator is zero or the provider
   * doesn't support cache reporting.
   */
  hitRate: number | null
  /**
   * False for providers that do not expose cache data at all. Callers
   * should render "N/A" instead of "0%" in that case.
   */
  supported: boolean
}

/** Empty reference returned for unsupported providers — copy elision. */
const UNSUPPORTED: CacheMetrics = {
  read: 0,
  created: 0,
  total: 0,
  hitRate: null,
  supported: false,
}

/** Raw usage shape — intentionally permissive, each provider picks its fields. */
export type RawUsage = Record<string, unknown> | null | undefined

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function pickPath(usage: RawUsage, path: string[]): unknown {
  let cur: unknown = usage
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/**
 * Map the canonical APIProvider enum (+ environment hints) into a
 * cache-capability bucket. We separate `copilot` (no cache) from
 * `copilot-claude` (Anthropic shim via Copilot with explicit cache)
 * because the two behave very differently even under the same provider
 * flag — see `isGithubNativeAnthropicMode` in utils/model/providers.ts.
 */
export function resolveCacheProvider(
  provider: APIProvider,
  hints?: { githubNativeAnthropic?: boolean; openAiBaseUrl?: string },
): CacheAwareProvider {
  if (provider === 'github') {
    return hints?.githubNativeAnthropic ? 'copilot-claude' : 'copilot'
  }
  if (provider === 'firstParty' || provider === 'bedrock' || provider === 'vertex' || provider === 'foundry') {
    return 'anthropic'
  }
  if (provider === 'gemini') return 'gemini'
  if (provider === 'codex') return 'codex'
  if (provider === 'openai') {
    const url = (hints?.openAiBaseUrl ?? '').toLowerCase()
    // Local Ollama / LM Studio servers never return cache fields. Heuristic
    // check keeps the normalizer honest without requiring a separate env var.
    if (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('11434') || url.includes('1234')) {
      return 'ollama'
    }
    if (url.includes('moonshot') || url.includes('kimi')) return 'kimi'
    if (url.includes('deepseek')) return 'deepseek'
    return 'openai'
  }
  // nvidia-nim, minimax, mistral share the OpenAI Chat Completions convention
  // for cache reporting (prompt_tokens_details.cached_tokens). Treat them as
  // 'openai' for normalization purposes — if the provider doesn't emit the
  // field we simply get zeros, and hitRate stays null via the 0-guard below.
  return 'openai'
}

/**
 * Extract a unified CacheMetrics from a raw provider usage object.
 *
 * Accepts either a CacheAwareProvider (pre-resolved) or the raw APIProvider,
 * whichever the caller already has. Pre-resolved is preferred for tests that
 * need to exercise a specific bucket without caring about env state.
 */
export function extractCacheMetrics(
  usage: RawUsage,
  provider: CacheAwareProvider,
): CacheMetrics {
  if (!usage || typeof usage !== 'object') return UNSUPPORTED

  switch (provider) {
    case 'anthropic': {
      // Anthropic convention: input_tokens excludes cache reads/writes, so
      // total = fresh + created + read. This lets us compute hit-rate
      // relative to the full effective input, not just the uncached portion.
      const read = asNumber((usage as Record<string, unknown>).cache_read_input_tokens)
      const created = asNumber((usage as Record<string, unknown>).cache_creation_input_tokens)
      const fresh = asNumber((usage as Record<string, unknown>).input_tokens)
      const total = read + created + fresh
      return {
        read,
        created,
        total,
        hitRate: total > 0 ? read / total : null,
        supported: true,
      }
    }
    case 'openai':
    case 'codex': {
      // OpenAI convention: prompt_tokens is the FULL input (cached + fresh)
      // and cached_tokens is a subset of it. No server-side creation count
      // is exposed for implicit caching.
      const cached = asNumber(pickPath(usage, ['prompt_tokens_details', 'cached_tokens']))
        || asNumber(pickPath(usage, ['input_tokens_details', 'cached_tokens']))
      const total = asNumber((usage as Record<string, unknown>).prompt_tokens)
        || asNumber((usage as Record<string, unknown>).input_tokens)
      return {
        read: cached,
        created: 0,
        total,
        hitRate: total > 0 ? cached / total : null,
        supported: true,
      }
    }
    case 'kimi': {
      // Moonshot exposes cached_tokens at the top level (not inside
      // prompt_tokens_details). Same cached-is-subset-of-prompt convention.
      const cached = asNumber((usage as Record<string, unknown>).cached_tokens)
        || asNumber(pickPath(usage, ['prompt_tokens_details', 'cached_tokens']))
      const total = asNumber((usage as Record<string, unknown>).prompt_tokens)
      return {
        read: cached,
        created: 0,
        total,
        hitRate: total > 0 ? cached / total : null,
        supported: true,
      }
    }
    case 'deepseek': {
      // DeepSeek exposes the split directly: hit + miss sum to the full
      // input. We derive total from that sum rather than trusting a
      // separately-named field, which has been inconsistent across versions.
      const hit = asNumber((usage as Record<string, unknown>).prompt_cache_hit_tokens)
      const miss = asNumber((usage as Record<string, unknown>).prompt_cache_miss_tokens)
      const total = hit + miss
      return {
        read: hit,
        created: 0,
        total,
        hitRate: total > 0 ? hit / total : null,
        supported: true,
      }
    }
    case 'gemini': {
      const cached = asNumber((usage as Record<string, unknown>).cached_content_token_count)
      const total = asNumber((usage as Record<string, unknown>).prompt_token_count)
      return {
        read: cached,
        created: 0,
        total,
        hitRate: total > 0 ? cached / total : null,
        supported: true,
      }
    }
    case 'copilot-claude': {
      // Copilot serving Claude via native Anthropic format — same fields
      // as direct Anthropic. Separate branch so callers can label the row
      // distinctly in `/cache-stats` if desired.
      const read = asNumber((usage as Record<string, unknown>).cache_read_input_tokens)
      const created = asNumber((usage as Record<string, unknown>).cache_creation_input_tokens)
      const fresh = asNumber((usage as Record<string, unknown>).input_tokens)
      const total = read + created + fresh
      return {
        read,
        created,
        total,
        hitRate: total > 0 ? read / total : null,
        supported: true,
      }
    }
    case 'copilot':
    case 'ollama':
      return UNSUPPORTED
  }
}

/**
 * Format a CacheMetrics value into a human-facing one-liner used by
 * `showCacheStats: 'compact'`. Stable format — snapshot-tested.
 *
 * Examples:
 *   "[Cache: 1.2k read • hit 12%]"
 *   "[Cache: N/A]"                  (unsupported provider)
 *   "[Cache: cold]"                 (supported, no reads yet)
 */
export function formatCacheMetricsCompact(metrics: CacheMetrics): string {
  if (!metrics.supported) return '[Cache: N/A]'
  if (metrics.read === 0 && metrics.created === 0) return '[Cache: cold]'
  const parts: string[] = [`${formatCompactNumber(metrics.read)} read`]
  if (metrics.hitRate !== null) {
    parts.push(`hit ${Math.round(metrics.hitRate * 100)}%`)
  }
  return `[Cache: ${parts.join(' • ')}]`
}

/**
 * Format a CacheMetrics value into a multi-field breakdown used by
 * `showCacheStats: 'full'`. Stable format — snapshot-tested.
 *
 * Example:
 *   "[Cache: read=1.2k created=340 hit=12%]"
 */
export function formatCacheMetricsFull(metrics: CacheMetrics): string {
  if (!metrics.supported) return '[Cache: N/A]'
  const parts: string[] = [
    `read=${formatCompactNumber(metrics.read)}`,
    `created=${formatCompactNumber(metrics.created)}`,
  ]
  if (metrics.hitRate !== null) {
    parts.push(`hit=${Math.round(metrics.hitRate * 100)}%`)
  } else {
    parts.push('hit=n/a')
  }
  return `[Cache: ${parts.join(' ')}]`
}

// Compact 1.2k-style formatter. Duplicated here (not imported from
// utils/format.ts) because this module should stay dependency-light and
// deterministic — utils/format pulls Intl locale state which varies.
function formatCompactNumber(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
}

/** Sum two CacheMetrics, preserving `supported` as true only if both are. */
export function addCacheMetrics(a: CacheMetrics, b: CacheMetrics): CacheMetrics {
  // Copy elision: if either side is the unsupported sentinel, return the
  // other as-is so aggregates on a purely-unsupported session stay cheap.
  if (!a.supported && !b.supported) return UNSUPPORTED
  if (!a.supported) return b
  if (!b.supported) return a
  const read = a.read + b.read
  const created = a.created + b.created
  const total = a.total + b.total
  return {
    read,
    created,
    total,
    hitRate: total > 0 ? read / total : null,
    supported: true,
  }
}
