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

// CLS / BFF backend api classes
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

// Meter backend api classes (Title-case Meter tags renamed at stitch time
// to MeterPortal/MeterSubscriptions/MeterBilling so they don't merge with
// BFF's lowercase portal/subscriptions/billing classes)
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

const DEFAULT_CLS_BASE_URL = 'https://api.moolabs.com';
const DEFAULT_METER_BASE_URL = 'https://meter.moolabs.com';

/**
 * Unified Moolabs SDK client.
 *
 *   const client = new Moolabs({ apiKey: 'moo_live_...' });
 *   await client.cls.wallets.createWallet(...);
 *   await client.meter.events.ingestEvents([...]);
 */
export class Moolabs {
    public readonly cls: ClsNamespace;
    public readonly meter: MeterNamespace;

    constructor(config: MoolabsConfig) {
        if (!config.apiKey) {
            throw new Error('Moolabs: apiKey is required');
        }
        const clsHost = (config.clsBaseUrl ?? DEFAULT_CLS_BASE_URL).replace(/\/$/, '');
        const meterHost = (config.meterBaseUrl ?? DEFAULT_METER_BASE_URL).replace(/\/$/, '');

        // openapi-generator's typescript-axios Configuration accepts:
        //   accessToken — used as `Authorization: Bearer <token>` for http+bearer security
        //   basePath    — overrides the spec's `servers`
        const clsCfg = new Configuration({ accessToken: config.apiKey, basePath: clsHost });
        const meterCfg = new Configuration({ accessToken: config.apiKey, basePath: meterHost });

        this.cls = new ClsNamespace(clsCfg);
        this.meter = new MeterNamespace(meterCfg);
    }
}

/** All operations that route to the CLS / BFF backend (api.moolabs.com). */
export class ClsNamespace {
    constructor(private readonly cfg: Configuration) {}

    get wallets(): WalletsApi { return new WalletsApi(this.cfg); }
    get grants(): GrantsApi { return new GrantsApi(this.cfg); }
    get ledger(): LedgerApi { return new LedgerApi(this.cfg); }
    get alerts(): AlertsApi { return new AlertsApi(this.cfg); }
    get autoTopup(): AutoTopupApi { return new AutoTopupApi(this.cfg); }
    // NOTE: cls.billing intentionally absent — BFF openapi.json currently
    // emits 0 ops under `billing`. Add a property when BFF exposes them.
    get rateCards(): RateCardsApi { return new RateCardsApi(this.cfg); }
    get rating(): RatingApi { return new RatingApi(this.cfg); }
    get fxRates(): FxRatesApi { return new FxRatesApi(this.cfg); }
    get portal(): ClsPortalApi { return new ClsPortalApi(this.cfg); }
    get subscriptions(): ClsSubscriptionsApi { return new ClsSubscriptionsApi(this.cfg); }
}

/** All operations that route to the Meter backend (meter.moolabs.com). */
export class MeterNamespace {
    constructor(private readonly cfg: Configuration) {}

    get events(): EventsApi { return new EventsApi(this.cfg); }
    get meters(): MetersApi { return new MetersApi(this.cfg); }
    get customers(): CustomersApi { return new CustomersApi(this.cfg); }
    get subscriptions(): MeterSubscriptionsApi { return new MeterSubscriptionsApi(this.cfg); }
    get billing(): MeterBillingApi { return new MeterBillingApi(this.cfg); }
    get entitlements(): EntitlementsApi { return new EntitlementsApi(this.cfg); }
    get notifications(): NotificationsApi { return new NotificationsApi(this.cfg); }
    get apps(): AppsApi { return new AppsApi(this.cfg); }
    get portal(): MeterPortalApi { return new MeterPortalApi(this.cfg); }
    get productCatalog(): ProductCatalogApi { return new ProductCatalogApi(this.cfg); }
    get subjects(): SubjectsApi { return new SubjectsApi(this.cfg); }
}
