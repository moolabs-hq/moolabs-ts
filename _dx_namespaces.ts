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
import { CAPABILITY_MAP, type Backend } from './_dx_routing';
import { IngestUrlResolver } from './_dx_urls';


/** HTTP status codes that mean "this request will NEVER succeed on retry."
 *  Auth (401/403), validation (400/422), removed-route (404).
 *  Retrying with the same key/body/URL fails identically; buffering hides
 *  the error from the caller and silently loses events. */
const TERMINAL_STATUSES = new Set<number>([400, 401, 403, 404, 422]);

/** True if `err` represents a non-retryable HTTP failure.
 *  Inspects axios-style errors (`err.response.status`) and openapi-generator
 *  errors. Network errors and other unknown error shapes are treated as
 *  transient (retryable / bufferable). Exported so the buffer drain
 *  callback in _dx_client.ts can use the same classification. */
export function isTerminalIngestError(err: unknown): boolean {
    if (err === null || typeof err !== 'object') return false;
    const response = (err as { response?: { status?: unknown } }).response;
    if (response && typeof response.status === 'number'
        && TERMINAL_STATUSES.has(response.status)) {
        return true;
    }
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number' && TERMINAL_STATUSES.has(status)) {
        return true;
    }
    return false;
}


/** Resolves an API class name (e.g. "WalletsApi") to the actual class.
 *  Real impl: dynamic import + lookup. Test impl: registry. */
export type ImportApiClass = (className: string) => new (config?: unknown) => Record<string, unknown>;

/** Backend → Configuration / ApiClient lookup. */
export type GetClient = (backend: Backend) => unknown;


// ── US-006: IngestResult + buildEnvelope shared scaffolding ──────────────


/** Default CloudEvent `source` when caller doesn't supply one. Identifies
 *  the SDK as producer per PRD Section 4 / FR-1. */
const DEFAULT_SDK_SOURCE = 'moolabs-sdk';


/** Customer-facing return type for the three new ergonomic ingest methods
 *  (US-006 usage, US-007 cost, US-008 events). Mirrors the Python
 *  `IngestResult` frozen dataclass. */
export interface IngestResult {
    /** The id that was sent (auto-generated when caller didn't pass
     *  `eventId`). Useful for sibling-join with a future cost event
     *  sharing the same `entityId`. */
    eventId: string;
    /** `"buffered"` when enqueued to the in-memory G5 buffer
     *  (non-blocking; HTTP happens later via the drain worker).
     *  `"sync"` when posted on the caller's thread (strict-sync mode,
     *  constructed via `new Moolabs({buffer: false})`). */
    transport: 'buffered' | 'sync';
    /** Client-side timestamp the SDK recorded when the envelope was
     *  built / enqueued. NOT the server's receipt time. */
    acceptedAt: Date;
}


/** Span shape on the cost lane. Open at the boundary — acute's mapping
 *  engine accepts arbitrary span fields — but `spanId` MUST be non-empty
 *  per the dedup grain `sdk:{spanId}`. */
export interface IngestSpan {
    spanId: string;
    [key: string]: unknown;
}


/** Shape of the CloudEvent envelope the SDK puts on the wire. Mirrors
 *  the Python `Event` Pydantic model the underlying `EventsApi.ingestEvents`
 *  expects. We keep this as a plain object shape so we don't have to
 *  import the generated model. */
export interface CloudEventEnvelope {
    id: string;
    specversion: '1.0';
    source: string;
    type: string;
    subject: string;
    time: string;  // RFC3339
    datacontenttype: 'application/json';
    data: Record<string, unknown>;
}


/** Generate a UUID4 hex (32 chars, no hyphens) matching the Python side
 *  output shape. Uses `crypto.randomUUID()` (Node 14.17+ / modern
 *  browsers) and strips the hyphens for parity with Python's
 *  `uuid.uuid4().hex`. */
function uuid4Hex(): string {
    // crypto.randomUUID returns `xxxxxxxx-xxxx-Mxxx-Nxxx-xxxxxxxxxxxx` (36
    // chars). Strip hyphens for 32-char hex parity with the Python side.
    const u = (globalThis.crypto as { randomUUID?: () => string }).randomUUID?.();
    if (typeof u === 'string') {
        return u.replace(/-/g, '');
    }
    // Fallback: build a 32-hex string from Math.random (deterministic-free
    // but adequate for SDK-side ids; the server side enforces uniqueness
    // via the dedup grain anyway). Only used in environments lacking
    // crypto.randomUUID (very rare in 2026).
    let out = '';
    for (let i = 0; i < 32; i += 1) {
        out += Math.floor(Math.random() * 16).toString(16);
    }
    return out;
}


/** Reject NaN / Infinity / non-numeric / bool for the usage-lane `value`
 *  field. Bool is technically a primitive but rejecting explicitly
 *  surfaces type-confusion bugs (customer probably wanted 1, not
 *  true). */
function checkValueIsFinite(value: unknown): void {
    if (typeof value === 'boolean') {
        throw new Error(
            `value must be a finite number, not boolean; got ${String(value)}`,
        );
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        const desc = typeof value === 'number' ? String(value) : `${typeof value} ${String(value)}`;
        throw new Error(`value must be a finite number; got ${desc}`);
    }
}


