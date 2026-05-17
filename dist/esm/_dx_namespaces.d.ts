/**
 * Capability namespace classes — TypeScript port of _dx_namespaces.py.
 *
 * Two namespace types:
 *   - Namespace — generic; builds a {methodName → bound function} index
 *     from all backing classes for the capability.
 *   - UsageNamespace — subclass that special-cases `ingestEvents` to route
 *     through the F2 fallback chain + G5 buffer.
 *
 * Import-cycle-safe: does NOT import generated API modules. The caller
 * (_dx_client.ts) injects an `importApiClass` factory.
 */
import { IngestBuffer } from './_dx_buffer';
import { type Backend } from './_dx_routing';
import { IngestUrlResolver } from './_dx_urls';
/** True if `err` represents a non-retryable HTTP failure.
 *  Inspects axios-style errors (`err.response.status`) and openapi-generator
 *  errors. Network errors and other unknown error shapes are treated as
 *  transient (retryable / bufferable). Exported so the buffer drain
 *  callback in _dx_client.ts can use the same classification. */
export declare function isTerminalIngestError(err: unknown): boolean;
/** Resolves an API class name (e.g. "WalletsApi") to the actual class.
 *  Real impl: dynamic import + lookup. Test impl: registry. */
export type ImportApiClass = (className: string) => new (config?: unknown) => Record<string, unknown>;
/** Backend → Configuration / ApiClient lookup. */
export type GetClient = (backend: Backend) => unknown;
export declare class Namespace {
    private readonly methodIndex;
    readonly capability: string;
    constructor(capability: string, getClient: GetClient, importApiClass: ImportApiClass);
    methods(): string[];
    toString(): string;
}
/** Special-cased usage namespace — overrides ingestEvents only. */
export declare class UsageNamespace extends Namespace {
    private readonly ingestResolver;
    private readonly ingestBuffer;
    private readonly makeClientAtUrl;
    private readonly EventsApiClass;
    constructor(opts: {
        getClient: GetClient;
        importApiClass: ImportApiClass;
        ingestResolver: IngestUrlResolver;
        ingestBuffer: IngestBuffer<unknown> | null;
        makeClientAtUrl: (url: string) => unknown;
    });
    /** F2+G5 ingest.
     *
     *  Default mode (buffer enabled): non-blocking — enqueues and
     *  returns immediately. The customer's awaited Promise resolves
     *  in microseconds regardless of network conditions. Auth/network
     *  failures surface via getStats().terminalDrops and the customer-
     *  supplied logger, NOT thrown at the call site.
     *
     *  Strict-sync mode (buffer=false at construction): blocks on HTTP.
     *  Throws on terminal errors (401/403/etc) and on transient
     *  failures. Use when caller specifically needs delivery
     *  confirmation per call.
     *
     *  Pre-PR #395 round-4 design: buffer was failure-only; new design:
     *  buffer is the primary path; caller never blocks unless opted out. */
    private ingestEventsImpl;
}
export declare function makeNamespace(capability: string, opts: {
    getClient: GetClient;
    importApiClass: ImportApiClass;
    ingestResolver?: IngestUrlResolver;
    ingestBuffer?: IngestBuffer<unknown> | null;
    makeClientAtUrl?: (url: string) => unknown;
}): Namespace;
