import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import {
  MessageId,
  freezeMessage,
  type LlmFailure,
  type ResolvedRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {
  LlmRetryEventData,
  LlmRetryStartedEventData,
  RetryId,
} from '@deepseek-ai/dsh-llm-retry/types'
import z from '@deepseek-ai/schemastery'

export const name = 'deepseek-harness-retry'
export const inject = ['agents', 'sessions']

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
  /** Maximum retries for an explicit provider-overload response. */
  overloadMaxRetries?: number
  /** Exact provider-neutral failure codes. Use `*` to retry every request failure. */
  retryableCodes?: string[]
  /** First exponential-backoff delay in milliseconds. */
  initialDelayMs?: number
  /** First delay for an explicit provider-overload response. */
  overloadInitialDelayMs?: number
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
  /** Continue only an unmatched retry scheduled by this plugin after crash repair. */
  resumeInterrupted?: boolean
  /** Also continue an unmatched retry after an intentional lifecycle disposal. */
  resumeDisposed?: boolean
  /** Refuse automatic continuation when the pending retry is older than this many milliseconds. */
  resumeMaxAgeMs?: number
  /** Model-visible instruction used to continue a crash-interrupted turn. */
  resumePrompt?: string
}

export interface ResolvedConfig {
  readonly maxRetries: number
  readonly overloadMaxRetries: number
  readonly retryableCodes: readonly string[]
  readonly initialDelayMs: number
  readonly overloadInitialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
  readonly providers: readonly string[]
  readonly excludeProviders: readonly string[]
  readonly respectRetryAfter: boolean
  readonly resumeInterrupted: boolean
  readonly resumeDisposed: boolean
  readonly resumeMaxAgeMs: number
  readonly resumePrompt: string
}

export const DEFAULT_RESUME_PROMPT = 'DeepSeek Harness stopped before the previous model request produced a complete assistant message, or before a scheduled retry started. Continue the unfinished response from the durable session history. Re-check the current workspace and external state before acting. Do not blindly repeat tool calls that may have side effects; verify their outcome first.'

export const Config: z<Config> = z.object({
  maxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(2),
  overloadMaxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(5),
  retryableCodes: z.array(z.string().min(1)).default([...DEFAULT_RETRYABLE_CODES]),
  initialDelayMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(500),
  overloadInitialDelayMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(2_000),
  maxDelayMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(10_000),
  jitterRatio: z.number().min(0).max(1).default(0.1),
  providers: z.array(z.string().min(1)).default([]),
  excludeProviders: z.array(z.string().min(1)).default([]),
  respectRetryAfter: z.boolean().default(true),
  resumeInterrupted: z.boolean().default(true),
  resumeDisposed: z.boolean().default(false),
  resumeMaxAgeMs: z.number().min(0).max(Number.MAX_SAFE_INTEGER).default(86_400_000),
  resumePrompt: z.string().min(1).default(DEFAULT_RESUME_PROMPT),
})

/** Standard DSH retry event shape used by the built-in Web projection and persistence catalog. */
export type RetryScheduledEventData = Extract<LlmRetryEventData, { mode: 'normal' }>

export interface RetryInternals {
  /** Deterministic random source for tests. */
  random?: () => number
  /** Abort-aware wait override for tests. */
  wait?: (delayMs: number, signal: AbortSignal) => Promise<boolean>
  /** Wall-clock override for interrupted-session age checks. */
  now?: () => number
  /** Deferred lifecycle callback override for tests. */
  defer?: (operation: () => void) => () => void
}

