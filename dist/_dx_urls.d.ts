/**
 * URL derivation + F2 ingest fallback chain — TypeScript port of _dx_urls.py.
 *
 * Same two responsibilities as the Python version:
 *
 *   1. `deriveHost(backend, baseUrl)` — convention-based subdomain rewriting.
 *      Pure function, no state.
 *
 *   2. `IngestUrlResolver` — stateful F2 fallback chain for the event-ingest
 *      hot path (contracts §3.5). Resolves the URL to POST events to via a
 *      4-step chain.
 *
 * No internal locks (JavaScript is single-threaded — event-loop concurrency
 * doesn't race the cache the way Python threads can). The Python version's
 * `threading.Lock` is just not needed here.
 *
 * Discovery is performed via a caller-supplied async callback (`discoveryFn`)
 * so this module has no dependency on the generated ApiClient or any
 * specific HTTP library.
 */
import { type Backend } from './_dx_routing';
export declare const METER_INGEST_PATH = "/api/v1/events";
declare const DISCOVERY_PATH = "/v1/tenant/config";
/**
 * Strip scheme and trailing slash from a caller-provided baseUrl and
 * return the bare host. Accepts "moolabs.com" / "https://moolabs.com" /
 * "https://moolabs.com/" / "  moolabs.com  ".
 *
 * Empty or syntactically invalid input throws — caught at construction time.
 */
export declare function normalizeBaseUrl(baseUrl: string): string;
/** Return `https://{subdomain}.{baseUrl}` for a backend. */
export declare function deriveHost(backend: Backend, baseUrl: string): string;
/**
 * True iff `rawUrl`'s hostname is `baseUrl` itself or a proper subdomain
 * of it. Used by the F2 chain's discovery step as defense-in-depth: a
 * compromised BFF could otherwise return an attacker-controlled host in
 * `endpoints.ingest` and the SDK would POST customer events + the API
 * key to it.
 *
 * The leading "." in the suffix check rejects "moolabs.com.attacker.com"
 * — without it, an endsWith("moolabs.com") match would erroneously
 * accept the attacker host.
 *
 * Exported for unit tests.
 */
export declare function hostMatchesBaseUrl(rawUrl: string, baseUrl: string): boolean;
/**
 * Tunables for `IngestUrlResolver`. Defaults match _dx_urls.py / contracts §3.5.
 * All illustrative; pinned at LLD per O6.
 */
export interface IngestResolverConfig {
    /** Bounded TTL on a failed discovery attempt. Within this window the
     *  SDK skips re-trying discovery and goes straight to step 3. */
    readonly discoveryRetryTtlSec: number;
    /** Consecutive POST failures to a cached URL before cache invalidation. */
    readonly postFailureThreshold: number;
    /** TTL on "recently failed" memory — discovery returning the same URL
     *  during this window is skipped. Prevents loops on a still-dead URL. */
    readonly recentlyFailedTtlSec: number;
}
export declare const DEFAULT_INGEST_RESOLVER_CONFIG: IngestResolverConfig;
/** Callback that returns the parsed /tenant/config response. Async since
 *  the typical caller wraps an HTTP request. */
export type DiscoveryFn = () => Promise<{
    endpoints?: {
        ingest?: string;
        [k: string]: unknown;
    };
    [k: string]: unknown;
}>;
/** Clock callback — returns seconds since some epoch. Default uses
 *  `performance.now()` (monotonic) divided by 1000 to match Python's units. */
export type Clock = () => number;
export declare class IngestUrlResolver {
    private readonly baseUrl;
    private readonly discoveryFn;
    private readonly region;
    private readonly config;
    private readonly clock;
    private cachedUrl;
    private discoveryBlockedUntil;
    private readonly recentlyFailed;
    private readonly postFailures;
    private discoveryPromise;
    constructor(opts: {
        baseUrl: string;
        discoveryFn?: DiscoveryFn | null;
        region?: string;
        config?: Partial<IngestResolverConfig>;
        clock?: Clock;
    });
    /** Run the F2 chain and return a URL to POST events to. Async because
     *  step 2 may invoke the discovery HTTP callback. Always resolves;
     *  discovery failures fall through to step 3/4 rather than rejecting. */
    getIngestUrl(): Promise<string>;
    /** Update state based on the outcome of POSTing to `url`.
     *
     *  On success: reset the per-URL failure counter.
     *  On failure: increment; at threshold AND if `url` is the cached one,
     *  invalidate the cache + record URL as recently failed. */
    reportPostOutcome(url: string, success: boolean): void;
    /** Evict entries from `m` until size <= maxEntries. The comparator runs
     *  on the values; entries that compare LESS are evicted first. */
    private capMap;
    /** F2 step 4 — always-derivable last resort. Public so tests can assert. */
    step4LastResortUrl(): string;
    getStateSnapshot(): {
        cachedUrl: string | null;
        discoveryBlockedForSec: number;
        recentlyFailedCount: number;
        postFailuresTracked: number;
    };
    get cached(): string | null;
    private tryDiscovery;
    private regionFallbackUrl;
    private expireRecentlyFailed;
}
export { DISCOVERY_PATH };
