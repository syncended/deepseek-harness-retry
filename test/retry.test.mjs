import assert from 'node:assert/strict'
import test from 'node:test'

import { Session, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_RESUME_PROMPT,
  RETRY_EVENT,
  RETRY_STARTED_EVENT,
  apply,
  incompleteRequestContinuation,
  interruptedResumeMessageId,
  isOverloadFailure,
  isOwnedByProviderPolicy,
  isRetryable,
  pendingRetryContinuation,
  resolveConfig,
  resumeInterruptedAgent,
  retryDelay,
  retryLimit,
  retryPolicyKey,
} from '../dist/index.js'

function createHarness(config = {}, internals = {}) {
  let cleanup
  const { flush: flushOverride, ...pluginInternals } = internals
  const warnings = []
  const listeners = new Map()
  const liveAgents = new Map()
  const flushes = []
  const ctx = {
    logger: {
      warn: (...args) => warnings.push(args),
    },
    agents: {
      get: (id) => liveAgents.get(id),
    },
    sessions: {
      async flush(session) {
        flushes.push(session)
        return flushOverride === undefined ? true : flushOverride(session)
      },
    },
    on(event, callback) {
      listeners.set(event, callback)
      return () => {
        listeners.delete(event)
      }
    },
    effect(setup) {
      cleanup = setup()
    },
  }

  apply(ctx, config, pluginInternals)
  assert.equal(typeof listeners.get('agent/request-error'), 'function')
  assert.equal(typeof listeners.get('agent/session-start'), 'function')

  return {
    warnings,
    flushes,
    invoke: (payload, next = async () => undefined) => listeners.get('agent/request-error')(payload, next),
    start(agent, source = 'resume') {
      liveAgents.set(agent.id, agent)
      listeners.get('agent/session-start')({ agent, source })
    },
    dispose: async () => cleanup?.(),
  }
}

function event(type, data, seq, time = 1_000) {
  return { type, data, seq, time }
}

function pendingRetryEvents({
  reason = { kind: 'interrupted' },
  started = false,
  policyKey = retryPolicyKey(resolveConfig()),
} = {}) {
  const retryId = 'retry-1'
  const events = [
    event('turn/start', { turn: 1 }, 0),
    event(RETRY_EVENT, {
      retryId,
      turn: 1,
      step: 1,
      provider: 'openai',
      mode: 'normal',
      policyKey,
      retry: 1,
      maxRetries: 2,
      delayMs: 100,
      failure: { code: 'PI_AI_ERROR', message: 'internal' },
    }, 1),
  ]
  if (started) {
    events.push(event(RETRY_STARTED_EVENT, { retryId, turn: 1, step: 1, retry: 1 }, 2))
  }
  events.push(event('turn/end', { turn: 1, reason }, events.length))
  return events
}

function incompleteRequestEvents({
  reason = { kind: 'interrupted' },
  assistantMessage = false,
  interruptedMessage = false,
  includeUser = true,
} = {}) {
  const events = [
    event('turn/start', { turn: 1 }, 0),
    event('step/start', { turn: 1, step: 1 }, 1),
  ]
  if (includeUser) {
    events.push(event('user/message', {
      id: 'user-1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'continue the task' }],
    }, events.length))
  }
  events.push(event('assistant/chunk', {
    turn: 1,
    step: 1,
    chunk: { type: 'text-delta', index: 0, text: 'partial' },
  }, events.length))
  if (assistantMessage) {
    events.push(event('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-1',
        role: 'assistant',
        source: { kind: 'model', provider: 'openai', model: 'test' },
        content: [{ type: 'text', text: 'partial or complete' }],
      },
      ...(interruptedMessage ? { interrupted: true } : {}),
    }, events.length))
  }
  events.push(event('step/end', { turn: 1, step: 1 }, events.length))
  events.push(event('turn/end', { turn: 1, reason }, events.length))
  return events
}