const DEFAULT_CONFIG: ResolvedConfig = Object.freeze({
  maxRetries: 2,
  overloadMaxRetries: 5,
  retryableCodes: DEFAULT_RETRYABLE_CODES,
  initialDelayMs: 500,
  overloadInitialDelayMs: 2_000,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
  providers: Object.freeze([]),
  excludeProviders: Object.freeze([]),
  respectRetryAfter: true,
  resumeInterrupted: true,
  resumeDisposed: false,
  resumeMaxAgeMs: 86_400_000,
  resumePrompt: DEFAULT_RESUME_PROMPT,
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
    overloadMaxRetries: config.overloadMaxRetries ?? DEFAULT_CONFIG.overloadMaxRetries,
    retryableCodes: Object.freeze(normalizeCodes(config.retryableCodes ?? DEFAULT_CONFIG.retryableCodes)),
    initialDelayMs: config.initialDelayMs ?? DEFAULT_CONFIG.initialDelayMs,
    overloadInitialDelayMs: config.overloadInitialDelayMs ?? DEFAULT_CONFIG.overloadInitialDelayMs,
    maxDelayMs: config.maxDelayMs ?? DEFAULT_CONFIG.maxDelayMs,
    jitterRatio: config.jitterRatio ?? DEFAULT_CONFIG.jitterRatio,
    providers: Object.freeze(normalizeProviders(config.providers ?? DEFAULT_CONFIG.providers)),
    excludeProviders: Object.freeze(normalizeProviders(config.excludeProviders ?? DEFAULT_CONFIG.excludeProviders)),
    respectRetryAfter: config.respectRetryAfter ?? DEFAULT_CONFIG.respectRetryAfter,
    resumeInterrupted: config.resumeInterrupted ?? DEFAULT_CONFIG.resumeInterrupted,
    resumeDisposed: config.resumeDisposed ?? DEFAULT_CONFIG.resumeDisposed,
    resumeMaxAgeMs: config.resumeMaxAgeMs ?? DEFAULT_CONFIG.resumeMaxAgeMs,
    resumePrompt: config.resumePrompt ?? DEFAULT_CONFIG.resumePrompt,
  })

  if (!Number.isSafeInteger(resolved.maxRetries) || resolved.maxRetries < 0) {
    throw new Error('deepseek-harness-retry: maxRetries must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(resolved.overloadMaxRetries) || resolved.overloadMaxRetries < 0) {
    throw new Error('deepseek-harness-retry: overloadMaxRetries must be a non-negative safe integer')
  }
  if (
    !Number.isFinite(resolved.initialDelayMs)
    || resolved.initialDelayMs < 0
    || resolved.initialDelayMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(`deepseek-harness-retry: initialDelayMs must be between 0 and ${MAX_TIMER_DELAY_MS}`)
  }
  if (
    !Number.isFinite(resolved.overloadInitialDelayMs)
    || resolved.overloadInitialDelayMs < 0
    || resolved.overloadInitialDelayMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(
      `deepseek-harness-retry: overloadInitialDelayMs must be between 0 and ${MAX_TIMER_DELAY_MS}`,
    )
  }
  if (
    !Number.isFinite(resolved.maxDelayMs)
    || resolved.maxDelayMs < resolved.initialDelayMs
    || resolved.maxDelayMs < resolved.overloadInitialDelayMs
    || resolved.maxDelayMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(
      `deepseek-harness-retry: maxDelayMs must be at least both initial delays and at most ${MAX_TIMER_DELAY_MS}`,
    )
  }
  if (!Number.isFinite(resolved.jitterRatio) || resolved.jitterRatio < 0 || resolved.jitterRatio > 1) {
    throw new Error('deepseek-harness-retry: jitterRatio must be between 0 and 1')
  }
  if (
    !Number.isSafeInteger(resolved.resumeMaxAgeMs)
    || resolved.resumeMaxAgeMs < 0
  ) {
    throw new Error('deepseek-harness-retry: resumeMaxAgeMs must be a non-negative safe integer')
  }
  if (resolved.resumePrompt.trim().length === 0) {
    throw new Error('deepseek-harness-retry: resumePrompt must not be empty')
  }
  if (resolved.retryableCodes.length === 0 && resolved.maxRetries > 0) {
    throw new Error('deepseek-harness-retry: retryableCodes must not be empty when retries are enabled')
  }

  return resolved
}

