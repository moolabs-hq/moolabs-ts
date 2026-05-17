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

import { IngestBuffer, type IngestBufferConfig } from './_dx_buffer';
import { type Namespace, makeNamespace, isTerminalIngestError } from './_dx_namespaces';
import { postEventsBatchAndClassify } from './_dx_post';
import { CAPABILITY_ORDER, type Backend, SUBDOMAIN_MAP } from './_dx_routing';
import {
    DISCOVERY_PATH,
    IngestUrlResolver,
    METER_INGEST_PATH,
    deriveHost,
} from './_dx_urls';

// Lazy import marker — the generated layer's Configuration / ApiClient
// modules are loaded only when a capability is actually used. Until then
// `new Moolabs({...})` does no I/O and no module loading.
type GeneratedConfiguration = new (params: { basePath?: string; accessToken?: string }) => unknown;


const DEFAULT_BASE_URL = 'moolabs.com';

// CloudEvents batch ingest path is METER_INGEST_PATH (imported from
// _dx_urls.ts so both the resolver and the direct-post path agree on
// the route). The matching Content-Type
// (application/cloudevents-batch+json) lives in _dx_post.ts where the
// actual fetch happens — keeping the header next to the request body
// it describes.
const INGEST_PATH = METER_INGEST_PATH;


/** Optional per-event diagnostic callback. SDK invokes this on
 *  terminal_drop, overflow, abandoned-on-shutdown, drain-failure events
 *  with a stable msg id + a structured fields object.
 *  Default: undefined (no output). Library never writes to console
 *  unless the customer explicitly provides one. */
export type LoggerFn = (msg: string, fields: Record<string, unknown>) => void;

export interface MoolabsOptions {
    readonly apiKey: string;
    /** Root domain (host only). Default "moolabs.com". */
    readonly baseUrl?: string;
    /** When true (default), F2-chain-exhaustion enqueues events to an
     *  in-memory buffer instead of throwing. */
    readonly buffer?: boolean;
    /** Max events the in-memory buffer holds before drop-oldest. */
    readonly bufferMax?: number;
    /** Optional per-event diagnostic logger. Undefined = no output.
     *  Wire it to your structured logger (pino, winston, console.warn). */
    readonly logger?: LoggerFn;
}

const noopLogger: LoggerFn = () => { /* no-op default */ };


/** PascalCase → kebab-case file name (TS generator emits kebab-case files:
 *  "WalletsApi" → "wallets-api.ts"). Exported for the cross-language parity job. */
export function pascalToKebab(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}


/** Lazy import of a generated API class. The typescript-axios generator
 *  emits classes under `./api/<kebab>-api.ts`. */
function importApiClass(className: string): new (config?: unknown) => Record<string, unknown> {
    const moduleName = `./api/${pascalToKebab(className)}`;
    // require() rather than dynamic import() because the typescript-axios
    // output is CommonJS by default in this project. The install_check
    // verifies the import path works at smoke time.
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
        const mod = require(moduleName);
        const cls = (mod as Record<string, unknown>)[className];
        if (typeof cls !== 'function') {
            throw new Error(`module ${moduleName} exports no class ${className}`);
        }
        return cls as new (config?: unknown) => Record<string, unknown>;
    } catch (e) {
        const cause = e instanceof Error ? e.message : String(e);
        throw new Error(
            `could not import ${moduleName} (backing class ${className} for the SDK's ` +
            `capability routing map). Re-run codegen or check _dx_routing.CAPABILITY_MAP. ` +
            `Original: ${cause}`
        );
    }
}


export class Moolabs {
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly bufferEnabled: boolean;
    private readonly bufferMax: number;
    private readonly logger: LoggerFn;

    private readonly ingestResolver: IngestUrlResolver;
    private ingestBuffer: IngestBuffer<unknown> | null = null;

    // Round-4 I-NEW-4: track in-flight fetch Promises from the no-await
    // bufferDrainCallback so close() can await them. Without this,
    // close() returns while the final batch's HTTP is still on the wire;
    // in serverless/Lambda contexts the runtime can freeze the container
    // and kill the request mid-flight.
    private readonly inflightDrains = new Set<Promise<void>>();

    private readonly clients = new Map<Backend, unknown>();
    private readonly namespaces = new Map<string, Namespace>();

    constructor(opts: MoolabsOptions) {
        if (typeof opts.apiKey !== 'string' || opts.apiKey.length === 0) {
            throw new Error('apiKey must be a non-empty string');
        }
        this.apiKey = opts.apiKey;
        this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;

        // Validate baseUrl early so a typo crashes at construction.
        for (const backend of Object.keys(SUBDOMAIN_MAP) as Backend[]) {
            deriveHost(backend, this.baseUrl);   // throws on invalid baseUrl
        }

        this.bufferEnabled = opts.buffer !== false;   // default true
        this.bufferMax = opts.bufferMax ?? 1000;   // matches DEFAULT_INGEST_BUFFER_CONFIG.maxSize
        // Optional per-event logger; default = no output.
        this.logger = opts.logger ?? noopLogger;

        this.ingestResolver = new IngestUrlResolver({
            baseUrl: this.baseUrl,
            discoveryFn: () => this.discoverTenantConfig(),
        });
    }

