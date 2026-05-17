"use strict";
/**
 * Capability → backing-class routing map for the normalized Moolabs SDK.
 *
 * TypeScript port of sdks/dx/python/moolabs/_dx_routing.py — cross-language
 * parity asserted by the automated parity job (BE Task H). Drift between
 * Python and TypeScript here fails the build.
 *
 * See _dx_routing.py for full design notes; this file is intentionally a
 * one-to-one mirror.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CAPABILITY_ORDER = exports.CAPABILITY_MAP = exports.DEFAULT_REGION = exports.REGION_INGEST_MAP = exports.SUBDOMAIN_MAP = void 0;
/**
 * Backend → subdomain prefix. Customer's `baseUrl` is the root domain
 * (default "moolabs.com"); the SDK prepends `https://{subdomain}.` per call.
 * Customer code never types any of these subdomain strings.
 *
 * 'acute' added per sdk-cost-capability-acute-backing US-008 (T-11) —
 * drives the cost capability direct to `acute.{baseUrl}` instead of the
 * BFF cost-ingest-proxy router.
 */
exports.SUBDOMAIN_MAP = {
    bff: 'api',
    meter: 'meter',
    arc: 'arc',
    acute: 'acute',
};
/**
 * Region → ingest-host subdomain. F2 fallback chain step 3 composes
 * `https://ingest.{regionCode}.{baseUrl}` from this map plus a region
 * source (today: hardcoded "us"; future: extracted from the API key).
 *
 * Mirrors BFF's REGION_INGEST_MAP in
 * services/moolabs-app/bff/app/api/v1/tenant_config.py. Drift would surface
 * as wrong-region ingest during F2 fallback; values are kept identical by
 * convention. Update both sides together.
 */
exports.REGION_INGEST_MAP = {
    'us-east-1': 'us',
    'us-west-2': 'us',
    'ap-southeast-1': 'ap',
    'eu-west-1': 'eu',
};
/** Fallback region when the SDK has no other signal (today: always us-east). */
exports.DEFAULT_REGION = 'us-east-1';
/**
 * Capability → backing classes. The 11 customer-facing namespaces frozen
 * by contracts §3.2. `portal` intentionally excluded (UI-only, O3 closure).
 *
 * O4 verified zero method-name collisions across all multi-class
 * capabilities (enumerated against moolabs-py@main). Sub-accessor pattern
 * remains a documented contingency for Arc but is not exercised today.
 */