/** Every span MUST carry a non-empty string `span_id` (canonical wire
 *  shape) OR `spanId` (TS-internal alias). Acute's per-span dedup grain
 *  is `sdk:{span_id}`; an empty / missing span_id collides every cost
 *  span into the same dedup key — silent data loss.
 *
 *  Accepts both forms for cross-language consistency: the canonical wire
 *  shape uses snake_case `span_id` (matching Python and Go), but TS
 *  callers historically wrote camelCase. Either form passes validation;
 *  the wire-shape contract is the snake_case form. */
function checkSpansHaveSpanIds(spans: ReadonlyArray<unknown>): void {
    spans.forEach((span, i) => {
        if (span === null || typeof span !== 'object' || Array.isArray(span)) {
            throw new Error(`spans[${i}] must be a plain object; got ${typeof span}`);
        }
        const s = span as { span_id?: unknown; spanId?: unknown };
        // Prefer span_id (canonical) when it's a non-empty string; fall
        // back to spanId (TS-internal alias) otherwise. NOTE: `??` would
        // be wrong here — it short-circuits only on nullish, so an empty-
        // string `span_id` would mask a valid `spanId` (round 4 Finding 4).
        const canonical = typeof s.span_id === 'string' && s.span_id.length > 0
            ? s.span_id
            : (typeof s.spanId === 'string' ? s.spanId : undefined);
        if (typeof canonical !== 'string' || canonical.length === 0) {
            throw new Error(`spans[${i}].span_id must be a non-empty string`);
        }
    });
}


/** Verify `meta` JSON-serializes cleanly. `JSON.stringify` silently
 *  coerces some non-serializable types (Set → {}, Map → {}), so we
 *  also walk the value tree to reject those explicitly — matching
 *  Python's `json.dumps`-based rejection. */
function checkMetaIsJsonSerializable(meta: unknown): void {
    function walk(value: unknown, path: string): void {
        if (value === null || value === undefined) return;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return;
        if (typeof value === 'bigint') {
            throw new Error(`meta${path}: bigint is not JSON-serializable`);
        }
        if (typeof value === 'function') {
            throw new Error(`meta${path}: function is not JSON-serializable`);
        }
        if (value instanceof Set || value instanceof Map) {
            throw new Error(
                `meta${path}: ${value.constructor.name} is not JSON-serializable ` +
                `(JSON.stringify silently coerces these to {} — rejecting to surface the bug)`,
            );
        }
        if (Array.isArray(value)) {
            value.forEach((item, i) => walk(item, `${path}[${i}]`));
            return;
        }
        if (typeof value === 'object') {
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
                walk(v, `${path}.${k}`);
            }
            return;
        }
        throw new Error(`meta${path}: unsupported type ${typeof value}`);
    }
    walk(meta, '');
    // After the walk, JSON.stringify itself should succeed (cycle detection).
    try {
        JSON.stringify(meta);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`meta must be JSON-serializable: ${msg}`);
    }
}


/** Object-args input for the envelope builder + the three new ingest
 *  methods. Optional lanes are typed independently; the caller's method
 *  enforces which must be present. */
export interface BuildEnvelopeArgs {
    eventType: string;
    customerId: string;
    entityId: string;
    meterSlug?: string;
    value?: number;
    spans?: ReadonlyArray<IngestSpan>;
    // Well-known top-level data.* keys (canonical wire shape).
    // Optional everywhere; present at `data.<key>` when set.
    provider?: string;
    model?: string;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalTokens?: number;
    latencyMs?: number;
    status?: string;
    eventId?: string;
    source?: string;
    time?: Date;
    meta?: Record<string, unknown>;
}


/** Build a CloudEvent envelope from ergonomic kwargs (US-006).
 *
 *  Wire contract: docs/prd/2026-06-02-sdk-unified-ingest-methods-prd.md
 *  Section 4 canonical envelope. `entityId` maps to `data.request_id`
 *  on the wire (the threading key preserved for moo-meter's request_id
 *  column and acute's cross-lane join).
 *
 *  Boundary checks fire synchronously BEFORE any IO so customers see
 *  the rejection at their call site:
 *
 *   - empty `eventType` / `customerId` / `entityId`
 *   - non-finite `value` (NaN / Infinity / boolean / non-number)
 *   - missing or empty `spanId` on any span
 *   - non-JSON-serializable `meta` (Set, Map, bigint, function, cycles)
 *
 *  Returns a `CloudEventEnvelope` object — passed to the underlying
 *  `EventsApi.ingestEvents(event)` singular call. Customer never
 *  constructs `Event(...)` directly.
 *
 *  NOTE: `tenantId` is NOT an argument — server derives tenant identity
 *  from the API key.
 */