function createResumeAgent({
  id = 'resume-session',
  events = pendingRetryEvents(),
  origin,
  nextTurn = [],
  nextStep = [],
} = {}) {
  const followed = []
  const maintenanceCalls = []
  const turnQueue = [...nextTurn]
  const stepQueue = [...nextStep]
  let status = 'idle'
  let maintenanceActive = false
  const inbox = {
    nextTurn: turnQueue,
    nextStep: stepQueue,
    get hasPending() {
      return turnQueue.length > 0 || stepQueue.length > 0
    },
  }
  const agent = {
    id,
    get status() {
      return status
    },
    set status(value) {
      status = value
    },
    session: { header: { id, origin }, events },
    inbox,
    runMaintenance(task) {
      if (status !== 'idle' || maintenanceActive) throw new Error('agent already has active work')
      maintenanceActive = true
      const controller = new AbortController()
      maintenanceCalls.push(controller)
      return Promise.resolve()
        .then(() => task(controller.signal))
        .finally(() => { maintenanceActive = false })
    },
    followup(message) {
      followed.push(message)
      turnQueue.push(message)
    },
  }
  return { agent, followed, maintenanceCalls }
}

function createPayload(overrides = {}) {
  const events = []
  const session = {
    events,
    append(type, data) {
      events.push({ type, data })
    },
  }

  return {
    agent: { id: 'retry-session', session },
    turn: 1,
    step: 1,
    provider: 'openai',
    failure: { code: 'PI_AI_ERROR', message: 'An internal error occurred' },
    retryPolicy: undefined,
    signal: new AbortController().signal,
    ...overrides,
  }
}

test('default policy retries generic GPT/pi-ai errors but not auth failures', () => {
  const config = resolveConfig()
  assert.equal(isRetryable(config, 'openai', { code: 'PI_AI_ERROR', message: 'internal' }), true)
  assert.equal(isRetryable(config, 'openai', { code: 'UNKNOWN', message: 'unknown' }), true)
  assert.equal(isRetryable(config, 'openai', { code: 'AUTH', message: 'bad key' }), false)
})

test('explicit Codex overloads get a longer retry window', () => {
  const config = resolveConfig()
  const failure = {
    code: 'PI_AI_ERROR',
    message: 'Codex error: Our servers are currently overloaded. Please try again later.',
  }

  assert.equal(isOverloadFailure(failure), true)
  assert.equal(isOverloadFailure({ code: 'PI_AI_ERROR', message: 'WebSocket error' }), false)
  assert.equal(isOverloadFailure({ code: 'SERVER', message: 'servers overloaded' }), false)
  assert.equal(retryLimit(config, failure), 5)
  assert.equal(retryLimit(config, { code: 'PI_AI_ERROR', message: 'generic' }), 2)
  assert.equal(retryLimit(resolveConfig({ maxRetries: 0 }), failure), 0)
  assert.equal(retryDelay(config, 1, failure, () => 0.5), 2_000)
  assert.equal(retryDelay(config, 2, failure, () => 0.5), 4_000)
  assert.equal(retryDelay(config, 4, failure, () => 0.5), 10_000)
})

test('adapter-owned policies keep precedence over this fallback', () => {
  const failure = { code: 'PI_AI_ERROR', message: 'internal' }
  assert.equal(isOwnedByProviderPolicy(undefined, failure), false)
  assert.equal(isOwnedByProviderPolicy({
    mode: 'normal',
    maxRetries: 2,
    retryableCodes: ['SERVER'],
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
  }, failure), false)
  assert.equal(isOwnedByProviderPolicy({
    mode: 'normal',
    maxRetries: 2,
    retryableCodes: ['PI_AI_ERROR'],
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
  }, failure), true)
  assert.equal(isOwnedByProviderPolicy({
    mode: 'always',
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
  }, failure), true)
})

test('policy keys are canonical and change with retry behavior', () => {
  const first = resolveConfig({ retryableCodes: ['UNKNOWN', 'PI_AI_ERROR'] })
  const reordered = resolveConfig({ retryableCodes: ['PI_AI_ERROR', 'UNKNOWN'] })
  const changed = resolveConfig({ retryableCodes: ['UNKNOWN'], maxRetries: 3 })

  assert.equal(retryPolicyKey(first), retryPolicyKey(reordered))
  assert.notEqual(retryPolicyKey(first), retryPolicyKey(changed))
})

test('provider filters and wildcard codes are respected', () => {
  const config = resolveConfig({
    retryableCodes: ['*'],
    providers: ['openai', 'anthropic'],
    excludeProviders: ['anthropic'],
  })

  assert.equal(isRetryable(config, 'openai', { code: 'AUTH', message: 'bad key' }), true)
  assert.equal(isRetryable(config, 'anthropic', { code: 'SERVER', message: 'down' }), false)
  assert.equal(isRetryable(config, 'google', { code: 'SERVER', message: 'down' }), false)
})

