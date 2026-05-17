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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { CAPABILITY_MAP } from './_dx_routing';
/** HTTP status codes that mean "this request will NEVER succeed on retry."
 *  Auth (401/403), validation (400/422), removed-route (404).
 *  Retrying with the same key/body/URL fails identically; buffering hides
 *  the error from the caller and silently loses events. */
const TERMINAL_STATUSES = new Set([400, 401, 403, 404, 422]);
/** True if `err` represents a non-retryable HTTP failure.
 *  Inspects axios-style errors (`err.response.status`) and openapi-generator
 *  errors. Network errors and other unknown error shapes are treated as
 *  transient (retryable / bufferable). Exported so the buffer drain
 *  callback in _dx_client.ts can use the same classification. */
export function isTerminalIngestError(err) {
    if (err === null || typeof err !== 'object')
        return false;
    const response = err.response;
    if (response && typeof response.status === 'number'
        && TERMINAL_STATUSES.has(response.status)) {
        return true;
    }
    const status = err.status;
    if (typeof status === 'number' && TERMINAL_STATUSES.has(status)) {
        return true;
    }
    return false;
}
export class Namespace {
    constructor(capability, getClient, importApiClass) {
        this.methodIndex = new Map();
        if (!(capability in CAPABILITY_MAP)) {
            throw new Error(`unknown capability ${capability}; valid: ${Object.keys(CAPABILITY_MAP).sort().join(', ')}`);
        }
        this.capability = capability;
        for (const bc of CAPABILITY_MAP[capability]) {
            const ApiClass = importApiClass(bc.apiClass);
            const client = getClient(bc.backend);
            const instance = new ApiClass(client);
            // Walk own + prototype methods (openapi-generator typescript-axios
            // emits methods on the prototype, not the instance).
            const proto = Object.getPrototypeOf(instance);
            const names = new Set([
                ...Object.getOwnPropertyNames(instance),
                ...Object.getOwnPropertyNames(proto),
            ]);
            for (const name of names) {
                if (name.startsWith('_') || name === 'constructor')
                    continue;
                const value = instance[name];
                if (typeof value !== 'function')
                    continue;
                if (this.methodIndex.has(name))
                    continue; // first-class-wins
                // Bind to instance so `this` works when the customer destructures
                this.methodIndex.set(name, value.bind(instance));
            }
        }
        return new Proxy(this, {
            get: (target, prop) => {
                if (typeof prop === 'symbol' || prop.startsWith('_')) {
                    return Reflect.get(target, prop);
                }
                // Class-defined attrs (capability, methodIndex, etc.) hit first
                if (prop in target)
                    return Reflect.get(target, prop);
                const fn = target.methodIndex.get(prop);
                if (fn !== undefined)
                    return fn;
                throw new Error(`capability ${target.capability} has no method ${prop}; ` +
                    `available include: ${[...target.methodIndex.keys()].sort().slice(0, 5).join(', ')}...`);
            },
        });
    }
    methods() {
        return [...this.methodIndex.keys()].sort();
    }
    toString() {
        return `<${this.capability} namespace: ${this.methodIndex.size} methods>`;
    }
}
/** Special-cased usage namespace — overrides ingestEvents only. */
export class UsageNamespace extends Namespace {
    constructor(opts) {
        super('usage', opts.getClient, opts.importApiClass);
        this.ingestResolver = opts.ingestResolver;
        this.ingestBuffer = opts.ingestBuffer;
        this.makeClientAtUrl = opts.makeClientAtUrl;
        this.EventsApiClass = opts.importApiClass('EventsApi');
        // Override ingestEvents in the methodIndex so the Proxy returns ours.
        // We can't easily call (this as any).methodIndex because of the Proxy
        // wrapping in the parent — work around via getOwnPropertyNames.
        const indexRef = this.methodIndex;
        if (indexRef instanceof Map) {
            indexRef.set('ingestEvents', this.ingestEventsImpl.bind(this));
        }
    }
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
    ingestEventsImpl(events, ...rest) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!Array.isArray(events) || events.length === 0) {
                return { _dxPaginationEmptyIngest: true, count: 0 };
            }
            if (this.ingestBuffer !== null) {
                // Non-blocking enqueue (default).
                //
                // Unlike Go/Python (where the same pattern uses a producer
                // goroutine/thread + channel/queue to move work off the
                // customer's thread), TS runs on a single-threaded event
                // loop — there is no "other thread" to dispatch to without
                // Web Workers (which add complexity not justified by the
                // savings). The current direct enqueue is a JS array push
                // (~10 ns) under no contention. The customer's awaited
                // Promise resolves in the next microtask, off-thread by
                // event-loop semantics.
                //
                // The timer-driven drain handles HTTP + F2 chain on its
                // own iteration of the event loop.
                this.ingestBuffer.enqueue(events);
                return { buffered: true, count: events.length };
            }
            // Strict-sync mode: caller wants delivery confirmation per call.
            const url = yield this.ingestResolver.getIngestUrl();
            const clientAtUrl = this.makeClientAtUrl(url);
            const eventsApi = new this.EventsApiClass(clientAtUrl);
            try {
                const ingest = eventsApi.ingestEvents;
                if (typeof ingest !== 'function') {
                    throw new Error('EventsApi.ingestEvents not found — regenerate the SDK');
                }
                const result = yield ingest.call(eventsApi, events, ...rest);
                this.ingestResolver.reportPostOutcome(url, true);
                return result;
            }
            catch (err) {
                if (isTerminalIngestError(err)) {
                    // Don't penalize URL — a 401 means our key is wrong,
                    // not the host is down. Throw to caller.
                    throw err;
                }
                this.ingestResolver.reportPostOutcome(url, false);
                throw err;
            }
        });
    }
}
export function makeNamespace(capability, opts) {
    var _a;
    if (capability === 'usage') {
        if (!opts.ingestResolver || !opts.makeClientAtUrl) {
            throw new Error('usage namespace requires ingestResolver and makeClientAtUrl');
        }
        return new UsageNamespace({
            getClient: opts.getClient,
            importApiClass: opts.importApiClass,
            ingestResolver: opts.ingestResolver,
            ingestBuffer: (_a = opts.ingestBuffer) !== null && _a !== void 0 ? _a : null,
            makeClientAtUrl: opts.makeClientAtUrl,
        });
    }
    return new Namespace(capability, opts.getClient, opts.importApiClass);
}
