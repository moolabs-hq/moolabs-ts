/**
 * Unified Moolabs SDK facade — `new Moolabs({ apiKey, clsBaseUrl?, meterBaseUrl? })`.
 *
 * Hand-written DX layer that sits ON TOP of the openapi-generator
 * typescript-axios output. Copied into the generated tree by `generate.sh`
 * post-codegen when a tuple config sets `dx_dir: sdks/dx/typescript`.
 *
 * Two top-level namespaces customers see:
 *   - `client.cls.*`   → routes to api.moolabs.com (BFF, direct)
 *   - `client.meter.*` → routes to meter.moolabs.com (Meter, direct)
 *
 * Token: ONE `apiKey`, generated in the customer UI, valid against both
 * backends (each backend validates the same token independently — no
 * proxying through BFF).
 *
 * Usage:
 *
 *   import { Moolabs } from '@moolabs/sdk';
 *
 *   const client = new Moolabs({ apiKey: 'moo_live_xxx' });
 *
 *   // CLS (BFF-routed) — wallets, grants, ledger, billing, etc.
 *   const wallet = await client.cls.wallets.createWallet(...);
 *   const grants = await client.cls.grants.listGrants(...);
 *
 *   // Meter (Meter-routed) — events, meters, entitlements, etc.
 *   await client.meter.events.ingestEvents([...]);
 *   const meters = await client.meter.meters.listMeters();
 *
 * NOTE on collisions: BFF and Meter both have `portal` and `subscriptions`
 * tags. The OpenAPI generator emits the first source as `portal-api.ts` /
 * `subscriptions-api.ts` (currently Meter, due to stitch order) and the
 * second with a `0` filename suffix — `portal0-api.ts` is the BFF version.
 * The class names inside both files are the same; routing is determined by
 * which Configuration instance we instantiate them with.
 */
import { Configuration } from './configuration';
import { WalletsApi } from './api/wallets-api';
import { GrantsApi } from './api/grants-api';
import { LedgerApi } from './api/ledger-api';
import { AlertsApi } from './api/alerts-api';
import { AutoTopupApi } from './api/auto-topup-api';
import { RateCardsApi } from './api/rate-cards-api';
import { RatingApi } from './api/rating-api';
import { FxRatesApi } from './api/fx-rates-api';
import { PortalApi as ClsPortalApi } from './api/portal-api';
import { SubscriptionsApi as ClsSubscriptionsApi } from './api/subscriptions-api';
import { EventsApi } from './api/events-api';
import { MetersApi } from './api/meters-api';
import { CustomersApi } from './api/customers-api';
import { MeterSubscriptionsApi } from './api/meter-subscriptions-api';
import { MeterBillingApi } from './api/meter-billing-api';
import { EntitlementsApi } from './api/entitlements-api';
import { NotificationsApi } from './api/notifications-api';
import { AppsApi } from './api/apps-api';
import { MeterPortalApi } from './api/meter-portal-api';
import { ProductCatalogApi } from './api/product-catalog-api';
import { SubjectsApi } from './api/subjects-api';
export interface MoolabsConfig {
    /** Customer API key (issued in the Moolabs UI). Same key authenticates
     *  against both CLS and Meter backends; each validates independently. */
    apiKey: string;
    /** Base URL for CLS / billing operations. Default: https://api.moolabs.com */
    clsBaseUrl?: string;
    /** Base URL for usage / metering operations. Default: https://meter.moolabs.com */
    meterBaseUrl?: string;
}
/**
 * Unified Moolabs SDK client.
 *
 *   const client = new Moolabs({ apiKey: 'moo_live_...' });
 *   await client.cls.wallets.createWallet(...);
 *   await client.meter.events.ingestEvents([...]);
 */
export declare class Moolabs {
    readonly cls: ClsNamespace;
    readonly meter: MeterNamespace;
    constructor(config: MoolabsConfig);
}
/** All operations that route to the CLS / BFF backend (api.moolabs.com). */
export declare class ClsNamespace {
    private readonly cfg;
    constructor(cfg: Configuration);
    get wallets(): WalletsApi;
    get grants(): GrantsApi;
    get ledger(): LedgerApi;
    get alerts(): AlertsApi;
    get autoTopup(): AutoTopupApi;
    get rateCards(): RateCardsApi;
    get rating(): RatingApi;
    get fxRates(): FxRatesApi;
    get portal(): ClsPortalApi;
    get subscriptions(): ClsSubscriptionsApi;
}
/** All operations that route to the Meter backend (meter.moolabs.com). */
export declare class MeterNamespace {
    private readonly cfg;
    constructor(cfg: Configuration);
    get events(): EventsApi;
    get meters(): MetersApi;
    get customers(): CustomersApi;
    get subscriptions(): MeterSubscriptionsApi;
    get billing(): MeterBillingApi;
    get entitlements(): EntitlementsApi;
    get notifications(): NotificationsApi;
    get apps(): AppsApi;
    get portal(): MeterPortalApi;
    get productCatalog(): ProductCatalogApi;
    get subjects(): SubjectsApi;
}