export function buildEnvelope(args: BuildEnvelopeArgs): CloudEventEnvelope {
    const {
        eventType,
        customerId,
        entityId,
        meterSlug,
        value,
        spans,
        provider,
        model,
        totalInputTokens,
        totalOutputTokens,
        totalTokens,
        latencyMs,
        status,
        eventId,
        source,
        time,
        meta,
    } = args;

    if (typeof eventType !== 'string' || eventType.length === 0) {
        throw new Error('eventType must be a non-empty string');
    }
    if (typeof customerId !== 'string' || customerId.length === 0) {
        throw new Error('customerId must be a non-empty string');
    }
    if (typeof entityId !== 'string' || entityId.length === 0) {
        throw new Error('entityId must be a non-empty string');
    }
    if (value !== undefined) {
        checkValueIsFinite(value);
    }
    if (spans !== undefined) {
        checkSpansHaveSpanIds(spans);
    }
    if (meta !== undefined) {
        checkMetaIsJsonSerializable(meta);
    }

    // Assemble `data`. Well-known top-level keys land at `data.<key>`
    // directly; arbitrary user fields stay nested at `data.meta.<key>` per
    // Decision 4 of the PRD's HOW section.
    const data: Record<string, unknown> = { request_id: entityId };
    if (meterSlug !== undefined) data.meter_slug = meterSlug;
    if (value !== undefined) data.value = value;
    // Well-known top-level data.* keys (canonical wire shape).
    if (provider !== undefined) data.provider = provider;
    if (model !== undefined) data.model = model;
    if (totalInputTokens !== undefined) data.total_input_tokens = totalInputTokens;
    if (totalOutputTokens !== undefined) data.total_output_tokens = totalOutputTokens;
    if (totalTokens !== undefined) data.total_tokens = totalTokens;
    if (latencyMs !== undefined) data.latency_ms = latencyMs;
    if (status !== undefined) data.status = status;
    if (spans !== undefined) {
        // Normalize each span to the canonical wire shape (snake_case
        // `span_id`). The validator accepts both `span_id` (canonical,
        // matches Py/Go) and `spanId` (TS-internal alias). The wire MUST
        // emit `span_id` — moo-acute's per-span dedup grain is
        // `sdk:{span_id}`. A span with only `spanId` would land at
        // `data.spans[n].spanId` which acute cannot read → silent data
        // loss at the dedup layer (round 4 Phase 3 verified). Rewrite
        // `spanId` → `span_id` if the canonical key is not already set,
        // then drop `spanId` to keep the wire shape unambiguous.
        data.spans = spans.map((span) => {
            const s = span as Record<string, unknown>;
            // If only camelCase is set, promote it to canonical.
            const hasCanonical = typeof s.span_id === 'string' && (s.span_id as string).length > 0;
            const hasAlias = typeof s.spanId === 'string' && (s.spanId as string).length > 0;
            if (!hasCanonical && hasAlias) {
                // NOTE: drop BOTH keys from rest, then re-emit span_id.
                // A naive `{ span_id: spanId, ...rest }` would have its
                // canonical key overwritten by a stale empty-string
                // `span_id` already present in `s` (round 4 Finding 4).
                const { spanId, span_id: _stale, ...rest } = s;
                return { span_id: spanId, ...rest };
            }
            // If both set, canonical wins; drop the alias to avoid
            // ambiguous downstream parsing.
            if (hasCanonical && 'spanId' in s) {
                const { spanId: _drop, ...rest } = s;
                return rest;
            }
            return s;
        });
    }
    if (meta !== undefined) data.meta = meta;

    return {
        id: eventId ?? uuid4Hex(),
        specversion: '1.0',
        source: source ?? DEFAULT_SDK_SOURCE,
        type: eventType,
        subject: customerId,
        time: (time ?? new Date()).toISOString(),
        datacontenttype: 'application/json',
        data,
    };
}


/** Object-args input for `UsageNamespace.ingestEvent` (US-006).
 *  Required usage-lane fields are required at the type level;
 *  optional fields are independently optional. */
export interface UsageIngestEventArgs {
    eventType: string;
    customerId: string;
    entityId: string;
    meterSlug: string;
    value: number;
    // Well-known top-level data.* keys (canonical wire shape — all optional).
    provider?: string;
    model?: string;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalTokens?: number;
    latencyMs?: number;
    status?: string;
    eventId?: string;
    source?: string;
    time?: Date;
    meta?: Record<string, unknown>;
}


export class Namespace {
    private readonly methodIndex = new Map<string, (...args: unknown[]) => unknown>();
    public readonly capability: string;

    constructor(
        capability: string,
        getClient: GetClient,
        importApiClass: ImportApiClass,
    ) {
        if (!(capability in CAPABILITY_MAP)) {
            throw new Error(`unknown capability ${capability!}; valid: ${Object.keys(CAPABILITY_MAP).sort().join(', ')}`);
        }
        this.capability = capability;
        for (const bc of CAPABILITY_MAP[capability]) {
            const ApiClass = importApiClass(bc.apiClass);
            const client = getClient(bc.backend);
            const instance = new ApiClass(client);
            // Walk own + prototype methods (openapi-generator typescript-axios
            // emits methods on the prototype, not the instance).
            const proto = Object.getPrototypeOf(instance) as object;
            const names = new Set<string>([
                ...Object.getOwnPropertyNames(instance),
                ...Object.getOwnPropertyNames(proto),
            ]);
            for (const name of names) {
                if (name.startsWith('_') || name === 'constructor') continue;
                const value = (instance as Record<string, unknown>)[name];
                if (typeof value !== 'function') continue;
                if (this.methodIndex.has(name)) continue;   // first-class-wins
                // Bind to instance so `this` works when the customer destructures
                this.methodIndex.set(name, (value as (...args: unknown[]) => unknown).bind(instance));
            }
        }
        return new Proxy(this, {
            get: (target, prop: string | symbol) => {
                if (typeof prop === 'symbol' || prop.startsWith('_')) {
                    return Reflect.get(target, prop);
                }
                // Class-defined attrs (capability, methodIndex, etc.) hit first
                if (prop in target) return Reflect.get(target, prop);
                const fn = target.methodIndex.get(prop);
                if (fn !== undefined) return fn;
                throw new Error(
                    `capability ${target.capability} has no method ${prop!}; ` +
                    `available include: ${[...target.methodIndex.keys()].sort().slice(0, 5).join(', ')}...`
                );
            },
        });
    }