    // ── Capability getters (lazy namespace construction) ────────────────

    get usage(): Namespace        { return this.ns('usage'); }
    get customers(): Namespace    { return this.ns('customers'); }
    get catalog(): Namespace      { return this.ns('catalog'); }
    get subscriptions(): Namespace { return this.ns('subscriptions'); }
    get entitlements(): Namespace { return this.ns('entitlements'); }
    get wallets(): Namespace      { return this.ns('wallets'); }
    get credits(): Namespace      { return this.ns('credits'); }
    get billing(): Namespace      { return this.ns('billing'); }
    get collections(): Namespace  { return this.ns('collections'); }
    get cost(): Namespace         { return this.ns('cost'); }
    get notifications(): Namespace { return this.ns('notifications'); }

    // ── Lifecycle ────────────────────────────────────────────────────────

    async close(): Promise<void> {
        if (this.ingestBuffer !== null) {
            await this.ingestBuffer.close();
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
            const settled = Promise.all(
                [...this.inflightDrains].map((p) =>
                    p.catch((): void => undefined),
                ),
            );
            await Promise.race([
                settled.then((): void => undefined),
                new Promise<void>((resolve) => setTimeout(resolve, 60_000)),
            ]);
        }
        // typescript-axios's generated ApiClient doesn't have a close(); the
        // underlying axios instance is GC'd when references drop. Just clear
        // our caches.
        this.clients.clear();
        this.namespaces.clear();
    }

    toString(): string {
        return `Moolabs(baseUrl=${JSON.stringify(this.baseUrl)}, buffer=${this.bufferEnabled}, capabilities=${CAPABILITY_ORDER.length})`;
    }

    // ── Internals ────────────────────────────────────────────────────────

    private ns(capability: string): Namespace {
        const cached = this.namespaces.get(capability);
        if (cached !== undefined) return cached;
        const opts: Parameters<typeof makeNamespace>[1] = {
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

    private getClient(backend: Backend): unknown {
        const cached = this.clients.get(backend);
        if (cached !== undefined) return cached;
        const host = deriveHost(backend, this.baseUrl);
        const client = this.makeClientAtUrl(host);
        this.clients.set(backend, client);
        return client;
    }

    private makeClientAtUrl(host: string): unknown {
        // typescript-axios's Configuration accepts `basePath` and `accessToken`.
        // Lazy-load via require so `import { Moolabs }` is fast.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('./configuration') as { Configuration: GeneratedConfiguration };
        return new mod.Configuration({ basePath: host, accessToken: this.apiKey });
    }

    private lazyBuffer(): IngestBuffer<unknown> | null {
        if (!this.bufferEnabled) return null;
        if (this.ingestBuffer === null) {
            const cfg: Partial<IngestBufferConfig> = { maxSize: this.bufferMax };
            this.ingestBuffer = new IngestBuffer<unknown>({
                drainCallback: (events) => this.bufferDrainCallback(events),
                config: cfg,
                logger: this.logger,    // propagate customer-supplied logger (noop default)
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
    private async bufferDrainCallback(events: unknown[]): Promise<number> {
        // Resolve URL synchronously from cache if available. If the
        // resolver needs to do discovery, we fall through to step 4
        // (always-derivable last-resort URL) rather than awaiting.
        const url = this.ingestResolver.cached
            ?? `https://meter.${this.baseUrl}${INGEST_PATH}`;

        // Fire-and-forget. No await — Promise tracked in inflightDrains
        // so close() can await pending requests before returning
        // (round-4 I-NEW-4). The HTTP + classification path is extracted
        // into postEventsBatchAndClassify (round-5 — closes I-NEW-1) so
        // that surface is testable in isolation; the side-effect
        // dispatch below stays here because it touches client state.
        const inflight: Promise<void> = postEventsBatchAndClassify(
            url,
            this.apiKey,
            events,
        ).then((outcome) => {
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
    }

    private async discoverTenantConfig(): Promise<{ endpoints?: { ingest?: string } }> {
        const host = deriveHost('bff', this.baseUrl);
        const url = `${host}${DISCOVERY_PATH}`;
        // Use the platform's fetch (Node 18+ has it natively; older Node + bun
        // also expose it). Customers on Node <18 should polyfill at app level.
        const resp = await fetch(url, {
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                Accept: 'application/json',
            },
        });
        if (!resp.ok) {
            throw new Error(`/tenant/config returned ${resp.status}`);
        }
        return resp.json() as Promise<{ endpoints?: { ingest?: string } }>;
    }
}