/** Canonical identity for one resolved behavior, used to keep durable budgets isolated across config changes. */
export function retryPolicyKey(config: ResolvedConfig): string {
  return JSON.stringify([
    'deepseek-harness-retry/v2',
    config.maxRetries,
    config.overloadMaxRetries,
    [...config.retryableCodes].sort(),
    config.initialDelayMs,
    config.overloadInitialDelayMs,
    config.maxDelayMs,
    config.jitterRatio,
    [...config.providers].sort(),
    [...config.excludeProviders].sort(),
    config.respectRetryAfter,
  ])
}

/** Whether pi-ai collapsed an explicit provider-overload response into its generic code. */
export function isOverloadFailure(failure: LlmFailure): boolean {
  return failure.code.trim().toUpperCase() === 'PI_AI_ERROR'
    && /\boverload(?:ed|ing)?\b/i.test(failure.message)
}

/** Resolve the retry budget, giving explicit overloads enough time to clear. */
export function retryLimit(config: ResolvedConfig, failure: LlmFailure): number {
  if (config.maxRetries === 0) return 0
  return isOverloadFailure(failure) ? config.overloadMaxRetries : config.maxRetries
}

/** Decide whether this plugin owns a provider failure after downstream policies delegate. */
export function isRetryable(config: ResolvedConfig, provider: string, failure: LlmFailure): boolean {
  if (retryLimit(config, failure) === 0 || config.excludeProviders.includes(provider)) return false
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

  const initialDelayMs = isOverloadFailure(failure)
    ? config.overloadInitialDelayMs
    : config.initialDelayMs
  const exponent = Math.min(Math.max(attempt - 1, 0), 1024)
  const exponential = initialDelayMs === 0
    ? 0
    : Math.min(initialDelayMs * 2 ** exponent, config.maxDelayMs)
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

const RETRY_POLICY_NAMESPACE = 'deepseek-harness-retry/v2'

export interface PendingRetryContinuation {
  readonly retryId: RetryId
  readonly retry: number
  readonly turn: number
  readonly step: number
  readonly time: number
  readonly kind: 'interrupted' | 'disposed'
}

export interface IncompleteRequestContinuation {
  readonly turn: number
  readonly step: number
  readonly time: number
  readonly kind: 'incomplete-request'
}

export type InterruptedContinuation = PendingRetryContinuation | IncompleteRequestContinuation

function isPluginPolicyKey(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed[0] === RETRY_POLICY_NAMESPACE
  } catch {
    return false
  }
}

/** Find an unmatched retry owned by this plugin in the latest non-terminal turn. */
export function pendingRetryContinuation(
  events: readonly SessionEvent[],
  includeDisposed: boolean = false,
): PendingRetryContinuation | undefined {
  let endIndex = -1
  let turn = -1
  let kind: PendingRetryContinuation['kind'] | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'turn/end') continue
    endIndex = index
    turn = event.data.turn
    if (event.data.reason.kind === 'interrupted') kind = 'interrupted'
    else if (
      includeDisposed
      && event.data.reason.kind === 'aborted'
      && event.data.reason.reason.kind === 'disposed'
    ) kind = 'disposed'
    break
  }
  if (kind === undefined) return undefined

  for (let index = endIndex - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'turn/start' && event.data.turn === turn) break
    if (event.type !== RETRY_EVENT) continue
    const retry = event.data as LlmRetryEventData
    if (
      retry.mode !== 'normal'
      || retry.turn !== turn
      || !isPluginPolicyKey(retry.policyKey)
    ) continue
    const started = events.slice(index + 1).some((candidate) => {
      if (candidate.type !== RETRY_STARTED_EVENT) return false
      const data = candidate.data as LlmRetryStartedEventData
      return data.retryId === retry.retryId
        && data.turn === retry.turn
        && data.step === retry.step
        && data.retry === retry.retry
    })
    if (started) continue
    return {
      retryId: retry.retryId,
      retry: retry.retry,
      turn: retry.turn,
      step: retry.step,
      time: event.time,
      kind,
    }
  }
  return undefined
}

