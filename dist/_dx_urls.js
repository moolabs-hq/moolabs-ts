"use strict";
/**
 * URL derivation + F2 ingest fallback chain — TypeScript port of _dx_urls.py.
 *
 * Three responsibilities (same as the Python version):
 *
 *   1. `resolveEffectiveBaseUrl(baseUrl, apiKey)` — init-time rewrite of
 *      the customer-supplied baseUrl. Apex (moolabs.com) gets an env
 *      prefix injected from the key; explicit env roots and self-hosted
 *      bases pass through unchanged. Pure function, no state.
 *      **Called exactly once in the Moolabs constructor** — see _dx_client.ts.
 *
 *   2. `deriveHost(backend, baseUrl)` — convention-based subdomain rewriting.
 *      Pure function, no state.
 *
 *   3. `IngestUrlResolver` — stateful F2 fallback chain for the event-ingest
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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DISCOVERY_PATH = exports.IngestUrlResolver = exports.DEFAULT_INGEST_RESOLVER_CONFIG = exports.METER_INGEST_PATH = void 0;
exports.stripPath = stripPath;
exports.normalizeBaseUrl = normalizeBaseUrl;
exports.extractEnvPrefix = extractEnvPrefix;
exports.resolveEffectiveBaseUrl = resolveEffectiveBaseUrl;
exports.deriveHost = deriveHost;
exports.hostMatchesBaseUrl = hostMatchesBaseUrl;
const _dx_routing_1 = require("./_dx_routing");
exports.METER_INGEST_PATH = '/api/v1/events';
/** Strip path / query / fragment from a URL, returning only scheme + host.
 *
 *  The F2 IngestUrlResolver emits full URLs like
 *  `https://meter.moolabs.com/api/v1/events`, but axios's Configuration
 *  treats `basePath=` as a literal prefix and the generated method
 *  appends the operation path from the spec, producing
 *  `/api/v1/events/api/v1/events`. Collapsing to scheme + host before
 *  handing the value to Configuration is the single-source-of-truth fix.
 *
 *  A bare host like `https://meter.moolabs.com` is preserved verbatim.
 *  Sibling of Python's _strip_path and Go's stripPath. Cross-language
 *  parity is asserted by the US-013 envelope-parity test.
 */
function stripPath(hostOrUrl) {
    try {
        const u = new URL(hostOrUrl);
        return `${u.protocol}//${u.host}`;
    }
    catch (_a) {
        return hostOrUrl;
    }
}
const DISCOVERY_PATH = '/v1/tenant/config'; // exported below for client use
exports.DISCOVERY_PATH = DISCOVERY_PATH;
// ── URL helpers ──────────────────────────────────────────────────────────
/**
 * Strip scheme and trailing slash from a caller-provided baseUrl and
 * return the bare host. Accepts "moolabs.com" / "https://moolabs.com" /
 * "https://moolabs.com/" / "  moolabs.com  ".
 *
 * Empty or syntactically invalid input throws — caught at construction time.
 */
function normalizeBaseUrl(baseUrl) {
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
        throw new Error(`baseUrl must be a non-empty string, got ${JSON.stringify(baseUrl)}`);
    }
    const stripped = baseUrl.trim().replace(/\/+$/, '');
    if (stripped.length === 0) {
        throw new Error(`baseUrl is empty after stripping, got ${JSON.stringify(baseUrl)}`);
    }
    // Parse via URL — if no scheme, prepend https:// so URL() doesn't reject.
    const withScheme = stripped.includes('://') ? stripped : `https://${stripped}`;
    let host;
    try {
        host = new URL(withScheme).host;
    }
    catch (_a) {
        throw new Error(`baseUrl has no parseable host: ${JSON.stringify(baseUrl)}`);
    }
    if (!host) {
        throw new Error(`baseUrl has no parseable host: ${JSON.stringify(baseUrl)}`);
    }
    return host;
}
// ── Effective base_url resolution (init-time only) ──────────────────────
//
// Customer-facing apex domains where the SDK injects an env prefix derived
// from the API key. Bare apex like "moolabs.com" is a marketing/branding
// host, not an env root — the ALB cert is "*.prod.moolabs.com" (no SAN
// for "*.moolabs.com"), so the SDK must compose subdomains under an env
// root like "prod.moolabs.com".
//
// Add new entries here when Moolabs adds new customer-facing apex TLDs.
// Self-hosted customers passing their own root pass through unchanged.
const INJECT_ENV_APEXES = new Set(['moolabs.com']);
/** Env tokens the SDK recognizes in the API key. Future region-aware keys
 * have the form "{env}-{region}-{rand}", e.g. "prod-us-d0b7403...". */
