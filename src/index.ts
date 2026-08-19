import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type {
  LlmRetryEventData,
  LlmRetryStartedEventData,
  RetryId,
} from '@deepseek-ai/dsh-llm-retry/types'
import z from '@deepseek-ai/schemastery'

export const name = 'deepseek-harness-retry'
export const inject = ['agents']

export const RETRY_EVENT = 'llm/retry' as const
export const RETRY_STARTED_EVENT = 'llm/retry-started' as const
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Errors normally worth retrying, including the generic pi-ai error used by GPT routes. */
export const DEFAULT_RETRYABLE_CODES = Object.freeze([
  'STREAM_CLOSED',
  'MALFORMED_RESPONSE',
  'PI_AI_ERROR',
  'API_ERROR',
  'MODEL_ERROR',
  'INTERNAL_ERROR',
  'PROVIDER_ERROR',
  'UNKNOWN',
] as const)

export interface Config {
  /** Maximum retries after the original failed request. */
  maxRetries?: number
  /** Exact provider-neutral failure codes. Use `*` to retry every request failure. */
  retryableCodes?: string[]
  /** First exponential-backoff delay in milliseconds. */
  initialDelayMs?: number
  /** Maximum local or provider-requested delay in milliseconds. */
  maxDelayMs?: number
  /** Symmetric random multiplier around each local delay, from 0 to 1. */
  jitterRatio?: number
  /** Restrict retries to these provider routes. Empty means every provider. */
  providers?: string[]
  /** Provider routes that must never be retried by this plugin. */
  excludeProviders?: string[]
  /** Honor a valid provider Retry-After value, capped by maxDelayMs. */
  respectRetryAfter?: boolean
}

export interface ResolvedConfig {
  readonly maxRetries: number
  readonly retryableCodes: readonly string[]
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
  readonly providers: readonly string[]
  readonly excludeProviders: readonly string[]
  readonly respectRetryAfter: boolean
}

export const Config: z<Config> = z.object({
  maxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(2),
  retryableCodes: z.array(z.string().min(1)).default([...DEFAULT_RETRYABLE_CODES]),
  initialDelayMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(500),
  maxDelayMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(10_000),
  jitterRatio: z.number().min(0).max(1).default(0.1),
  providers: z.array(z.string().min(1)).default([]),
  excludeProviders: z.array(z.string().min(1)).default([]),
  respectRetryAfter: z.boolean().default(true),
})

/** Standard DSH retry event shape used by the built-in Web projection and persistence catalog. */
export type RetryScheduledEventData = Extract<LlmRetryEventData, { mode: 'normal' }>

export interface RetryInternals {
  /** Deterministic random source for tests. */
  random?: () => number
  /** Abort-aware wait override for tests. */
  wait?: (delayMs: number, signal: AbortSignal) => Promise<boolean>
}

const DEFAULT_CONFIG: ResolvedConfig = Object.freeze({
  maxRetries: 2,
  retryableCodes: DEFAULT_RETRYABLE_CODES,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
  providers: Object.freeze([]),
  excludeProviders: Object.freeze([]),
  respectRetryAfter: true,
})

function normalizeCodes(codes: readonly string[]): string[] {
  return [...new Set(codes.map((code) => code.trim().toUpperCase()).filter(Boolean))]
}

function normalizeProviders(providers: readonly string[]): string[] {
  return [...new Set(providers.map((provider) => provider.trim()).filter(Boolean))]
}

/** Resolve defaults and validate relationships not expressible by the schema. */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const resolved: ResolvedConfig = Object.freeze({
    maxRetries: config.maxRetries ?? DEFAULT_CONFIG.maxRetries,
    retryableCodes: Object.freeze(normalizeCodes(config.retryableCodes ?? DEFAULT_CONFIG.retryableCodes)),
    initialDelayMs: config.initialDelayMs ?? DEFAULT_CONFIG.initialDelayMs,
    maxDelayMs: config.maxDelayMs ?? DEFAULT_CONFIG.maxDelayMs,
    jitterRatio: config.jitterRatio ?? DEFAULT_CONFIG.jitterRatio,
    providers: Object.freeze(normalizeProviders(config.providers ?? DEFAULT_CONFIG.providers)),
    excludeProviders: Object.freeze(normalizeProviders(config.excludeProviders ?? DEFAULT_CONFIG.excludeProviders)),
    respectRetryAfter: config.respectRetryAfter ?? DEFAULT_CONFIG.respectRetryAfter,
  })

  if (!Number.isSafeInteger(resolved.maxRetries) || resolved.maxRetries < 0) {
    throw new Error('deepseek-harness-retry: maxRetries must be a non-negative safe integer')
  }
  if (
    !Number.isFinite(resolved.initialDelayMs)
    || resolved.initialDelayMs < 0
    || resolved.initialDelayMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(`deepseek-harness-retry: initialDelayMs must be between 0 and ${MAX_TIMER_DELAY_MS}`)
  }
  if (
    !Number.isFinite(resolved.maxDelayMs)
    || resolved.maxDelayMs < resolved.initialDelayMs
    || resolved.maxDelayMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(
      `deepseek-harness-retry: maxDelayMs must be between initialDelayMs and ${MAX_TIMER_DELAY_MS}`,
    )
  }
  if (!Number.isFinite(resolved.jitterRatio) || resolved.jitterRatio < 0 || resolved.jitterRatio > 1) {
    throw new Error('deepseek-harness-retry: jitterRatio must be between 0 and 1')
  }
  if (resolved.retryableCodes.length === 0 && resolved.maxRetries > 0) {
    throw new Error('deepseek-harness-retry: retryableCodes must not be empty when retries are enabled')
  }

  return resolved
}