    methods(): string[] {
        return [...this.methodIndex.keys()].sort();
    }

    toString(): string {
        return `<${this.capability} namespace: ${this.methodIndex.size} methods>`;
    }
}


/** Special-cased usage namespace — overrides ingestEvents only. */
export class UsageNamespace extends Namespace {
    private readonly ingestResolver: IngestUrlResolver;
    private readonly ingestBuffer: IngestBuffer<unknown> | null;
    private readonly makeClientAtUrl: (url: string) => unknown;
    private readonly EventsApiClass: new (config?: unknown) => Record<string, unknown>;

    /**
     * One-time deprecation-warning latch per instance (US-005). Customer's
     * first `client.usage.ingestEvents([...])` call emits a warning pointing
     * at the new `client.usage.ingestEvent(...)` singular surface; subsequent
     * calls stay silent to avoid log spam.
     */
    private legacyIngestEventsDeprecationWarned = false;

    constructor(opts: {
        getClient: GetClient;
        importApiClass: ImportApiClass;
        ingestResolver: IngestUrlResolver;
        ingestBuffer: IngestBuffer<unknown> | null;
        makeClientAtUrl: (url: string) => unknown;
    }) {
        super('usage', opts.getClient, opts.importApiClass);
        this.ingestResolver = opts.ingestResolver;
        this.ingestBuffer = opts.ingestBuffer;
        this.makeClientAtUrl = opts.makeClientAtUrl;
        this.EventsApiClass = opts.importApiClass('EventsApi');
        // Override ingestEvents in the methodIndex so the Proxy returns ours.
        // We can't easily call (this as any).methodIndex because of the Proxy
        // wrapping in the parent — work around via getOwnPropertyNames.
        const indexRef = (this as unknown as { methodIndex: Map<string, unknown> }).methodIndex;
        if (indexRef instanceof Map) {
            indexRef.set('ingestEvents', this.ingestEventsImpl.bind(this));
        }
    }