test('backoff is exponential, bounded, and honors Retry-After', () => {
  const config = resolveConfig({
    initialDelayMs: 100,
    overloadInitialDelayMs: 100,
    maxDelayMs: 250,
    jitterRatio: 0.2,
  })

  assert.equal(retryDelay(config, 1, { code: 'SERVER', message: 'down' }, () => 0.5), 100)
  assert.equal(retryDelay(config, 2, { code: 'SERVER', message: 'down' }, () => 0.5), 200)
  assert.equal(retryDelay(config, 3, { code: 'SERVER', message: 'down' }, () => 0.5), 250)
  assert.equal(
    retryDelay(config, 1, { code: 'RATE_LIMIT', message: 'slow', providerRetryAfterMs: 200 }, () => 0),
    200,
  )
  assert.equal(
    retryDelay(config, 1, { code: 'RATE_LIMIT', message: 'slow', providerRetryAfterMs: 999 }, () => 0),
    undefined,
  )
  const immediate = resolveConfig({
    initialDelayMs: 0,
    overloadInitialDelayMs: 0,
    maxDelayMs: 0,
    jitterRatio: 1,
  })
  assert.equal(retryDelay(immediate, 10_000, { code: 'UNKNOWN', message: 'retry' }, () => 1), 0)
})

test('plugin delegates first, records the retry, waits, and returns retry', async () => {
  const waits = []
  const harness = createHarness(
    {
      maxRetries: 2,
      initialDelayMs: 100,
      overloadInitialDelayMs: 100,
      maxDelayMs: 100,
      jitterRatio: 0,
    },
    {
      random: () => 0.5,
      wait: async (delayMs, signal) => {
        waits.push({ delayMs, aborted: signal.aborted })
        return true
      },
    },
  )
  const payload = createPayload()
  let delegated = 0

  const result = await harness.invoke(payload, async () => {
    delegated += 1
    return undefined
  })

  assert.deepEqual(result, { kind: 'retry' })
  assert.equal(delegated, 1)
  assert.deepEqual(waits, [{ delayMs: 100, aborted: false }])
  assert.equal(payload.agent.session.events.length, 2)
  assert.equal(payload.agent.session.events[0].type, RETRY_EVENT)
  assert.equal(payload.agent.session.events[0].data.retry, 1)
  assert.equal(payload.agent.session.events[1].type, RETRY_STARTED_EVENT)
  assert.equal(payload.agent.session.events[1].data.retryId, payload.agent.session.events[0].data.retryId)
  assert.equal(harness.warnings.length, 1)
  await harness.dispose()
})

test('plugin preserves a downstream recovery decision without adding a retry', async () => {
  let waited = false
  const harness = createHarness({}, {
    wait: async () => {
      waited = true
      return true
    },
  })
  const payload = createPayload()

  const result = await harness.invoke(payload, async () => ({ kind: 'retry' }))

  assert.deepEqual(result, { kind: 'retry' })
  assert.equal(waited, false)
  assert.equal(payload.agent.session.events.length, 0)
  await harness.dispose()
})

test('plugin does not extend an adapter-owned retry budget', async () => {
  let waited = false
  const harness = createHarness({}, {
    wait: async () => {
      waited = true
      return true
    },
  })
  const payload = createPayload({
    retryPolicy: {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['PI_AI_ERROR'],
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    },
  })

  assert.equal(await harness.invoke(payload), undefined)
  assert.equal(waited, false)
  assert.equal(payload.agent.session.events.length, 0)
  await harness.dispose()
})

test('plugin stops when its retry budget is exhausted', async () => {
  let waits = 0
  const harness = createHarness({ maxRetries: 2 }, {
    wait: async () => {
      waits += 1
      return true
    },
  })
  const payload = createPayload()

  assert.deepEqual(await harness.invoke(payload), { kind: 'retry' })
  assert.deepEqual(await harness.invoke(payload), { kind: 'retry' })
  assert.equal(await harness.invoke(payload), undefined)

  assert.equal(waits, 2)
  assert.equal(payload.agent.session.events.length, 4)
  assert.equal(payload.agent.session.events[2].type, RETRY_EVENT)
  assert.equal(payload.agent.session.events[2].data.retry, 2)
  await harness.dispose()
})