exports.CAPABILITY_MAP = {
    usage: [
        { apiClass: 'EventsApi', backend: 'meter' },
        { apiClass: 'MetersApi', backend: 'meter' },
    ],
    customers: [
        { apiClass: 'CustomersApi', backend: 'meter' },
        { apiClass: 'SubjectsApi', backend: 'meter' },
    ],
    catalog: [
        { apiClass: 'ProductCatalogApi', backend: 'meter' },
        { apiClass: 'RateCardsApi', backend: 'bff' },
    ],
    subscriptions: [
        { apiClass: 'MeterSubscriptionsApi', backend: 'meter' },
    ],
    entitlements: [
        { apiClass: 'EntitlementsApi', backend: 'meter' },
    ],
    wallets: [
        { apiClass: 'WalletsApi', backend: 'bff' },
    ],
    credits: [
        { apiClass: 'GrantsApi', backend: 'bff' },
        { apiClass: 'LedgerApi', backend: 'bff' },
        { apiClass: 'AutoTopupApi', backend: 'bff' },
    ],
    billing: [
        { apiClass: 'MeterBillingApi', backend: 'meter' },
        { apiClass: 'RatingApi', backend: 'bff' },
        { apiClass: 'FxRatesApi', backend: 'bff' },
    ],
    collections: [
        { apiClass: 'AccountsApi', backend: 'arc' },
        { apiClass: 'AccountTeamApi', backend: 'arc' },
        { apiClass: 'AnalyticsApi', backend: 'arc' },
        { apiClass: 'CasesApi', backend: 'arc' },
        { apiClass: 'CashCreditsApi', backend: 'arc' },
        { apiClass: 'ArcCommunicationsApi', backend: 'arc' }, // stitcher-renamed tag
        { apiClass: 'CreditMemosApi', backend: 'arc' },
        { apiClass: 'DisputesApi', backend: 'arc' },
        { apiClass: 'EscalationsApi', backend: 'arc' },
        { apiClass: 'HandoffsApi', backend: 'arc' },
        { apiClass: 'NotesApi', backend: 'arc' },
        { apiClass: 'PaymentsApi', backend: 'arc' },
        { apiClass: 'PlansApi', backend: 'arc' },
        { apiClass: 'PromisesApi', backend: 'arc' },
        { apiClass: 'RemittancesApi', backend: 'arc' },
        { apiClass: 'ReportsApi', backend: 'arc' },
        { apiClass: 'TasksApi', backend: 'arc' },
    ],
    // AI cost-intelligence ingestion — DIRECT to acute.{baseUrl}.
    // Per sdk-cost-capability-acute-backing US-008 (T-11). See
    // _dx_routing.py for the full design rationale.
    //
    // CostEventsApi backs:
    //   client.cost.ingestEvent       (POST /api/v1/cost/ingest)
    //   client.cost.ingestBatch       (POST /api/v1/cost/ingest/batch)
    //   client.cost.submitAdjustment  (POST /api/v1/cost/adjustments)
    //
    // SdkIngestApi backs:
    //   client.cost.ingestSdkSpans    (POST /api/v1/ingest/batch)
    cost: [
        { apiClass: 'CostEventsApi', backend: 'acute' },
        { apiClass: 'SdkIngestApi', backend: 'acute' },
    ],
    notifications: [
        { apiClass: 'NotificationsApi', backend: 'meter' },
        { apiClass: 'AlertsApi', backend: 'bff' },
    ],
};
/**
 * Ordered list of capabilities for stable iteration (e.g. cross-language
 * parity diffs). Same order as in contracts §3.2.
 */
exports.CAPABILITY_ORDER = [
    'usage',
    'customers',
    'catalog',
    'subscriptions',
    'entitlements',
    'wallets',
    'credits',
    'billing',
    'collections',
    'cost',
    'notifications',
];
/**
 * Runtime self-consistency check — invoked at module load. Mirrors
 * _dx_routing.py's _validate_routing(): fail fast on backend / order /
 * empty-capability drift so a config bug surfaces at import, not on a
 * mysterious method call.
 */
function validateRouting() {
    const validBackends = new Set(Object.keys(exports.SUBDOMAIN_MAP));
    const capSet = new Set(Object.keys(exports.CAPABILITY_MAP));
    const orderSet = new Set(exports.CAPABILITY_ORDER);
    if (capSet.size !== orderSet.size) {
        throw new Error(`CAPABILITY_MAP (${capSet.size}) vs CAPABILITY_ORDER (${orderSet.size}) size drift`);
    }
    for (const c of capSet) {
        if (!orderSet.has(c)) {
            throw new Error(`capability ${c} in CAPABILITY_MAP but not CAPABILITY_ORDER`);
        }
    }
    for (const c of orderSet) {
        if (!capSet.has(c)) {
            throw new Error(`capability ${c} in CAPABILITY_ORDER but not CAPABILITY_MAP`);
        }
    }
    for (const [capability, classes] of Object.entries(exports.CAPABILITY_MAP)) {
        if (classes.length === 0) {
            throw new Error(`capability ${capability} has no backing classes — every namespace must back at least one class`);
        }
        for (const bc of classes) {
            if (!validBackends.has(bc.backend)) {
                throw new Error(`capability ${capability} class ${bc.apiClass} declares backend ${bc.backend}` +
                    ` which is not in SUBDOMAIN_MAP (known: ${[...validBackends].sort().join(', ')})`);
            }
        }
    }
}
validateRouting();