/**
 * Find a crash-interrupted model request that never committed an assistant message.
 * A manual interrupt is excluded twice: its turn ends as aborted/user and DSH records
 * a partial assistant/message with interrupted=true.
 */
export function incompleteRequestContinuation(
  events: readonly SessionEvent[],
): IncompleteRequestContinuation | undefined {
  let endIndex = -1
  let turn = -1
  let time = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'turn/end') continue
    if (event.data.reason.kind !== 'interrupted') return undefined
    endIndex = index
    turn = event.data.turn
    time = event.time
    break
  }
  if (endIndex < 0) return undefined

  let turnStart = -1
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'turn/start' && event.data.turn === turn) {
      turnStart = index
      break
    }
  }
  if (turnStart < 0) return undefined

  let step: number | undefined
  let hasDurableUserInput = false
  let hasAssistantMessage = false
  for (let index = turnStart + 1; index < endIndex; index += 1) {
    const event = events[index]
    if (event.type === 'user/message') hasDurableUserInput = true
    if (event.type === 'step/start' && event.data.turn === turn) {
      step = event.data.step
      hasAssistantMessage = false
      continue
    }
    if (
      step !== undefined
      && event.type === 'assistant/message'
      && event.data.turn === turn
      && event.data.step === step
    ) hasAssistantMessage = true
  }

  if (step === undefined || !hasDurableUserInput || hasAssistantMessage) return undefined
  return { turn, step, time, kind: 'incomplete-request' }
}

/** Stable identity for the one continuation justified by durable interruption evidence. */
export function interruptedResumeMessageId(
  sessionId: SessionId,
  continuation: InterruptedContinuation,
): MessageId {
  const suffix = 'retryId' in continuation
    ? `retry:${continuation.retryId}:${continuation.retry}`
    : `request:${continuation.turn}:${continuation.step}`
  return MessageId(`deepseek-harness-retry:resume:${sessionId}:${suffix}`)
}

function createInterruptedResumeMessage(
  sessionId: SessionId,
  continuation: InterruptedContinuation,
  prompt: string,
) {
  const summary = 'retryId' in continuation
    ? `Continuing pending retry ${continuation.retry} after DSH restart.`
    : `Continuing incomplete request from turn ${continuation.turn} after DSH restart.`
  return freezeMessage({
    id: interruptedResumeMessageId(sessionId, continuation),
    role: 'user' as const,
    content: [{ type: 'text' as const, text: prompt }],
    source: {
      kind: 'plugin' as const,
      plugin: name,
      form: 'notice' as const,
      summary,
    },
  })
}

/** Queue only work proven unfinished; existing inbox work is never mutated or duplicated. */
export function resumeInterruptedAgent(
  agent: Agent,
  config: ResolvedConfig,
  now: number = Date.now(),
): boolean {
  if (
    !config.resumeInterrupted
    || agent.session.header.origin === 'subagent'
    || agent.inbox.hasPending
  ) return false
  const continuation = pendingRetryContinuation(agent.session.events, config.resumeDisposed)
    ?? incompleteRequestContinuation(agent.session.events)
  if (continuation === undefined) return false
  if (now - continuation.time > config.resumeMaxAgeMs) return false
  agent.followup(createInterruptedResumeMessage(agent.id, continuation, config.resumePrompt))
  return true
}

function timerDefer(operation: () => void): () => void {
  const timer = setTimeout(operation, 0)
  return () => clearTimeout(timer)
}