test('plugin uses the overload-specific retry budget and backoff', async () => {
  const waits = []
  const harness = createHarness({}, {
    random: () => 0.5,
    wait: async (delayMs) => {
      waits.push(delayMs)
      return true
    },
  })
  const payload = createPayload({
    failure: {
      code: 'PI_AI_ERROR',
      message: 'Codex error: Our servers are currently overloaded. Please try again later.',
    },
  })

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(await harness.invoke(payload), { kind: 'retry' })
  }
  assert.equal(await harness.invoke(payload), undefined)
  assert.deepEqual(waits, [2_000, 4_000, 8_000, 10_000, 10_000])
  assert.equal(payload.agent.session.events.length, 10)
  assert.equal(payload.agent.session.events[8].data.maxRetries, 5)
  await harness.dispose()
})

test('aborted turns never schedule a retry', async () => {
  const controller = new AbortController()
  controller.abort()
  const harness = createHarness()
  const payload = createPayload({ signal: controller.signal })

  const result = await harness.invoke(payload)

  assert.equal(result, undefined)
  assert.equal(payload.agent.session.events.length, 0)
  await harness.dispose()
})

test('turn cancellation interrupts an active backoff', async () => {
  const controller = new AbortController()
  const harness = createHarness({ initialDelayMs: 10_000, maxDelayMs: 10_000, jitterRatio: 0 })
  const payload = createPayload({ signal: controller.signal })

  const pending = harness.invoke(payload)
  await Promise.resolve()
  controller.abort()

  assert.equal(await pending, undefined)
  assert.equal(payload.agent.session.events.length, 1)
  await harness.dispose()
})

test('plugin disposal aborts and drains active backoffs', async () => {
  const harness = createHarness({ initialDelayMs: 10_000, maxDelayMs: 10_000, jitterRatio: 0 })
  const payload = createPayload()

  const pending = harness.invoke(payload)
  await Promise.resolve()
  await harness.dispose()

  assert.equal(await pending, undefined)
  assert.equal(payload.agent.session.events.length, 1)
})

test('plugin disposal does not wait for a stuck downstream policy', async () => {
  const harness = createHarness()
  const payload = createPayload()

  void harness.invoke(payload, () => new Promise(() => {}))
  await Promise.resolve()
  await harness.dispose()

  assert.equal(payload.agent.session.events.length, 0)
})

test('downstream failures propagate without scheduling a retry', async () => {
  const harness = createHarness()
  const payload = createPayload()

  await assert.rejects(
    harness.invoke(payload, async () => {
      throw new Error('downstream policy failed')
    }),
    /downstream policy failed/,
  )
  assert.equal(payload.agent.session.events.length, 0)
  await harness.dispose()
})

test('DSH crash repair recovers only a real plugin-owned pending retry', () => {
  const session = Session.create('repair-smoke')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const retry = session.append(RETRY_EVENT, {
    retryId: 'retry-1',
    turn: 1,
    step: 1,
    provider: 'openai',
    mode: 'normal',
    policyKey: retryPolicyKey(resolveConfig()),
    retry: 1,
    maxRetries: 2,
    delayMs: 100,
    failure: { code: 'PI_AI_ERROR', message: 'internal' },
  })
  const repaired = [...session.events, ...interruptedTurnClosers(session.events)]

  assert.deepEqual(pendingRetryContinuation(repaired), {
    retryId: 'retry-1',
    retry: 1,
    turn: 1,
    step: 1,
    time: retry.time,
    kind: 'interrupted',
  })
  assert.equal(repaired.at(-2).type, 'step/end')
  assert.equal(repaired.at(-1).type, 'turn/end')
})

test('finished, started, foreign, and generic interrupted turns never auto-resume', () => {
  assert.equal(pendingRetryContinuation(pendingRetryEvents({ reason: { kind: 'completed' } })), undefined)
  assert.equal(pendingRetryContinuation(pendingRetryEvents({ started: true })), undefined)
  assert.equal(pendingRetryContinuation(pendingRetryEvents({ policyKey: 'foreign-policy' })), undefined)
  assert.equal(pendingRetryContinuation([
    event('turn/start', { turn: 1 }, 0),
    event('turn/end', { turn: 1, reason: { kind: 'interrupted' } }, 1),
  ]), undefined)
})