const KNOWN_ENV_TOKENS = new Set(['prod', 'dev', 'staging']);
/** Fallback env root for legacy unprefixed keys with an apex baseUrl.
 * Today this is the only deployed env root with a valid wildcard cert. */
const LEGACY_KEY_FALLBACK_ENV = 'prod';
/**
 * Extract the "{env}-{region}" prefix from a region-aware API key.
 * Future key format: "{env}-{region}-{random}". Returns null for legacy
 * raw-hex keys (no prefix).
 */
function extractEnvPrefix(apiKey) {
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
        return null;
    }
    // Split into AT MOST 3 parts so the random tail can contain dashes.
    const dash1 = apiKey.indexOf('-');
    if (dash1 < 0)
        return null;
    const dash2 = apiKey.indexOf('-', dash1 + 1);
    if (dash2 < 0)
        return null;
    const env = apiKey.substring(0, dash1);
    const region = apiKey.substring(dash1 + 1, dash2);
    if (!KNOWN_ENV_TOKENS.has(env) || region.length === 0) {
        return null;
    }
    return `${env}-${region}`;
}
/**
 * Resolve the effective baseUrl used for SDK subdomain composition.
 * Called exactly ONCE in the Moolabs constructor — never per-call.
 *
 * Three rules:
 *
 *   1. baseUrl is NOT a known customer-facing apex (e.g. dev.moolabs.com,
 *      tenant.example.com): use as-is.
 *   2. baseUrl IS apex AND key has env-region prefix: inject the prefix
 *      → "prod-us.moolabs.com".
 *   3. baseUrl IS apex AND key is legacy: fall back to "prod.{apex}".
 */