    /** F2+G5 ingest (legacy list-shaped surface).
     *
     *  @deprecated Use `client.usage.ingestEvent({ eventType, customerId,
     *  entityId, meterSlug, value, ... })` instead — the singular,
     *  object-args surface shipped in US-006. The list-shaped method is
     *  retained for one minor version after the unified ingest methods
     *  ship so existing call sites don't break during migration.
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
     *  buffer is the primary path; caller never blocks unless opted out.
     *
     *  US-005 fix (2026-06-02): the strict-sync path previously passed
     *  `events` (the array) as the positional arg to
     *  `EventsApi.ingestEvents(event: Event)` — typed for a single Event
     *  and Pydantic-rejecting the array. Fix: unwrap single-element
     *  arrays and iterate multi-element arrays, calling the singular
     *  underlying method per event. */
    private async ingestEventsImpl(events: unknown[], ...rest: unknown[]): Promise<unknown> {
        if (!Array.isArray(events) || events.length === 0) {
            return { _dxPaginationEmptyIngest: true, count: 0 };
        }

        // US-005 deprecation: emit ONCE per instance pointing customers at
        // the new singular `ingestEvent({...})` surface. Subsequent calls
        // stay silent to avoid log spam in tight loops. Console.warn instead
        // of throwing because the legacy method MUST keep working for one
        // minor version (migration window).
        if (!this.legacyIngestEventsDeprecationWarned) {
            this.legacyIngestEventsDeprecationWarned = true;
            // eslint-disable-next-line no-console
            console.warn(
                'client.usage.ingestEvents([...]) is deprecated; use ' +
                'client.usage.ingestEvent({ eventType, customerId, entityId, ' +
                'meterSlug, value, ... }) (singular, object-args) instead.',
            );
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
        const url = await this.ingestResolver.getIngestUrl();
        const clientAtUrl = this.makeClientAtUrl(url);
        const eventsApi = new this.EventsApiClass(clientAtUrl);
        try {
            // US-005: the generated `EventsApi.ingestEvents` is typed for a
            // single `event: Event`, NOT an events array. The old type
            // ascription pretended the underlying accepted an array — the
            // type lie matched the wire bug. Fixed signature reflects the
            // singular shape.
            const ingest = (eventsApi as { ingestEvents?: (event: unknown, ...rest: unknown[]) => Promise<unknown> }).ingestEvents;
            if (typeof ingest !== 'function') {
                throw new Error('EventsApi.ingestEvents not found — regenerate the SDK');
            }

            let result: unknown;
            if (events.length === 1) {
                // Single-element array: unwrap and call the singular
                // underlying with the lone event.
                result = await ingest.call(eventsApi, events[0], ...rest);
            } else {
                // Multi-element array: underlying spec only supports
                // singular ingestion today. Iterate; first failure
                // propagates immediately (strict-sync contract — partial-
                // batch semantics aren't promised here, mirroring Python
                // US-001).
                for (const ev of events) {
                    await ingest.call(eventsApi, ev, ...rest);
                }
                result = { count: events.length };
            }
            this.ingestResolver.reportPostOutcome(url, true);
            return result;
        } catch (err) {
            if (isTerminalIngestError(err)) {
                // Don't penalize URL — a 401 means our key is wrong,
                // not the host is down. Throw to caller.
                throw err;
            }
            this.ingestResolver.reportPostOutcome(url, false);
            throw err;
        }
    }

    // ── US-006: ergonomic-args singular ingest ───────────────────────────

    /** Emit a usage-lane CloudEvent to the unified meter endpoint.
     *
     *  See docs/prd/2026-06-02-sdk-unified-ingest-methods-prd.md US-006.
     *
     *  Required args (in the `args` object):
     *   - `eventType`: CloudEvents `type` (e.g. `"ai.chat"`)
     *   - `customerId`: end-customer identifier (becomes CloudEvents
     *     `subject`); the billable entity
     *   - `entityId`: threading key; same value on the sibling cost event
     *     lets downstream join the two without a transaction (on the wire
     *     as `data.request_id`)
     *   - `meterSlug`: which per-tenant meter aggregates this event
     *   - `value`: the aggregation unit — sum/count/avg key
     *
     *  Optional args:
     *   - `eventId`: stable id for idempotency; auto-generated UUID4 hex
     *     if omitted (every retry mints a new id, so retry safety is
     *     opt-in)
     *   - `source`: CloudEvents `source` (defaults to `"moolabs-sdk"`)
     *   - `time`: CloudEvents `time` (defaults to `new Date()`)
     *   - `meta`: free-form attribution dict — feature_key, model,
     *     provider, anything JSON-serializable. Lands at `data.meta`
     *     nested per Decision 4 in the PRD.
     *
     *  Routing: built envelope flows through the existing G5 buffer
     *  (when present) or directly via `EventsApi.ingestEvents(event)`
     *  against an F2-resolved URL — same transport the legacy
     *  `ingestEvents(list)` method uses post-US-005.
     *
     *  `tenantId` is NOT in the args type. The server derives tenant
     *  identity from the API key sent in the `Authorization` header.
     *
     *  Returns `IngestResult` carrying the (possibly auto-generated)
     *  `eventId`, the `transport` ("buffered" or "sync"), and a
     *  client-side `acceptedAt` timestamp.
     *
     *  Throws synchronously (before buffer enqueue) on any boundary-
     *  check failure (see `buildEnvelope`). Strict-sync HTTP failures
     *  throw normally from the awaited Promise; buffered HTTP failures
     *  are async and surface via `client.getStats().terminalDrops`. */
    public async ingestEvent(args: UsageIngestEventArgs): Promise<IngestResult> {
        const acceptedAt = new Date();
        const envelope = buildEnvelope(args);

        if (this.ingestBuffer !== null) {
            // Non-blocking enqueue. The TS buffer holds an array of events
            // per enqueue; pass [envelope] so the existing drain pipeline
            // sees the same shape it does today (mirrors the Python
            // singular-into-list wrap).
            this.ingestBuffer.enqueue([envelope]);
            return {
                eventId: envelope.id,
                transport: 'buffered',
                acceptedAt,
            };
        }

        // Strict-sync mode.
        const url = await this.ingestResolver.getIngestUrl();
        const clientAtUrl = this.makeClientAtUrl(url);
        const eventsApi = new this.EventsApiClass(clientAtUrl);
        try {
            const ingest = (eventsApi as { ingestEvents?: (event: unknown) => Promise<unknown> }).ingestEvents;
            if (typeof ingest !== 'function') {
                throw new Error('EventsApi.ingestEvents not found — regenerate the SDK');
            }
            await ingest.call(eventsApi, envelope);
            this.ingestResolver.reportPostOutcome(url, true);
            return {
                eventId: envelope.id,
                transport: 'sync',
                acceptedAt,
            };
        } catch (err) {
            if (isTerminalIngestError(err)) {
                throw err;
            }
            this.ingestResolver.reportPostOutcome(url, false);
            throw err;
        }
    }
}


// ── US-007: cost capability with meter routing ──────────────────────────


/** Object-args input for `CostNamespace.ingestEvent` (US-007). Required
 *  cost-lane fields + the same optionals as usage. */
export interface CostIngestEventArgs {
    eventType: string;
    customerId: string;
    entityId: string;
    spans: ReadonlyArray<IngestSpan>;
    // Well-known top-level data.* keys (canonical wire shape — all optional).
    // Use these for aggregate values when all spans share the same property;
    // use per-span fields (inside each IngestSpan) when spans differ.
    provider?: string;
    model?: string;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalTokens?: number;
    latencyMs?: number;
    status?: string;
    eventId?: string;
    source?: string;
    time?: Date;
    meta?: Record<string, unknown>;
}


/** Cost capability — special-cased to add `ingestEvent` routed through
 *  the unified meter endpoint (NOT the legacy acute direct path).
 *
 *  Per docs/prd/2026-06-02-sdk-unified-ingest-methods-prd.md US-007 +
 *  Decision 2: the meter endpoint is the SDK's only ingest target.
 *  Acute consumes the events from the `om_default_events` Kafka topic
 *  as a downstream consumer; the customer SDK no longer talks to acute
 *  directly.
 *
 *  Legacy methods on the cost capability — `ingestEventsBatch`
 *  (CostEventsApi batch endpoint) and `ingestSdkSpans` (SdkIngestApi) —
 *  continue to dispatch via the parent Namespace's methodIndex but get
 *  wrapped with a one-time `console.warn` deprecation notice per
 *  (instance, name) pointing customers at `client.cost.ingestEvent(...)`.
 *
 *  `submitAdjustment` is NOT wrapped — the unified adjustment surface
 *  (`client.events.adjust(...)`) is a separate slice; customers using
 *  the legacy method should keep using it until that ships.
 */
export class CostNamespace extends Namespace {
    private readonly ingestResolver: IngestUrlResolver;
    private readonly ingestBuffer: IngestBuffer<unknown> | null;
    private readonly makeClientAtUrl: (url: string) => unknown;
    private readonly EventsApiClass: new (config?: unknown) => Record<string, unknown>;