/** Canonical identity for one resolved behavior, used to keep durable budgets isolated across config changes. */
export function retryPolicyKey(config: ResolvedConfig): string {
  return JSON.stringify([
    'deepseek-harness-retry/v1',
    config.maxRetries,
    [...config.retryableCodes].sort(),
    config.initialDelayMs,
    config.maxDelayMs,
    config.jitterRatio,
    [...config.providers].sort(),
    [...config.excludeProviders].sort(),
    config.respectRetryAfter,
  ])
}

/** Decide whether this plugin owns a provider failure after downstream policies delegate. */
export function isRetryable(config: ResolvedConfig, provider: string, failure: LlmFailure): boolean {
  if (config.maxRetries === 0 || config.excludeProviders.includes(provider)) return false
  if (config.providers.length > 0 && !config.providers.includes(provider)) return false
  const code = failure.code.trim().toUpperCase()
  return config.retryableCodes.includes('*') || config.retryableCodes.includes(code)
}

/** Whether the adapter-owned built-in policy owns this code, regardless of its current finite budget. */
export function isOwnedByProviderPolicy(
  policy: ResolvedRetryPolicy | undefined,
  failure: LlmFailure,
): boolean {
  if (policy === undefined) return false
  if (policy.mode === 'always') return true
  const code = failure.code.trim().toUpperCase()
  return policy.retryableCodes.some((candidate) => candidate.trim().toUpperCase() === code)
}

/** Compute bounded exponential backoff, or delegate when Retry-After exceeds the configured cap. */
export function retryDelay(
  config: ResolvedConfig,
  attempt: number,
  failure: LlmFailure,
  random: () => number = Math.random,
): number | undefined {
  if (
    config.respectRetryAfter
    && failure.providerRetryAfterMs !== undefined
    && Number.isFinite(failure.providerRetryAfterMs)
    && failure.providerRetryAfterMs > 0
  ) {
    return failure.providerRetryAfterMs <= config.maxDelayMs
      ? failure.providerRetryAfterMs
      : undefined
  }

  const exponent = Math.min(Math.max(attempt - 1, 0), 1024)
  const exponential = config.initialDelayMs === 0
    ? 0
    : Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs)
  const sample = Math.min(Math.max(random(), 0), 1)
  const multiplier = 1 - config.jitterRatio + 2 * config.jitterRatio * sample
  return Math.min(exponential * multiplier, config.maxDelayMs)
}

/** Wait without leaving a timer alive after cancellation. */
export function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)

    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function previousRetry(
  events: readonly { type: string; data: unknown }[],
  turn: number,
  step: number,
  provider: string,
  policyKey: string,
): { retry: number; retryId: RetryId } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== RETRY_EVENT) continue
    const data = event.data as LlmRetryEventData
    if (
      data.turn === turn
      && data.step === step
      && data.provider === provider
      && data.policyKey === policyKey
    ) return { retry: data.retry, retryId: data.retryId }
  }
  return undefined
}

/** Install automatic request-error recovery. Downstream policies get first refusal. */
export function apply(ctx: Context, config: Config = {}, internals: RetryInternals = {}): void {
  const resolved = resolveConfig(config)
  const policyKey = retryPolicyKey(resolved)
  const random = internals.random ?? Math.random
  const wait = internals.wait ?? cancellableDelay
  const lifetime = new AbortController()
  const active = new Set<Promise<unknown>>()

  function track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  async function recover(
    payload: {
      agent: Agent
      turn: number
      step: number
      provider: string
      failure: LlmFailure
      retryPolicy: ResolvedRetryPolicy | undefined
      signal: AbortSignal
    },
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    const downstream = await next()
    if (downstream?.kind === 'retry') return downstream
    if (payload.signal.aborted || lifetime.signal.aborted) return undefined
    if (isOwnedByProviderPolicy(payload.retryPolicy, payload.failure)) return undefined
    if (!isRetryable(resolved, payload.provider, payload.failure)) return undefined

    const previous = previousRetry(
      payload.agent.session.events,
      payload.turn,
      payload.step,
      payload.provider,
      policyKey,
    )
    const attempt = (previous?.retry ?? 0) + 1
    if (attempt > resolved.maxRetries) return undefined

    const delayMs = retryDelay(resolved, attempt, payload.failure, random)
    if (delayMs === undefined) return undefined

    const retryId = previous?.retryId ?? randomUUID() as RetryId
    const event: RetryScheduledEventData = {
      retryId,
      turn: payload.turn,
      step: payload.step,
      provider: payload.provider,
      mode: 'normal',
      policyKey,
      retry: attempt,
      maxRetries: resolved.maxRetries,
      delayMs,
      failure: payload.failure,
    }
    payload.agent.session.append(RETRY_EVENT, event)
    ctx.logger.warn(
      'deepseek-harness-retry: retrying provider "%s" after %dms (%d/%d, %s: %s)',
      payload.provider,
      delayMs,
      attempt,
      resolved.maxRetries,
      payload.failure.code,
      payload.failure.message,
    )

    const signal = AbortSignal.any([payload.signal, lifetime.signal])
    return track((async () => {
      if (!await wait(delayMs, signal)) return undefined
      if (signal.aborted) return undefined
      const started: LlmRetryStartedEventData = {
        retryId,
        turn: payload.turn,
        step: payload.step,
        retry: attempt,
      }
      payload.agent.session.append(RETRY_STARTED_EVENT, started)
      return { kind: 'retry' } as const
    })())
  }

  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined)
    return recover(payload, next)
  })

  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('deepseek-harness-retry disposed'))
    await Promise.allSettled([...active])
  }, 'deepseek-harness-retry: abort active retry waits')
}
