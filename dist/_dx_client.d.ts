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
import { type Namespace } from './_dx_namespaces';
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
/** PascalCase → kebab-case file name (TS generator emits kebab-case files:
 *  "WalletsApi" → "wallets-api.ts"). Exported for the cross-language parity job. */
export declare function pascalToKebab(name: string): string;
export declare class Moolabs {
    private readonly apiKey;
    private readonly baseUrl;
    private readonly bufferEnabled;
    private readonly bufferMax;
    private readonly logger;
    private readonly ingestResolver;
    private ingestBuffer;
    private readonly inflightDrains;
    private readonly clients;
    private readonly namespaces;
    constructor(opts: MoolabsOptions);
    get usage(): Namespace;
    get customers(): Namespace;
    get catalog(): Namespace;
    get subscriptions(): Namespace;
    get entitlements(): Namespace;
    get wallets(): Namespace;
    get credits(): Namespace;
    get billing(): Namespace;
    get collections(): Namespace;
    get cost(): Namespace;
    get notifications(): Namespace;
    close(): Promise<void>;
    toString(): string;
    private ns;
    private getClient;
    private makeClientAtUrl;
    private lazyBuffer;
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
    private bufferDrainCallback;
    private discoverTenantConfig;
}