    /** Per-instance once-fire latch for the legacy-method deprecations.
     *  Class-level state would silently suppress the warning on a second
     *  Moolabs instance (customer-surprising) — per-instance is correct. */
    private warnedLegacyMethods = new Set<string>();

    /** The legacy methods that get a deprecation warning on first access.
     *  `submitAdjustment` is intentionally excluded — see class doc. */
    private static readonly DEPRECATED_LEGACY_METHODS = new Set<string>([
        'ingestEventsBatch',
        'ingestSdkSpans',
    ]);

    constructor(opts: {
        getClient: GetClient;
        importApiClass: ImportApiClass;
        ingestResolver: IngestUrlResolver;
        ingestBuffer: IngestBuffer<unknown> | null;
        makeClientAtUrl: (url: string) => unknown;
    }) {
        super('cost', opts.getClient, opts.importApiClass);
        this.ingestResolver = opts.ingestResolver;
        this.ingestBuffer = opts.ingestBuffer;
        this.makeClientAtUrl = opts.makeClientAtUrl;
        // The new `ingestEvent` method routes through EventsApi (meter),
        // NOT CostEventsApi (acute). Legacy CostEventsApi methods stay
        // accessible via the methodIndex below.
        this.EventsApiClass = opts.importApiClass('EventsApi');

        // Wrap each deprecated legacy method in the methodIndex so the
        // first access emits a console.warn. Done AFTER super() (which
        // populates methodIndex with CostEventsApi + SdkIngestApi
        // methods). The new `ingestEvent` is a class-defined method, so
        // the parent Proxy's `prop in target` short-circuits before
        // hitting the methodIndex — no need to register it there.
        const indexRef = (this as unknown as { methodIndex: Map<string, (...args: unknown[]) => unknown> }).methodIndex;
        if (indexRef instanceof Map) {
            for (const legacyName of CostNamespace.DEPRECATED_LEGACY_METHODS) {
                const original = indexRef.get(legacyName);
                if (typeof original !== 'function') continue;
                indexRef.set(legacyName, (...args: unknown[]) => {
                    if (!this.warnedLegacyMethods.has(legacyName)) {
                        this.warnedLegacyMethods.add(legacyName);
                        // eslint-disable-next-line no-console
                        console.warn(
                            `client.cost.${legacyName}(...) is deprecated — it routes to the ` +
                            'acute direct path which is being retired. Use ' +
                            'client.cost.ingestEvent({ eventType, customerId, entityId, spans, ... }) ' +
                            'instead — it routes through the unified meter endpoint at ' +
                            'meter.{base}/api/v1/events.',
                        );
                    }
                    return (original as (...a: unknown[]) => unknown)(...args);
                });
            }
        }
    }

