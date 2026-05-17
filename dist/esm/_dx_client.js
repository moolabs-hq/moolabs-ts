/**
 * Unified Moolabs SDK facade — capability-based public surface (TypeScript).
 *
 * TypeScript counterpart of sdks/dx/python/moolabs/_dx_client.py. Cross-
 * language parity (Task H) asserts identical capability list + constructor
 * signature shape across py/ts/go.
 *
 * Usage:
 *
 *   import { Moolabs } from '@moolabs/sdk';
 *
 *   const client = new Moolabs({ apiKey: 'moo_live_xxx' });
 *   await client.usage.listEvents();
 *   await client.usage.ingestEvents([...]);   // F2 fallback + G5 buffer
 *   await client.close();
 *
 * Constructor changes from rev-1 (pre-2026-05-15 surface):
 *   - clsBaseUrl / meterBaseUrl REMOVED — convention-based subdomain derivation
 *   - baseUrl is the ROOT DOMAIN (default "moolabs.com")
 *   - buffer flag controls G5 in-memory queue (default true)
 *   - bufferMax sets the bounded queue size (default 1000)
 *
 * 11 capability getters replace the 2 service namespaces (cls / meter).
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
import { IngestBuffer } from './_dx_buffer';
import { makeNamespace } from './_dx_namespaces';
import { postEventsBatchAndClassify } from './_dx_post';
import { CAPABILITY_ORDER, SUBDOMAIN_MAP } from './_dx_routing';
import { DISCOVERY_PATH, IngestUrlResolver, METER_INGEST_PATH, deriveHost, } from './_dx_urls';
const DEFAULT_BASE_URL = 'moolabs.com';
// CloudEvents batch ingest path is METER_INGEST_PATH (imported from
// _dx_urls.ts so both the resolver and the direct-post path agree on
// the route). The matching Content-Type
// (application/cloudevents-batch+json) lives in _dx_post.ts where the
// actual fetch happens — keeping the header next to the request body
// it describes.
const INGEST_PATH = METER_INGEST_PATH;
const noopLogger = () => { };
/** PascalCase → kebab-case file name (TS generator emits kebab-case files:
 *  "WalletsApi" → "wallets-api.ts"). Exported for the cross-language parity job. */
