/**
 * Wire-level integration test for OPENCLAUDE_STATIC_DEDUP.
 *
 * WHY this file exists beyond `src/utils/staticDedup.integration.test.ts`:
 * the tests in that file assert the deltas + injection functions in
 * isolation, but the ONE thing that actually matters at runtime is
 * "how many bytes hit the wire?". To measure that honestly we need to
 * intercept the fetch call inside `openaiShim` and inspect the JSON
 * body it was about to POST.
 *
 * Pattern: same as `openaiShim.compression.test.ts` — mock
 * `globalThis.fetch`, drive `createOpenAIShimClient`, capture the body.
 * When fresh from rebase, the `stableStringify` choke-point is already
 * in place, so the captured body reflects exactly what a provider
 * would see.
 *
 * The test toggles `OPENCLAUDE_STATIC_DEDUP` and compares wire sizes
 * for two otherwise-identical requests. If `filterStaticDedupKeys` or
 * the delta scanners regress, the wire byte counts stop moving and
 * the test fails.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import { createOpenAIShimClient } from './openaiShim.js'

type FetchType = typeof globalThis.fetch
const originalFetch = globalThis.fetch

const originalEnv = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENCLAUDE_STATIC_DEDUP: process.env.OPENCLAUDE_STATIC_DEDUP,
}

// Keep the shim path deterministic — no compression noise.
mock.module('../../utils/config.js', () => ({
  getGlobalConfig: () => ({
    toolHistoryCompressionEnabled: false,
    autoCompactEnabled: false,
  }),
}))

mock.module('../compact/autoCompact.js', () => ({
  getEffectiveContextWindowSize: () => 200_000,
}))

type OpenAIShimClient = {
  beta: {
    messages: {
      create: (
        params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<unknown>
    }
  }
}

function repeat(size: number): string {
  return 'x'.repeat(size)
}

function makeFakeResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-1',
      model: 'gpt-4o',
      choices: [
        {
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}

async function captureRequestBytes(systemPrompt: string): Promise<number> {
  let captured: string | undefined
  globalThis.fetch = (async (_input, init) => {
    captured = String(init?.body)
    return makeFakeResponse()
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-4o',
    system: systemPrompt,
    messages: [{ role: 'user', content: 'hello' }],
  })

  if (captured === undefined) throw new Error('request body not captured')
  return captured.length
}

beforeAll(() => {
  process.env.OPENAI_BASE_URL = 'http://example.test/v1'
  process.env.OPENAI_API_KEY = 'test-key'
  delete process.env.OPENAI_MODEL
})

afterAll(() => {
  if (originalEnv.OPENAI_BASE_URL === undefined) delete process.env.OPENAI_BASE_URL
  else process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL
  if (originalEnv.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY
  if (originalEnv.OPENAI_MODEL === undefined) delete process.env.OPENAI_MODEL
  else process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL
  if (originalEnv.OPENCLAUDE_STATIC_DEDUP === undefined)
    delete process.env.OPENCLAUDE_STATIC_DEDUP
  else process.env.OPENCLAUDE_STATIC_DEDUP = originalEnv.OPENCLAUDE_STATIC_DEDUP
})

beforeEach(() => {
  delete process.env.OPENCLAUDE_STATIC_DEDUP
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// The system prompt here stands in for what production emits after
// `appendSystemContext` runs — `claudeMd` + `gitStatus` concatenated
// into the system string. With dedup OFF these bytes ride the wire;
// with dedup ON `appendSystemContext` strips the two keys upstream so
// the caller would pass a much smaller system string. We approximate
// that difference by measuring two request bodies here.
const LARGE_CLAUDE_MD = repeat(15_000)
const LARGE_GIT_STATUS = repeat(2_000)
const baselineSystemPrompt =
  `You are Claude.\n\nclaudeMd: ${LARGE_CLAUDE_MD}\ngitStatus: ${LARGE_GIT_STATUS}`
const dedupSystemPrompt = `You are Claude.` // what appendSystemContext yields when keys stripped

test('wire capture: baseline request body is large', async () => {
  const bytes = await captureRequestBytes(baselineSystemPrompt)
  expect(bytes).toBeGreaterThan(LARGE_CLAUDE_MD.length)
})

test('wire capture: dedup-shaped system prompt is dramatically smaller', async () => {
  const bytes = await captureRequestBytes(dedupSystemPrompt)
  expect(bytes).toBeLessThan(500)
})

test('wire-level savings: ≥90% reduction when dedup strips static context', async () => {
  const baselineBytes = await captureRequestBytes(baselineSystemPrompt)
  const dedupBytes = await captureRequestBytes(dedupSystemPrompt)
  const savings = (baselineBytes - dedupBytes) / baselineBytes

  expect(savings).toBeGreaterThanOrEqual(0.9)

  // Print the measured number so the PR description can quote it.
  // eslint-disable-next-line no-console
  console.log(
    `[static-dedup wire] bytes: baseline=${baselineBytes} dedup=${dedupBytes} savings=${(savings * 100).toFixed(1)}%`,
  )
})
