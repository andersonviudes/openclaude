import { expect, test, describe } from 'bun:test'
import { z } from 'zod'
import {
  DEFAULT_GLOBAL_CONFIG,
  GLOBAL_CONFIG_KEYS,
  isGlobalConfigKey,
  SHOW_CACHE_STATS_MODES,
  type GlobalConfig,
} from './config.js'

// Standalone Zod schema mirroring the runtime contract for showCacheStats.
// The config file does not carry a Zod schema per field (GlobalConfig is a
// plain TS type with defaults), so we exercise validation here so that any
// future drift — e.g. adding a mode without updating the UI — is caught at
// test time rather than silently rendered in /config.
const ShowCacheStatsSchema = z.enum(SHOW_CACHE_STATS_MODES)

describe('GlobalConfig — showCacheStats registration', () => {
  test('default is "compact"', () => {
    expect(DEFAULT_GLOBAL_CONFIG.showCacheStats).toBe('compact')
  })

  test('is listed in GLOBAL_CONFIG_KEYS (exposed via /config and ConfigTool)', () => {
    expect(GLOBAL_CONFIG_KEYS).toContain('showCacheStats')
    expect(isGlobalConfigKey('showCacheStats')).toBe(true)
  })

  test('SHOW_CACHE_STATS_MODES is the single source of truth', () => {
    expect(SHOW_CACHE_STATS_MODES).toEqual(['off', 'compact', 'full'])
  })
})

describe('showCacheStats — Zod validation', () => {
  test('accepts "off"', () => {
    expect(ShowCacheStatsSchema.parse('off')).toBe('off')
  })

  test('accepts "compact"', () => {
    expect(ShowCacheStatsSchema.parse('compact')).toBe('compact')
  })

  test('accepts "full"', () => {
    expect(ShowCacheStatsSchema.parse('full')).toBe('full')
  })

  test('rejects arbitrary strings', () => {
    expect(() => ShowCacheStatsSchema.parse('verbose')).toThrow()
    expect(() => ShowCacheStatsSchema.parse('')).toThrow()
    expect(() => ShowCacheStatsSchema.parse('ON')).toThrow()
  })

  test('rejects non-string values', () => {
    expect(() => ShowCacheStatsSchema.parse(true)).toThrow()
    expect(() => ShowCacheStatsSchema.parse(1)).toThrow()
    expect(() => ShowCacheStatsSchema.parse(null)).toThrow()
    expect(() => ShowCacheStatsSchema.parse(undefined)).toThrow()
  })
})

describe('showCacheStats — GlobalConfig type surface', () => {
  test('assignable to each accepted mode without casting', () => {
    const a: Pick<GlobalConfig, 'showCacheStats'> = { showCacheStats: 'off' }
    const b: Pick<GlobalConfig, 'showCacheStats'> = { showCacheStats: 'compact' }
    const c: Pick<GlobalConfig, 'showCacheStats'> = { showCacheStats: 'full' }
    expect([a.showCacheStats, b.showCacheStats, c.showCacheStats]).toEqual([
      'off',
      'compact',
      'full',
    ])
  })
})