    /** Emit a cost-lane CloudEvent to the unified meter endpoint.
     *
     *  See docs/prd/2026-06-02-sdk-unified-ingest-methods-prd.md US-007.
     *
     *  Required args:
     *   - `eventType`: CloudEvents `type` (e.g. `"ai.completion"`)
     *   - `customerId`: end-customer identifier (becomes `subject`)
     *   - `entityId`: threading key (wire `data.request_id`); same value
     *     on the sibling usage event allows downstream lane-join
     *   - `spans`: array of cost-side per-span breakdowns. Each span
     *     MUST carry a non-empty `spanId`; acute's per-span dedup grain
     *     is `sdk:{spanId}` — empty / missing id collides every span
     *     into one dedup key (silent data loss). Other span fields are
     *     open-shape per acute's mapping engine.
     *
     *  Optional args: identical to `usage.ingestEvent`.
     *
     *  Routing: built envelope flows through the existing G5 buffer
     *  (when present) or strict-sync via `EventsApi.ingestEvents(event)`
     *  — same transport `usage.ingestEvent` uses. The cost lane is
     *  identified by the presence of `data.spans`; absence of
     *  `data.meter_slug` / `data.value` distinguishes it from the usage
     *  lane.
     *
     *  Why meter and not acute: per PRD Decision 2, the unified meter
     *  endpoint already publishes to the `om_default_events` Kafka
     *  topic, and acute's `cost_enricher` consumes from the same topic
     *  — events emitted via the meter path arrive at acute through the
     *  Kafka stream automatically, with the additional benefit that
     *  moo-meter's sink lands them in ClickHouse (events stream tab) and
     *  the BFF ingest_consumer lands them in BFF Postgres (usage stream
     *  tab).
     *
     *  `tenantId` is NOT in the args type — server derives from key. */
    public async ingestEvent(args: CostIngestEventArgs): Promise<IngestResult> {
        const acceptedAt = new Date();
        const envelope = buildEnvelope({
            ...args,
            // Force cost-lane shape: no meterSlug / value at the wire.
            meterSlug: undefined,
            value: undefined,
        });

        if (this.ingestBuffer !== null) {
            // Direct enqueue — cost is expected lower-frequency than
            // usage, so we don't need a separate producer-channel
            // optimization (same tradeoff as the Python _CostNamespace).
            this.ingestBuffer.enqueue([envelope]);
            return {
                eventId: envelope.id,
                transport: 'buffered',
                acceptedAt,
            };
        }

        const url = await this.ingestResolver.getIngestUrl();
        const clientAtUrl = this.makeClientAtUrl(url);
        const eventsApi = new this.EventsApiClass(clientAtUrl);
        try {
            const ingest = (eventsApi as { ingestEvents?: (event: unknown) => Promise<unknown> }).ingestEvents;
            if (typeof ingest !== 'function') {
                throw new Error('EventsApi.ingestEvents not found — regenerate the SDK');
            }
            await ingest.call(eventsApi, envelope);
            this.ingestResolver.reportPostOutcome(url, true);
            return {
                eventId: envelope.id,
                transport: 'sync',
                acceptedAt,
            };
        } catch (err) {
            if (isTerminalIngestError(err)) {
                throw err;
            }
            this.ingestResolver.reportPostOutcome(url, false);
            throw err;
        }
    }
}


// ── US-008: events capability for both-lanes-at-once ────────────────────


/** Object-args input for `EventsNamespace.ingest` (US-008). Required
 *  envelope basics + optional usage-lane fields + optional cost-lane
 *  spans. The method enforces that at least one complete lane is
 *  present (usage = both meterSlug + value; cost = spans). */
export interface EventsIngestArgs {
    eventType: string;
    customerId: string;
    entityId: string;
    meterSlug?: string;
    value?: number;
    spans?: ReadonlyArray<IngestSpan>;
    // Well-known top-level data.* keys (canonical wire shape — all optional).
    provider?: string;
    model?: string;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalTokens?: number;
    latencyMs?: number;
    status?: string;
    eventId?: string;
    source?: string;
    time?: Date;
    meta?: Record<string, unknown>;
}


/** Events capability — special-cased `ingest` method that emits a single
 *  envelope carrying BOTH lanes (usage + cost) in one call.
 *
 *  See docs/prd/2026-06-02-sdk-unified-ingest-methods-prd.md US-008.
 *
 *  Does NOT extend `Namespace` because there are no backing API classes
 *  to dispatch to — `events` is not in `CAPABILITY_MAP`. This namespace
 *  is a focused wrapper over the unified meter endpoint
 *  (`EventsApi.ingestEvents`) that lets a customer with both a billable
 *  usage dimension AND cost-side per-span breakdown at the same call
 *  site emit one envelope instead of two siblings.
 *
 *  Customers reach this via `client.events.ingest(args)` — the
 *  `Moolabs.events` getter (in `_dx_client.ts`) constructs this
 *  namespace lazily on first access.
 *
 *  Single-lane callers can still use this method (passing only meter
 *  or only spans), but they're typically better served by
 *  `client.usage.ingestEvent` or `client.cost.ingestEvent` whose
 *  required-args signatures make the lane intent explicit at the call
 *  site. */
export class EventsNamespace {
    private readonly ingestResolver: IngestUrlResolver;
    private readonly ingestBuffer: IngestBuffer<unknown> | null;
    private readonly makeClientAtUrl: (url: string) => unknown;
    private readonly EventsApiClass: new (config?: unknown) => Record<string, unknown>;

    constructor(opts: {
        ingestResolver: IngestUrlResolver;
        ingestBuffer: IngestBuffer<unknown> | null;
        makeClientAtUrl: (url: string) => unknown;
        importApiClass: ImportApiClass;
    }) {
        this.ingestResolver = opts.ingestResolver;
        this.ingestBuffer = opts.ingestBuffer;
        this.makeClientAtUrl = opts.makeClientAtUrl;
        this.EventsApiClass = opts.importApiClass('EventsApi');
    }