function resolveEffectiveBaseUrl(baseUrl, apiKey) {
    var _a;
    const normalized = normalizeBaseUrl(baseUrl);
    if (!INJECT_ENV_APEXES.has(normalized)) {
        return normalized;
    }
    const envPrefix = (_a = extractEnvPrefix(apiKey)) !== null && _a !== void 0 ? _a : LEGACY_KEY_FALLBACK_ENV;
    return `${envPrefix}.${normalized}`;
}
/** Return `https://{subdomain}.{baseUrl}` for a backend. */
function deriveHost(backend, baseUrl) {
    const subdomain = _dx_routing_1.SUBDOMAIN_MAP[backend];
    if (!subdomain) {
        throw new Error(`unknown backend ${backend}; known: ${Object.keys(_dx_routing_1.SUBDOMAIN_MAP).sort().join(', ')}`);
    }
    return `https://${subdomain}.${normalizeBaseUrl(baseUrl)}`;
}
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
function hostMatchesBaseUrl(rawUrl, baseUrl) {
    let host;
    try {
        host = new URL(rawUrl).hostname.toLowerCase();
    }
    catch (_a) {
        return false;
    }
    const base = baseUrl.toLowerCase().replace(/^\.+/, '');
    if (host.length === 0 || base.length === 0)
        return false;
    return host === base || host.endsWith('.' + base);
}
exports.DEFAULT_INGEST_RESOLVER_CONFIG = {
    discoveryRetryTtlSec: 60.0,
    postFailureThreshold: 3,
    recentlyFailedTtlSec: 300.0,
};
const defaultClock = () => performance.now() / 1000;
class IngestUrlResolver {
    constructor(opts) {
        var _a, _b, _c, _d;
        this.cachedUrl = null;
        this.discoveryBlockedUntil = 0;
        this.recentlyFailed = new Map(); // URL → expiry timestamp
        this.postFailures = new Map(); // URL → consecutive count
        // Singleflight discovery (post-round-2 review I-NEW-1): when one
        // call is mid-discovery, concurrent callers `await` the SAME Promise
        // instead of each firing their own /tenant/config request. Cleared
        // in `finally` so a thrown/rejected discovery doesn't poison the slot.
        this.discoveryPromise = null;
        /** Env-pinned URL captured at construction from MOOLABS_INGEST_HOST.
         *  null when no env override was set. Sticky across reportPostOutcome
         *  cache invalidation. */
        this.envPinnedUrl = null;
        this.baseUrl = normalizeBaseUrl(opts.baseUrl);
        this.discoveryFn = (_a = opts.discoveryFn) !== null && _a !== void 0 ? _a : null;
        this.region = (_b = opts.region) !== null && _b !== void 0 ? _b : _dx_routing_1.DEFAULT_REGION;
        this.config = Object.assign(Object.assign({}, exports.DEFAULT_INGEST_RESOLVER_CONFIG), ((_c = opts.config) !== null && _c !== void 0 ? _c : {}));
        this.clock = (_d = opts.clock) !== null && _d !== void 0 ? _d : defaultClock;
        // MOOLABS_INGEST_HOST env var override — short-circuits the F2 chain.
        // Customers running on single-region self-hosted or non-standard
        // cloud deployments (e.g., a regional ingest subdomain that hasn't
        // been provisioned yet) can pin the ingest host explicitly. Set
        // this BEFORE the resolver runs through steps 2-4; the value
        // populates cachedUrl so step-1 returns it verbatim.
        //
        // Accepts either a bare host (`meter.dev.moolabs.com`,
        // `https://meter.dev.moolabs.com`) or a full URL — the path-
        // doubling guard in makeClientAtUrl normalizes either form.
        // Empty string is treated as unset. Sibling of Python's MOOLABS_
        // INGEST_HOST override.
        //
        // process.env access is wrapped in a typeof check so the SDK
        // runs in browser contexts (where `process` is undefined) without
        // crashing — the override silently no-ops there.
        let ingestHostEnv;
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (typeof process !== 'undefined' && process.env) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ingestHostEnv = process.env.MOOLABS_INGEST_HOST;
            }
        }
        catch (_e) {
            // Browser environments may throw on `process` access; treat as unset.
            ingestHostEnv = undefined;
        }
        if (ingestHostEnv) {
            const withScheme = ingestHostEnv.startsWith('http://') || ingestHostEnv.startsWith('https://')
                ? ingestHostEnv
                : `https://${ingestHostEnv}`;
            this.cachedUrl = withScheme;
            // Stickiness: env pin survives reportPostOutcome cache clearing
            // (Phase 2 review 2026-06-03 Finding 3). Without this, N
            // transient failures would silently fall back to step 4 and
            // substitute `meter.{baseUrl}` for the operator's explicit pin.
            this.envPinnedUrl = withScheme;
        }
    }
    /** Run the F2 chain and return a URL to POST events to. Async because
     *  step 2 may invoke the discovery HTTP callback. Always resolves;
     *  discovery failures fall through to step 4 (`meter.{baseUrl}`) rather
     *  than rejecting. */
    getIngestUrl() {
        return __awaiter(this, void 0, void 0, function* () {
            this.expireRecentlyFailed();
            // Step 1 — cache hit
            if (this.cachedUrl !== null) {
                return this.cachedUrl;
            }
            // Step 2 — discovery via Promise-cache singleflight: N concurrent
            // calls hit the same Promise; the BFF receives one /tenant/config
            // request, not N. Sibling fix to Python/Go's Condition-based
            // singleflight (round 1 I3); see round-2 review I-NEW-1.
            if (this.discoveryFn !== null && this.discoveryBlockedUntil <= this.clock()) {
                if (this.discoveryPromise === null) {
                    this.discoveryPromise = this.tryDiscovery()
                        .finally(() => { this.discoveryPromise = null; });
                }
                const discovered = yield this.discoveryPromise;
                if (discovered !== null) {
                    this.cachedUrl = discovered;
                    return discovered;
                }
            }
            // Step 4 — meter host (no discovery this call).
            return this.regionFallbackUrl();
        });
    }
    /** Update state based on the outcome of POSTing to `url`.
     *
     *  On success: reset the per-URL failure counter.
     *  On failure: increment; at threshold AND if `url` is the cached one,
     *  invalidate the cache + record URL as recently failed. */
    reportPostOutcome(url, success) {
        var _a;
        if (success) {
            this.postFailures.delete(url);
            return;
        }
        const count = ((_a = this.postFailures.get(url)) !== null && _a !== void 0 ? _a : 0) + 1;
        this.postFailures.set(url, count);
        if (count >= this.config.postFailureThreshold) {
            if (this.cachedUrl === url) {
                // Env-pinned URL is sticky (Phase 2 review Finding 3): if
                // the operator explicitly set MOOLABS_INGEST_HOST, don't
                // fall through to step 4 (which would silently substitute
                // `meter.{baseUrl}` for the operator's pin). Keep the cache
                // populated with the pin.
                if (this.envPinnedUrl !== null && url === this.envPinnedUrl) {
                    // Keep cachedUrl === envPinnedUrl.
                }
                else {
                    this.cachedUrl = null;
                }
            }
            this.recentlyFailed.set(url, this.clock() + this.config.recentlyFailedTtlSec);
            this.postFailures.delete(url);
            // Bound the maps (post-PR #395 review M2). Defends against
            // buggy BFF returning many distinct dead URLs faster than
            // the TTL expires them.
            this.capMap(this.recentlyFailed, 64, (a, b) => a - b); // evict earliest-expiry
            this.capMap(this.postFailures, 64, (a, b) => b - a); // evict highest-count
        }
    }
    /** Evict entries from `m` until size <= maxEntries. The comparator runs
     *  on the values; entries that compare LESS are evicted first. */
    capMap(m, maxEntries, cmp) {
        if (m.size <= maxEntries)
            return;
        const entries = Array.from(m.entries());
        entries.sort((x, y) => cmp(x[1], y[1]));
        const dropCount = m.size - maxEntries;
        for (let i = 0; i < dropCount; i++) {
            m.delete(entries[i][0]);
        }
    }
    /** F2 step 4 — always-derivable last resort. Public so tests can assert. */
    step4LastResortUrl() {
        return `${deriveHost('meter', this.baseUrl)}${exports.METER_INGEST_PATH}`;
    }
    getStateSnapshot() {
        const now = this.clock();
        return {
            cachedUrl: this.cachedUrl,
            discoveryBlockedForSec: Math.max(0, this.discoveryBlockedUntil - now),
            recentlyFailedCount: this.recentlyFailed.size,
            postFailuresTracked: this.postFailures.size,
        };
    }
    get cached() {
        return this.cachedUrl;
    }
    // ── internals ──
    tryDiscovery() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.discoveryFn === null)
                return null;
            let response;
            try {
                response = yield this.discoveryFn();
            }
            catch (_a) {
                this.discoveryBlockedUntil = this.clock() + this.config.discoveryRetryTtlSec;
                return null;
            }
            if (typeof response !== 'object' || response === null) {
                this.discoveryBlockedUntil = this.clock() + this.config.discoveryRetryTtlSec;
                return null;
            }
            const endpoints = response.endpoints;
            const ingestHost = endpoints === null || endpoints === void 0 ? void 0 : endpoints.ingest;
            if (typeof ingestHost !== 'string' || ingestHost.length === 0) {
                this.discoveryBlockedUntil = this.clock() + this.config.discoveryRetryTtlSec;
                return null;
            }
            // Normalize: BFF returns host-only ingest URL; append the path so all
            // chain steps return directly-POSTable URLs.
            const stripped = ingestHost.replace(/\/+$/, '');
            let fullUrl;
            if (stripped.includes('://') && !stripped.split('://')[1].includes('/')) {
                fullUrl = stripped + exports.METER_INGEST_PATH;
            }
            else {
                fullUrl = stripped;
            }
            // Defense-in-depth: discovered URL must be under the customer's
            // configured base_url. A compromised BFF could otherwise redirect
            // the SDK to POST customer events + the customer's API key to an
            // attacker-controlled host. Bounds the BFF compromise blast
            // radius to BFF's own domain.
            if (!hostMatchesBaseUrl(fullUrl, this.baseUrl)) {
                this.discoveryBlockedUntil = this.clock() + this.config.discoveryRetryTtlSec;
                return null;
            }
            if (this.recentlyFailed.has(fullUrl)) {
                return null;
            }
            return fullUrl;
        });
    }
    /**
     * Return `meter.{baseUrl}/api/v1/events` — the single source of truth
     * for ingest when discovery (step 2) is unavailable or has failed.
     *
     * Earlier versions of this method tried to construct regional ingest
     * hosts (`https://ingest.{regionCode}.{baseUrl}/api/v1/events`) from
     * the SDK's local region map. Two problems with that:
     *
     * 1. Wrong URL for non-apex baseUrls. For `dev.moolabs.com` or any
     *    customer-chosen env root, there is no `ingest.{region}.{root}`
     *    subdomain — DNS doesn't resolve, the POST fails. The first N
     *    events per process lifetime would be silently lost before the
     *    recentlyFailed mark caused the SDK to fall through.
     *
     * 2. Local region construction is a guess. The right place to learn
     *    the customer's regional ingest URL is BFF discovery (step 2 via
     *    `/v1/tenant/config`). When discovery is enabled and reachable,
     *    it returns the authoritative URL; the SDK should NEVER guess
     *    from a local region map. When discovery is unavailable,
     *    `meter.{baseUrl}` is the always-derivable steady-state route
     *    for env-rooted and self-hosted bases per contracts §3.5a.
     *
     * Result: every call routes to `meter.{baseUrl}/api/v1/events` from
     * #1 onward — no lossy preamble, no regional URL guessing.
     * Multi-region routing still works via discovery (step 2) when the
     * customer opts in via `enableIngestDiscovery: true`.
     */
    regionFallbackUrl() {
        return this.step4LastResortUrl();
    }
    expireRecentlyFailed() {
        const now = this.clock();
        for (const [url, until] of this.recentlyFailed.entries()) {
            if (until <= now) {
                this.recentlyFailed.delete(url);
            }
        }
    }
}
exports.IngestUrlResolver = IngestUrlResolver;