export function pascalToKebab(name) {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
/** Lazy import of a generated API class. The typescript-axios generator
 *  emits classes under `./api/<kebab>-api.ts`. */
function importApiClass(className) {
    const moduleName = `./api/${pascalToKebab(className)}`;
    // require() rather than dynamic import() because the typescript-axios
    // output is CommonJS by default in this project. The install_check
    // verifies the import path works at smoke time.
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
        const mod = require(moduleName);
        const cls = mod[className];
        if (typeof cls !== 'function') {
            throw new Error(`module ${moduleName} exports no class ${className}`);
        }
        return cls;
    }
    catch (e) {
        const cause = e instanceof Error ? e.message : String(e);
        throw new Error(`could not import ${moduleName} (backing class ${className} for the SDK's ` +
            `capability routing map). Re-run codegen or check _dx_routing.CAPABILITY_MAP. ` +
            `Original: ${cause}`);
    }
}
export class Moolabs {
    constructor(opts) {
        var _a, _b, _c;
        this.ingestBuffer = null;
        // Round-4 I-NEW-4: track in-flight fetch Promises from the no-await
        // bufferDrainCallback so close() can await them. Without this,
        // close() returns while the final batch's HTTP is still on the wire;
        // in serverless/Lambda contexts the runtime can freeze the container
        // and kill the request mid-flight.
        this.inflightDrains = new Set();
        this.clients = new Map();
        this.namespaces = new Map();
        if (typeof opts.apiKey !== 'string' || opts.apiKey.length === 0) {
            throw new Error('apiKey must be a non-empty string');
        }
        this.apiKey = opts.apiKey;
        this.baseUrl = (_a = opts.baseUrl) !== null && _a !== void 0 ? _a : DEFAULT_BASE_URL;
        // Validate baseUrl early so a typo crashes at construction.
        for (const backend of Object.keys(SUBDOMAIN_MAP)) {
            deriveHost(backend, this.baseUrl); // throws on invalid baseUrl
        }
        this.bufferEnabled = opts.buffer !== false; // default true
        this.bufferMax = (_b = opts.bufferMax) !== null && _b !== void 0 ? _b : 1000; // matches DEFAULT_INGEST_BUFFER_CONFIG.maxSize
        // Optional per-event logger; default = no output.
        this.logger = (_c = opts.logger) !== null && _c !== void 0 ? _c : noopLogger;
        this.ingestResolver = new IngestUrlResolver({
            baseUrl: this.baseUrl,
            discoveryFn: () => this.discoverTenantConfig(),
        });
    }
    // ── Capability getters (lazy namespace construction) ────────────────
    get usage() { return this.ns('usage'); }
    get customers() { return this.ns('customers'); }
    get catalog() { return this.ns('catalog'); }
    get subscriptions() { return this.ns('subscriptions'); }
    get entitlements() { return this.ns('entitlements'); }
    get wallets() { return this.ns('wallets'); }
    get credits() { return this.ns('credits'); }
    get billing() { return this.ns('billing'); }
    get collections() { return this.ns('collections'); }
    get cost() { return this.ns('cost'); }
    get notifications() { return this.ns('notifications'); }
    // ── Lifecycle ────────────────────────────────────────────────────────
    close() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.ingestBuffer !== null) {
                yield this.ingestBuffer.close();
                this.ingestBuffer = null;
            }
            // Round-4 I-NEW-4: bufferDrainCallback fires no-await fetch
            // Promises tracked in inflightDrains. close() must wait for
            // them so that "after close() returns, no more HTTP" holds.
            // Bounded by the buffer's shutdown timeout — if a fetch is
            // still in flight after 60s, we give up (in-flight request
            // continues in the background but close() returns).
            if (this.inflightDrains.size > 0) {
                // Generated SDK's tsconfig targets pre-ES2020; can't use
                // Promise.allSettled directly. Manually convert each rejection
                // to a fulfilled void so Promise.all doesn't short-circuit.
                const settled = Promise.all([...this.inflightDrains].map((p) => p.catch(() => undefined)));
                yield Promise.race([
                    settled.then(() => undefined),
                    new Promise((resolve) => setTimeout(resolve, 60000)),
                ]);
            }
            // typescript-axios's generated ApiClient doesn't have a close(); the
            // underlying axios instance is GC'd when references drop. Just clear
            // our caches.
            this.clients.clear();
            this.namespaces.clear();
        });
    }
    toString() {
        return `Moolabs(baseUrl=${JSON.stringify(this.baseUrl)}, buffer=${this.bufferEnabled}, capabilities=${CAPABILITY_ORDER.length})`;
    }
    // ── Internals ────────────────────────────────────────────────────────
    ns(capability) {
        const cached = this.namespaces.get(capability);
        if (cached !== undefined)
            return cached;
        const opts = {
            getClient: (b) => this.getClient(b),
            importApiClass,
        };
        if (capability === 'usage') {
            opts.ingestResolver = this.ingestResolver;
            opts.ingestBuffer = this.lazyBuffer();
            opts.makeClientAtUrl = (url) => this.makeClientAtUrl(url);
        }
        const n = makeNamespace(capability, opts);
        this.namespaces.set(capability, n);
        return n;
    }
    getClient(backend) {
        const cached = this.clients.get(backend);
        if (cached !== undefined)
            return cached;
        const host = deriveHost(backend, this.baseUrl);
        const client = this.makeClientAtUrl(host);
        this.clients.set(backend, client);
        return client;
    }
    makeClientAtUrl(host) {
        // typescript-axios's Configuration accepts `basePath` and `accessToken`.
        // Lazy-load via require so `import { Moolabs }` is fast.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('./configuration');
        return new mod.Configuration({ basePath: host, accessToken: this.apiKey });
    }
    lazyBuffer() {
        if (!this.bufferEnabled)
            return null;
        if (this.ingestBuffer === null) {
            const cfg = { maxSize: this.bufferMax };
            this.ingestBuffer = new IngestBuffer({
                drainCallback: (events) => this.bufferDrainCallback(events),
                config: cfg,
                logger: this.logger, // propagate customer-supplied logger (noop default)
            });
            this.ingestBuffer.start();
        }
        return this.ingestBuffer;
    }
    /** Drain callback — fire-and-forget POST.
     *
     *  Customer chose at-most-once delivery semantics (round-5 review):
     *  drain returns delivered=events.length immediately, buffer removes
     *  the events, fetch+keepalive runs in the background. Failed requests
     *  are silently lost (logged via customer Logger if provided + counted
     *  via terminalDrops/dropped stats; events themselves are gone).
     *
     *  Why fetch+keepalive instead of awaited axios:
     *  - keepalive: true tells the browser to complete the request even
     *    if the page unloads. Last events sent before navigation aren't
     *    lost mid-flight. Node ignores the flag (no impact).
     *  - No await: drain tick doesn't wait for HTTP. Even if the backend
     *    is slow, drain ticks at the configured interval.
     *  - The Promise is intentionally unobserved; errors are surfaced
     *    via .catch() into stats + Logger.
     *
     *  Why bypass the openapi-generator's typed EventsApi: same reason as
     *  Go's postEventsBatch — typed client uses axios with await semantics;
     *  we want raw fetch with keepalive control. */
    // Returns a Promise to satisfy the DrainCallback contract; the
    // Promise resolves synchronously with events.length because the
    // actual HTTP is fire-and-forget (no await). The buffer treats
    // the events as "delivered" immediately (removed from queue).
    bufferDrainCallback(events) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            // Resolve URL synchronously from cache if available. If the
            // resolver needs to do discovery, we fall through to step 4
            // (always-derivable last-resort URL) rather than awaiting.
            const url = (_a = this.ingestResolver.cached) !== null && _a !== void 0 ? _a : `https://meter.${this.baseUrl}${INGEST_PATH}`;
            // Fire-and-forget. No await — Promise tracked in inflightDrains
            // so close() can await pending requests before returning
            // (round-4 I-NEW-4). The HTTP + classification path is extracted
            // into postEventsBatchAndClassify (round-5 — closes I-NEW-1) so
            // that surface is testable in isolation; the side-effect
            // dispatch below stays here because it touches client state.
            const inflight = postEventsBatchAndClassify(url, this.apiKey, events).then((outcome) => {
                switch (outcome.type) {
                    case 'success':
                        this.ingestResolver.reportPostOutcome(url, true);
                        return;
                    case 'terminal':
                        // Events already removed; counter + log.
                        if (this.ingestBuffer !== null) {
                            this.ingestBuffer.recordTerminalDrop(events.length);
                        }
                        this.logger('moolabs.ingest_buffer.terminal_drop', {
                            status: outcome.status,
                            count: events.length,
                        });
                        return;
                    case 'transient':
                        // Penalize URL, log. Events are GONE (at-most-once);
                        // customer who needs at-least-once should set
                        // buffer=false for synchronous mode.
                        this.ingestResolver.reportPostOutcome(url, false);
                        this.logger('moolabs.ingest_buffer.transient_drop', {
                            status: outcome.status,
                            count: events.length,
                        });
                        return;
                    case 'network':
                        // Network error / abort / DNS failure. Penalize URL, log.
                        this.ingestResolver.reportPostOutcome(url, false);
                        this.logger('moolabs.ingest_buffer.network_drop', {
                            count: events.length,
                            err: String(outcome.err),
                        });
                        return;
                }
            });
            // Track for close() awaiting. Self-cleanup via finally.
            this.inflightDrains.add(inflight);
            void inflight.finally(() => { this.inflightDrains.delete(inflight); });
            // Optimistically tell the buffer the events are "delivered" —
            // they're removed from the buffer's queue. The fire-and-forget
            // Promise above handles the actual HTTP outcome separately.
            return events.length;
        });
    }
    discoverTenantConfig() {
        return __awaiter(this, void 0, void 0, function* () {
            const host = deriveHost('bff', this.baseUrl);
            const url = `${host}${DISCOVERY_PATH}`;
            // Use the platform's fetch (Node 18+ has it natively; older Node + bun
            // also expose it). Customers on Node <18 should polyfill at app level.
            const resp = yield fetch(url, {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    Accept: 'application/json',
                },
            });
            if (!resp.ok) {
                throw new Error(`/tenant/config returned ${resp.status}`);
            }
            return resp.json();
        });
    }
}