    /** Emit a CloudEvent carrying both lanes (if both provided).
     *
     *  Required args:
     *   - `eventType`: CloudEvents `type`
     *   - `customerId`: end-customer identifier (becomes `subject`)
     *   - `entityId`: threading key (wire `data.request_id`)
     *
     *  At least ONE of the two lanes MUST be present:
     *   - Usage lane: BOTH `meterSlug` AND `value` must be set
     *   - Cost lane: `spans` must be set (an empty array is allowed)
     *
     *  If neither lane is complete (both lane-specific groups missing
     *  or partial), `Error` is thrown synchronously before any envelope
     *  construction or HTTP work — the customer's call site gets
     *  immediate feedback.
     *
     *  `tenantId` is NOT in the args type (FR-3) — server derives from
     *  the API key.
     *
     *  Routing: same as `usage.ingestEvent` and `cost.ingestEvent` —
     *  `EventsApi.ingestEvents(event)` against the F2-resolved meter
     *  URL, with buffer + drain when a buffer was supplied at Moolabs
     *  construction.
     *
     *  Returns `IngestResult` with the (possibly auto-generated)
     *  `eventId`, the `transport` label, and a client-side
     *  `acceptedAt` timestamp. */
    public async ingest(args: EventsIngestArgs): Promise<IngestResult> {
        // Empty-envelope guard: at least one lane must be complete.
        // Usage lane is complete when BOTH meterSlug AND value are
        // supplied. Cost lane is complete when spans is supplied (an
        // array — empty still represents an intentional cost-lane
        // envelope, distinct from omitting the field). Fires BEFORE
        // any buildEnvelope work so the customer gets a synchronous
        // throw at the call site.
        const usageLaneComplete = args.meterSlug !== undefined && args.value !== undefined;
        const costLaneComplete = args.spans !== undefined;
        if (!usageLaneComplete && !costLaneComplete) {
            throw new Error(
                'events.ingest requires at least one lane to be present. ' +
                'Provide meterSlug + value (usage lane), or spans (cost ' +
                'lane), or both. Got: ' +
                `meterSlug=${JSON.stringify(args.meterSlug)}, ` +
                `value=${JSON.stringify(args.value)}, ` +
                `spans=${JSON.stringify(args.spans)}.`,
            );
        }

        const acceptedAt = new Date();
        const envelope = buildEnvelope(args);

        if (this.ingestBuffer !== null) {
            // Direct enqueue — both-lanes is expected lower-frequency
            // than the dedicated usage path; we don't need the
            // producer-channel optimization (same tradeoff as
            // CostNamespace).
            this.ingestBuffer.enqueue([envelope]);
            return {
                eventId: envelope.id,
                transport: 'buffered',
                acceptedAt,
            };
        }

        const url = await this.ingestResolver.getIngestUrl();
        const clientAtUrl = this.makeClientAtUrl(url);
        const eventsApi = new this.EventsApiClass(clientAtUrl);
        try {
            const ingest = (eventsApi as { ingestEvents?: (event: unknown) => Promise<unknown> }).ingestEvents;
            if (typeof ingest !== 'function') {
                throw new Error('EventsApi.ingestEvents not found — regenerate the SDK');
            }
            await ingest.call(eventsApi, envelope);
            this.ingestResolver.reportPostOutcome(url, true);
            return {
                eventId: envelope.id,
                transport: 'sync',
                acceptedAt,
            };
        } catch (err) {
            if (isTerminalIngestError(err)) {
                throw err;
            }
            this.ingestResolver.reportPostOutcome(url, false);
            throw err;
        }
    }
}


export function makeNamespace(
    capability: string,
    opts: {
        getClient: GetClient;
        importApiClass: ImportApiClass;
        ingestResolver?: IngestUrlResolver;
        ingestBuffer?: IngestBuffer<unknown> | null;
        makeClientAtUrl?: (url: string) => unknown;
    },
): Namespace {
    if (capability === 'usage') {
        if (!opts.ingestResolver || !opts.makeClientAtUrl) {
            throw new Error('usage namespace requires ingestResolver and makeClientAtUrl');
        }
        return new UsageNamespace({
            getClient: opts.getClient,
            importApiClass: opts.importApiClass,
            ingestResolver: opts.ingestResolver,
            ingestBuffer: opts.ingestBuffer ?? null,
            makeClientAtUrl: opts.makeClientAtUrl,
        });
    }
    if (capability === 'cost') {
        // US-007: cost capability gets ergonomic ingestEvent routed
        // through the unified meter endpoint. Same F2 + G5 plumbing as
        // usage; the routing target is meter, not acute.
        if (!opts.ingestResolver || !opts.makeClientAtUrl) {
            throw new Error(
                'cost namespace requires ingestResolver and makeClientAtUrl ' +
                '(needed for the unified-meter F2 ingest path; same as usage)',
            );
        }
        return new CostNamespace({
            getClient: opts.getClient,
            importApiClass: opts.importApiClass,
            ingestResolver: opts.ingestResolver,
            ingestBuffer: opts.ingestBuffer ?? null,
            makeClientAtUrl: opts.makeClientAtUrl,
        });
    }
    return new Namespace(capability, opts.getClient, opts.importApiClass);
}
