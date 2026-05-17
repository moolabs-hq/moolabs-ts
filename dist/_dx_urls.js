"use strict";
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
exports.normalizeBaseUrl = normalizeBaseUrl;
exports.deriveHost = deriveHost;
exports.hostMatchesBaseUrl = hostMatchesBaseUrl;
const _dx_routing_1 = require("./_dx_routing");
exports.METER_INGEST_PATH = '/api/v1/events';
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
        this.baseUrl = normalizeBaseUrl(opts.baseUrl);
        this.discoveryFn = (_a = opts.discoveryFn) !== null && _a !== void 0 ? _a : null;
        this.region = (_b = opts.region) !== null && _b !== void 0 ? _b : _dx_routing_1.DEFAULT_REGION;
        this.config = Object.assign(Object.assign({}, exports.DEFAULT_INGEST_RESOLVER_CONFIG), ((_c = opts.config) !== null && _c !== void 0 ? _c : {}));
        this.clock = (_d = opts.clock) !== null && _d !== void 0 ? _d : defaultClock;
    }
    /** Run the F2 chain and return a URL to POST events to. Async because
     *  step 2 may invoke the discovery HTTP callback. Always resolves;
     *  discovery failures fall through to step 3/4 rather than rejecting. */
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
            // Step 3 — region map fallback
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
                this.cachedUrl = null;
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
    regionFallbackUrl() {
        const regionCode = _dx_routing_1.REGION_INGEST_MAP[this.region];
        if (regionCode === undefined) {
            return this.step4LastResortUrl();
        }
        const candidate = `https://ingest.${regionCode}.${this.baseUrl}${exports.METER_INGEST_PATH}`;
        if (this.recentlyFailed.has(candidate)) {
            return this.step4LastResortUrl();
        }
        return candidate;
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
