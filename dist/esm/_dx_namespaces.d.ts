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
    time: string;
    datacontenttype: 'application/json';
    data: Record<string, unknown>;
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
export declare function buildEnvelope(args: BuildEnvelopeArgs): CloudEventEnvelope;
/** Object-args input for `UsageNamespace.ingestEvent` (US-006).
 *  Required usage-lane fields are required at the type level;
 *  optional fields are independently optional. */
export interface UsageIngestEventArgs {
    eventType: string;
    customerId: string;
    entityId: string;
    meterSlug: string;
    value: number;
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
    /**
     * One-time deprecation-warning latch per instance (US-005). Customer's
     * first `client.usage.ingestEvents([...])` call emits a warning pointing
     * at the new `client.usage.ingestEvent(...)` singular surface; subsequent
     * calls stay silent to avoid log spam.
     */
    private legacyIngestEventsDeprecationWarned;
    constructor(opts: {
        getClient: GetClient;
        importApiClass: ImportApiClass;
        ingestResolver: IngestUrlResolver;
        ingestBuffer: IngestBuffer<unknown> | null;
        makeClientAtUrl: (url: string) => unknown;
    });
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
    private ingestEventsImpl;
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
    ingestEvent(args: UsageIngestEventArgs): Promise<IngestResult>;
}
/** Object-args input for `CostNamespace.ingestEvent` (US-007). Required
 *  cost-lane fields + the same optionals as usage. */
export interface CostIngestEventArgs {
    eventType: string;
    customerId: string;
    entityId: string;
    spans: ReadonlyArray<IngestSpan>;
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
export declare class CostNamespace extends Namespace {
    private readonly ingestResolver;
    private readonly ingestBuffer;
    private readonly makeClientAtUrl;
    private readonly EventsApiClass;
    /** Per-instance once-fire latch for the legacy-method deprecations.
     *  Class-level state would silently suppress the warning on a second
     *  Moolabs instance (customer-surprising) — per-instance is correct. */
    private warnedLegacyMethods;
    /** The legacy methods that get a deprecation warning on first access.
     *  `submitAdjustment` is intentionally excluded — see class doc. */
    private static readonly DEPRECATED_LEGACY_METHODS;
    constructor(opts: {
        getClient: GetClient;
        importApiClass: ImportApiClass;
        ingestResolver: IngestUrlResolver;
        ingestBuffer: IngestBuffer<unknown> | null;
        makeClientAtUrl: (url: string) => unknown;
    });
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
    ingestEvent(args: CostIngestEventArgs): Promise<IngestResult>;
}
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
export declare class EventsNamespace {
    private readonly ingestResolver;
    private readonly ingestBuffer;
    private readonly makeClientAtUrl;
    private readonly EventsApiClass;
    constructor(opts: {
        ingestResolver: IngestUrlResolver;
        ingestBuffer: IngestBuffer<unknown> | null;
        makeClientAtUrl: (url: string) => unknown;
        importApiClass: ImportApiClass;
    });
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
    ingest(args: EventsIngestArgs): Promise<IngestResult>;
}
export declare function makeNamespace(capability: string, opts: {
    getClient: GetClient;
    importApiClass: ImportApiClass;
    ingestResolver?: IngestUrlResolver;
    ingestBuffer?: IngestBuffer<unknown> | null;
    makeClientAtUrl?: (url: string) => unknown;
}): Namespace;