test('crash-interrupted request without an assistant message is proven unfinished', () => {
  assert.deepEqual(incompleteRequestContinuation(incompleteRequestEvents()), {
    turn: 1,
    step: 1,
    time: 1_000,
    kind: 'incomplete-request',
  })
})

test('completed and manually interrupted assistant messages never auto-resume', () => {
  assert.equal(incompleteRequestContinuation(incompleteRequestEvents({
    assistantMessage: true,
  })), undefined)
  assert.equal(incompleteRequestContinuation(incompleteRequestEvents({
    reason: { kind: 'aborted', reason: { kind: 'user' } },
    assistantMessage: true,
    interruptedMessage: true,
  })), undefined)
  assert.equal(incompleteRequestContinuation(incompleteRequestEvents({
    includeUser: false,
  })), undefined)
})

test('disposed retries require a separate explicit opt-in', () => {
  const events = pendingRetryEvents({
    reason: { kind: 'aborted', reason: { kind: 'disposed' } },
  })
  assert.equal(pendingRetryContinuation(events), undefined)
  assert.equal(pendingRetryContinuation(events, true)?.kind, 'disposed')
})

test('a pending plugin retry gets at most one model-visible continuation', () => {
  const config = resolveConfig()
  const { agent, followed } = createResumeAgent()
  const continuation = pendingRetryContinuation(agent.session.events)

  assert.equal(resumeInterruptedAgent(agent, config, 1_000), true)
  assert.equal(followed.length, 1)
  assert.equal(followed[0].id, interruptedResumeMessageId(agent.id, continuation))
  assert.equal(followed[0].content[0].text, DEFAULT_RESUME_PROMPT)
  assert.deepEqual(followed[0].source, {
    kind: 'plugin',
    plugin: 'deepseek-harness-retry',
    form: 'notice',
    summary: 'Continuing pending retry 1 after DSH restart.',
  })

  // Existing inbox work is a fail-closed fence: never mutate or duplicate it.
  assert.equal(resumeInterruptedAgent(agent, config, 1_000), false)
  assert.equal(followed.length, 1)
  assert.equal(agent.inbox.nextTurn.length, 1)
})

test('a crash-interrupted incomplete request gets one continuation', () => {
  const { agent, followed } = createResumeAgent({ events: incompleteRequestEvents() })
  const continuation = incompleteRequestContinuation(agent.session.events)

  assert.equal(resumeInterruptedAgent(agent, resolveConfig(), 1_000), true)
  assert.equal(followed.length, 1)
  assert.equal(followed[0].id, interruptedResumeMessageId(agent.id, continuation))
  assert.equal(
    followed[0].source.summary,
    'Continuing incomplete request from turn 1 after DSH restart.',
  )
  assert.equal(resumeInterruptedAgent(agent, resolveConfig(), 1_000), false)
})

test('existing durable inbox work is left untouched and never used as a wake hack', () => {
  const first = { id: 'first', role: 'user', content: [], source: { kind: 'user' } }
  const second = { id: 'second', role: 'user', content: [], source: { kind: 'user' } }
  const { agent, followed } = createResumeAgent({ nextTurn: [first, second] })

  assert.equal(resumeInterruptedAgent(agent, resolveConfig(), 1_000), false)
  assert.deepEqual(agent.inbox.nextTurn.map((message) => message.id), ['first', 'second'])
  assert.equal(followed.length, 0)
})

test('automatic continuation is bounded by config and excludes subagents', () => {
  const stale = createResumeAgent()
  assert.equal(resumeInterruptedAgent(stale.agent, resolveConfig({ resumeMaxAgeMs: 10 }), 1_011), false)

  const disabled = createResumeAgent()
  assert.equal(resumeInterruptedAgent(disabled.agent, resolveConfig({ resumeInterrupted: false }), 1_000), false)

  const child = createResumeAgent({ origin: 'subagent' })
  assert.equal(resumeInterruptedAgent(child.agent, resolveConfig(), 1_000), false)

  const disposed = createResumeAgent({
    events: pendingRetryEvents({ reason: { kind: 'aborted', reason: { kind: 'disposed' } } }),
  })
  assert.equal(resumeInterruptedAgent(disposed.agent, resolveConfig(), 1_000), false)
  assert.equal(resumeInterruptedAgent(disposed.agent, resolveConfig({ resumeDisposed: true }), 1_000), true)
})

