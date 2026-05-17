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
export interface BackingClass {
    readonly apiClass: string;
    readonly backend: Backend;
}
export type Backend = 'bff' | 'meter' | 'arc' | 'acute';
/**
 * Backend → subdomain prefix. Customer's `baseUrl` is the root domain
 * (default "moolabs.com"); the SDK prepends `https://{subdomain}.` per call.
 * Customer code never types any of these subdomain strings.
 *
 * 'acute' added per sdk-cost-capability-acute-backing US-008 (T-11) —
 * drives the cost capability direct to `acute.{baseUrl}` instead of the
 * BFF cost-ingest-proxy router.
 */
export declare const SUBDOMAIN_MAP: Readonly<Record<Backend, string>>;
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
export declare const REGION_INGEST_MAP: Readonly<Record<string, string>>;
/** Fallback region when the SDK has no other signal (today: always us-east). */
export declare const DEFAULT_REGION = "us-east-1";
/**
 * Capability → backing classes. The 11 customer-facing namespaces frozen
 * by contracts §3.2. `portal` intentionally excluded (UI-only, O3 closure).
 *
 * O4 verified zero method-name collisions across all multi-class
 * capabilities (enumerated against moolabs-py@main). Sub-accessor pattern
 * remains a documented contingency for Arc but is not exercised today.
 */
export declare const CAPABILITY_MAP: Readonly<Record<string, readonly BackingClass[]>>;
/**
 * Ordered list of capabilities for stable iteration (e.g. cross-language
 * parity diffs). Same order as in contracts §3.2.
 */
export declare const CAPABILITY_ORDER: readonly string[];
