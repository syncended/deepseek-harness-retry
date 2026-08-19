import type { Context } from '@deepseek-ai/cordis';
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm';
import type { LlmRetryEventData } from '@deepseek-ai/dsh-llm-retry/types';
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
    /** Exact provider-neutral failure codes. Use `*` to retry every request failure. */
    retryableCodes?: string[];
    /** First exponential-backoff delay in milliseconds. */
    initialDelayMs?: number;
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
}
export interface ResolvedConfig {
    readonly maxRetries: number;
    readonly retryableCodes: readonly string[];
    readonly initialDelayMs: number;
    readonly maxDelayMs: number;
    readonly jitterRatio: number;
    readonly providers: readonly string[];
    readonly excludeProviders: readonly string[];
    readonly respectRetryAfter: boolean;
}
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
}
/** Resolve defaults and validate relationships not expressible by the schema. */
export declare function resolveConfig(config?: Config): ResolvedConfig;
/** Canonical identity for one resolved behavior, used to keep durable budgets isolated across config changes. */
export declare function retryPolicyKey(config: ResolvedConfig): string;
/** Decide whether this plugin owns a provider failure after downstream policies delegate. */
export declare function isRetryable(config: ResolvedConfig, provider: string, failure: LlmFailure): boolean;
/** Whether the adapter-owned built-in policy owns this code, regardless of its current finite budget. */
export declare function isOwnedByProviderPolicy(policy: ResolvedRetryPolicy | undefined, failure: LlmFailure): boolean;
/** Compute bounded exponential backoff, or delegate when Retry-After exceeds the configured cap. */
export declare function retryDelay(config: ResolvedConfig, attempt: number, failure: LlmFailure, random?: () => number): number | undefined;
/** Wait without leaving a timer alive after cancellation. */
export declare function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean>;
/** Install automatic request-error recovery. Downstream policies get first refusal. */
export declare function apply(ctx: Context, config?: Config, internals?: RetryInternals): void;
//# sourceMappingURL=index.d.ts.map