test('session-start continuation is fenced by deferred maintenance and exact liveness', async () => {
  const deferred = []
  const harness = createHarness({}, {
    now: () => 1_000,
    defer(operation) {
      const entry = { operation, cancelled: false }
      deferred.push(entry)
      return () => { entry.cancelled = true }
    },
  })
  const resumed = createResumeAgent()

  harness.start(resumed.agent, 'startup')
  assert.equal(deferred.length, 0)
  harness.start(resumed.agent, 'resume')
  assert.equal(deferred.length, 1)
  deferred[0].operation()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(resumed.maintenanceCalls.length, 1)
  assert.equal(resumed.followed.length, 1)
  assert.equal(harness.warnings.at(-1)[0], 'deepseek-harness-retry: continuing proven unfinished work in session "%s"')

  const busy = createResumeAgent({ id: 'busy-session' })
  harness.start(busy.agent, 'resume')
  busy.agent.status = 'running'
  deferred[1].operation()
  await Promise.resolve()
  assert.equal(busy.maintenanceCalls.length, 0)
  assert.equal(busy.followed.length, 0)
  await harness.dispose()
})

test('plugin disposal cancels deferred interrupted-session continuation', async () => {
  const deferred = []
  const harness = createHarness({}, {
    defer(operation) {
      const entry = { operation, cancelled: false }
      deferred.push(entry)
      return () => { entry.cancelled = true }
    },
  })
  harness.start(createResumeAgent().agent)
  await harness.dispose()
  assert.equal(deferred[0].cancelled, true)
})

test('retry scheduling checkpoints its durable marker for restart recovery', async () => {
  const harness = createHarness({}, { wait: async () => true })
  const payload = createPayload()
  assert.deepEqual(await harness.invoke(payload), { kind: 'retry' })
  assert.deepEqual(harness.flushes, [payload.agent.session])
  await harness.dispose()
})

test('checkpoint failure keeps live retry but explicitly degrades restart recovery', async () => {
  const unavailable = createHarness({}, {
    flush: async () => false,
    wait: async () => true,
  })
  assert.deepEqual(await unavailable.invoke(createPayload()), { kind: 'retry' })
  assert.match(unavailable.warnings[0][0], /restart recovery is best-effort/)
  await unavailable.dispose()

  const rejected = createHarness({}, {
    flush: async () => { throw new Error('disk offline') },
    wait: async () => true,
  })
  assert.deepEqual(await rejected.invoke(createPayload()), { kind: 'retry' })
  assert.match(rejected.warnings[0][0], /restart recovery is best-effort/)
  assert.equal(rejected.warnings[0][2], 'Error: disk offline')
  await rejected.dispose()
})

test('plugin disposal aborts and drains a retry checkpoint already in flight', async () => {
  let releaseFlush
  let announceFlush
  const flushEntered = new Promise((resolve) => { announceFlush = resolve })
  const flushGate = new Promise((resolve) => { releaseFlush = resolve })
  let waits = 0
  const harness = createHarness({}, {
    flush: async () => {
      announceFlush()
      return flushGate
    },
    wait: async () => {
      waits += 1
      return true
    },
  })
  const pending = harness.invoke(createPayload())
  await flushEntered

  let disposed = false
  const disposal = harness.dispose().then(() => { disposed = true })
  await Promise.resolve()
  assert.equal(disposed, false)

  releaseFlush(true)
  await disposal
  assert.equal(await pending, undefined)
  assert.equal(waits, 0)
})

test('invalid config relationships fail during plugin activation', () => {
  assert.throws(
    () => resolveConfig({ initialDelayMs: 1000, maxDelayMs: 100 }),
    /maxDelayMs must be at least both initial delays/,
  )
  assert.throws(
    () => resolveConfig({ overloadInitialDelayMs: 1000, maxDelayMs: 500 }),
    /maxDelayMs must be at least both initial delays/,
  )
  assert.throws(
    () => resolveConfig({ resumeMaxAgeMs: 1.5 }),
    /resumeMaxAgeMs must be a non-negative safe integer/,
  )
  assert.throws(
    () => resolveConfig({ resumePrompt: '   ' }),
    /resumePrompt must not be empty/,
  )
})