/** Install automatic request-error recovery and interrupted-session continuation. */
export function apply(ctx: Context, config: Config = {}, internals: RetryInternals = {}): void {
  const resolved = resolveConfig(config)
  const policyKey = retryPolicyKey(resolved)
  const random = internals.random ?? Math.random
  const wait = internals.wait ?? cancellableDelay
  const now = internals.now ?? Date.now
  const defer = internals.defer ?? timerDefer
  const lifetime = new AbortController()
  const active = new Set<Promise<unknown>>()
  const scheduled = new Set<() => void>()

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
    return track((async () => {
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
      const maxRetries = retryLimit(resolved, payload.failure)
      if (attempt > maxRetries) return undefined

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
        maxRetries,
        delayMs,
        failure: payload.failure,
      }
      payload.agent.session.append(RETRY_EVENT, event)
      if (resolved.resumeInterrupted) {
        try {
          const durable = await ctx.sessions.flush(payload.agent.session)
          if (!durable) {
            ctx.logger.warn(
              'deepseek-harness-retry: retry checkpoint unavailable for session "%s"; restart recovery is best-effort',
              payload.agent.id,
            )
          }
        } catch (error) {
          ctx.logger.warn(
            'deepseek-harness-retry: could not checkpoint retry state for session "%s"; restart recovery is best-effort: %s',
            payload.agent.id,
            String(error),
          )
        }
      }
      if (payload.signal.aborted || lifetime.signal.aborted) return undefined
      ctx.logger.warn(
        'deepseek-harness-retry: retrying provider "%s" after %dms (%d/%d, %s: %s)',
        payload.provider,
        delayMs,
        attempt,
        maxRetries,
        payload.failure.code,
        payload.failure.message,
      )

      const signal = AbortSignal.any([payload.signal, lifetime.signal])
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

  const disposeRetryListener = ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined)
    return recover(payload, next)
  })

  const disposeResumeListener = ctx.on('agent/session-start', ({ agent, source }) => {
    if (source !== 'resume' || !resolved.resumeInterrupted || lifetime.signal.aborted) return
    let cancel = () => {}
    cancel = defer(() => {
      scheduled.delete(cancel)
      if (
        lifetime.signal.aborted
        || agent.status !== 'idle'
        || ctx.agents.get(agent.id) !== agent
      ) return
      try {
        const maintenance = agent.runMaintenance(async (signal) => {
          if (
            signal.aborted
            || lifetime.signal.aborted
            || ctx.agents.get(agent.id) !== agent
          ) return
          if (!resumeInterruptedAgent(agent, resolved, now())) return
          try {
            const durable = await ctx.sessions.flush(agent.session)
            if (!durable) {
              ctx.logger.warn(
                'deepseek-harness-retry: continuation checkpoint unavailable for session "%s"',
                agent.id,
              )
            }
          } catch (error) {
            ctx.logger.warn(
              'deepseek-harness-retry: could not checkpoint continuation for session "%s": %s',
              agent.id,
              String(error),
            )
          }
          ctx.logger.warn(
            'deepseek-harness-retry: continuing proven unfinished work in session "%s"',
            agent.id,
          )
        })
        void track(maintenance).catch((error) => {
          if (lifetime.signal.aborted) return
          ctx.logger.warn(
            'deepseek-harness-retry: could not continue pending retry in session "%s": %s',
            agent.id,
            String(error),
          )
        })
      } catch (error) {
        if (agent.status !== 'idle' || lifetime.signal.aborted) return
        ctx.logger.warn(
          'deepseek-harness-retry: could not start continuation maintenance for session "%s": %s',
          agent.id,
          String(error),
        )
      }
    })
    scheduled.add(cancel)
  })

  ctx.effect(() => async () => {
    disposeRetryListener()
    disposeResumeListener()
    lifetime.abort(new Error('deepseek-harness-retry disposed'))
    for (const cancel of scheduled) cancel()
    scheduled.clear()
    await Promise.allSettled([...active])
  }, 'deepseek-harness-retry: abort active retry and resume work')
}
