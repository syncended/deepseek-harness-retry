import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { MessageId, type LlmFailure, type ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm';
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import type { LlmRetryEventData, RetryId } from '@deepseek-ai/dsh-llm-retry/types';
import z from '@deepseek-ai/schemastery';
export declare const name = "deepseek-harness-retry";
export declare const inject: string[];
export declare const RETRY_EVENT: "llm/retry";
export declare const RETRY_STARTED_EVENT: "llm/retry-started";
/** Errors normally worth retrying, including the generic pi-ai error used by GPT routes. */
export declare const DEFAULT_RETRYABLE_CODES: readonly ["STREAM_CLOSED", "MALFORMED_RESPONSE", "PI_AI_ERROR", "API_ERROR", "MODEL_ERROR", "INTERNAL_ERROR", "PROVIDER_ERROR", "UNKNOWN"];
export interface Config {
    /** Maximum retries after the original failed request. */
    maxRetries?: number;
    /** Maximum retries for an explicit provider-overload response. */
    overloadMaxRetries?: number;
    /** Exact provider-neutral failure codes. Use `*` to retry every request failure. */
    retryableCodes?: string[];
    /** First exponential-backoff delay in milliseconds. */
    initialDelayMs?: number;
    /** First delay for an explicit provider-overload response. */
    overloadInitialDelayMs?: number;
    /** Maximum local or provider-requested delay in milliseconds. */
    maxDelayMs?: number;
    /** Symmetric random multiplier around each local delay, from 0 to 1. */
    jitterRatio?: number;
    /** Restrict retries to these provider routes. Empty means every provider. */
    providers?: string[];
    /** Provider routes that must never be retried by this plugin. */
    excludeProviders?: string[];
    /** Honor a valid provider Retry-After value, capped by maxDelayMs. */
    respectRetryAfter?: boolean;
    /** Continue only an unmatched retry scheduled by this plugin after crash repair. */
    resumeInterrupted?: boolean;
    /** Also continue an unmatched retry after an intentional lifecycle disposal. */
    resumeDisposed?: boolean;
    /** Refuse automatic continuation when the pending retry is older than this many milliseconds. */
    resumeMaxAgeMs?: number;
    /** Model-visible instruction used to continue a crash-interrupted turn. */
    resumePrompt?: string;
}
export interface ResolvedConfig {
    readonly maxRetries: number;
    readonly overloadMaxRetries: number;
    readonly retryableCodes: readonly string[];
    readonly initialDelayMs: number;
    readonly overloadInitialDelayMs: number;
    readonly maxDelayMs: number;
    readonly jitterRatio: number;
    readonly providers: readonly string[];
    readonly excludeProviders: readonly string[];
    readonly respectRetryAfter: boolean;
    readonly resumeInterrupted: boolean;
    readonly resumeDisposed: boolean;
    readonly resumeMaxAgeMs: number;
    readonly resumePrompt: string;
}
export declare const DEFAULT_RESUME_PROMPT = "The previous model request failed and this plugin scheduled a retry, but DeepSeek Harness stopped before that retry started. Continue the unfinished response from the durable session history. Re-check the current workspace and external state before acting. Do not blindly repeat tool calls that may have side effects; verify their outcome first.";
export declare const Config: z<Config>;
/** Standard DSH retry event shape used by the built-in Web projection and persistence catalog. */
export type RetryScheduledEventData = Extract<LlmRetryEventData, {
    mode: 'normal';
}>;
export interface RetryInternals {
    /** Deterministic random source for tests. */
    random?: () => number;
    /** Abort-aware wait override for tests. */
    wait?: (delayMs: number, signal: AbortSignal) => Promise<boolean>;
    /** Wall-clock override for interrupted-session age checks. */
    now?: () => number;
    /** Deferred lifecycle callback override for tests. */
    defer?: (operation: () => void) => () => void;
}
/** Resolve defaults and validate relationships not expressible by the schema. */
export declare function resolveConfig(config?: Config): ResolvedConfig;
/** Canonical identity for one resolved behavior, used to keep durable budgets isolated across config changes. */
export declare function retryPolicyKey(config: ResolvedConfig): string;
/** Whether pi-ai collapsed an explicit provider-overload response into its generic code. */
export declare function isOverloadFailure(failure: LlmFailure): boolean;
/** Resolve the retry budget, giving explicit overloads enough time to clear. */
export declare function retryLimit(config: ResolvedConfig, failure: LlmFailure): number;
/** Decide whether this plugin owns a provider failure after downstream policies delegate. */
export declare function isRetryable(config: ResolvedConfig, provider: string, failure: LlmFailure): boolean;
/** Whether the adapter-owned built-in policy owns this code, regardless of its current finite budget. */
export declare function isOwnedByProviderPolicy(policy: ResolvedRetryPolicy | undefined, failure: LlmFailure): boolean;
/** Compute bounded exponential backoff, or delegate when Retry-After exceeds the configured cap. */
export declare function retryDelay(config: ResolvedConfig, attempt: number, failure: LlmFailure, random?: () => number): number | undefined;
/** Wait without leaving a timer alive after cancellation. */
export declare function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean>;
export interface PendingRetryContinuation {
    readonly retryId: RetryId;
    readonly retry: number;
    readonly turn: number;
    readonly step: number;
    readonly time: number;
    readonly kind: 'interrupted' | 'disposed';
}
/** Find an unmatched retry owned by this plugin in the latest non-terminal turn. */
export declare function pendingRetryContinuation(events: readonly SessionEvent[], includeDisposed?: boolean): PendingRetryContinuation | undefined;
/** Stable identity for the one continuation justified by a durable pending retry. */
export declare function interruptedResumeMessageId(sessionId: SessionId, continuation: Pick<PendingRetryContinuation, 'retryId' | 'retry'>): MessageId;
/** Queue only a plugin-owned pending retry; existing inbox work is never mutated or duplicated. */
export declare function resumeInterruptedAgent(agent: Agent, config: ResolvedConfig, now?: number): boolean;
/** Install automatic request-error recovery and interrupted-session continuation. */
export declare function apply(ctx: Context, config?: Config, internals?: RetryInternals): void;
//# sourceMappingURL=index.d.ts.map