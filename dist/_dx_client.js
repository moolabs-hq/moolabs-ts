"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MeterNamespace = exports.ClsNamespace = exports.Moolabs = void 0;
const configuration_1 = require("./configuration");
// CLS / BFF backend api classes
const wallets_api_1 = require("./api/wallets-api");
const grants_api_1 = require("./api/grants-api");
const ledger_api_1 = require("./api/ledger-api");
const alerts_api_1 = require("./api/alerts-api");
const auto_topup_api_1 = require("./api/auto-topup-api");
const rate_cards_api_1 = require("./api/rate-cards-api");
const rating_api_1 = require("./api/rating-api");
const fx_rates_api_1 = require("./api/fx-rates-api");
const portal_api_1 = require("./api/portal-api");
const subscriptions_api_1 = require("./api/subscriptions-api");
// Meter backend api classes (Title-case Meter tags renamed at stitch time
// to MeterPortal/MeterSubscriptions/MeterBilling so they don't merge with
// BFF's lowercase portal/subscriptions/billing classes)
const events_api_1 = require("./api/events-api");
const meters_api_1 = require("./api/meters-api");
const customers_api_1 = require("./api/customers-api");
const meter_subscriptions_api_1 = require("./api/meter-subscriptions-api");
const meter_billing_api_1 = require("./api/meter-billing-api");
const entitlements_api_1 = require("./api/entitlements-api");
const notifications_api_1 = require("./api/notifications-api");
const apps_api_1 = require("./api/apps-api");
const meter_portal_api_1 = require("./api/meter-portal-api");
const product_catalog_api_1 = require("./api/product-catalog-api");
const subjects_api_1 = require("./api/subjects-api");
const DEFAULT_CLS_BASE_URL = 'https://api.moolabs.com';
const DEFAULT_METER_BASE_URL = 'https://meter.moolabs.com';
/**
 * Unified Moolabs SDK client.
 *
 *   const client = new Moolabs({ apiKey: 'moo_live_...' });
 *   await client.cls.wallets.createWallet(...);
 *   await client.meter.events.ingestEvents([...]);
 */
class Moolabs {
    constructor(config) {
        var _a, _b;
        if (!config.apiKey) {
            throw new Error('Moolabs: apiKey is required');
        }
        const clsHost = ((_a = config.clsBaseUrl) !== null && _a !== void 0 ? _a : DEFAULT_CLS_BASE_URL).replace(/\/$/, '');
        const meterHost = ((_b = config.meterBaseUrl) !== null && _b !== void 0 ? _b : DEFAULT_METER_BASE_URL).replace(/\/$/, '');
        // openapi-generator's typescript-axios Configuration accepts:
        //   accessToken — used as `Authorization: Bearer <token>` for http+bearer security
        //   basePath    — overrides the spec's `servers`
        const clsCfg = new configuration_1.Configuration({ accessToken: config.apiKey, basePath: clsHost });
        const meterCfg = new configuration_1.Configuration({ accessToken: config.apiKey, basePath: meterHost });
        this.cls = new ClsNamespace(clsCfg);
        this.meter = new MeterNamespace(meterCfg);
    }
}
exports.Moolabs = Moolabs;
/** All operations that route to the CLS / BFF backend (api.moolabs.com). */
class ClsNamespace {
    constructor(cfg) {
        this.cfg = cfg;
    }
    get wallets() { return new wallets_api_1.WalletsApi(this.cfg); }
    get grants() { return new grants_api_1.GrantsApi(this.cfg); }
    get ledger() { return new ledger_api_1.LedgerApi(this.cfg); }
    get alerts() { return new alerts_api_1.AlertsApi(this.cfg); }
    get autoTopup() { return new auto_topup_api_1.AutoTopupApi(this.cfg); }
    // NOTE: cls.billing intentionally absent — BFF openapi.json currently
    // emits 0 ops under `billing`. Add a property when BFF exposes them.
    get rateCards() { return new rate_cards_api_1.RateCardsApi(this.cfg); }
    get rating() { return new rating_api_1.RatingApi(this.cfg); }
    get fxRates() { return new fx_rates_api_1.FxRatesApi(this.cfg); }
    get portal() { return new portal_api_1.PortalApi(this.cfg); }
    get subscriptions() { return new subscriptions_api_1.SubscriptionsApi(this.cfg); }
}
exports.ClsNamespace = ClsNamespace;
/** All operations that route to the Meter backend (meter.moolabs.com). */
class MeterNamespace {
    constructor(cfg) {
        this.cfg = cfg;
    }
    get events() { return new events_api_1.EventsApi(this.cfg); }
    get meters() { return new meters_api_1.MetersApi(this.cfg); }
    get customers() { return new customers_api_1.CustomersApi(this.cfg); }
    get subscriptions() { return new meter_subscriptions_api_1.MeterSubscriptionsApi(this.cfg); }
    get billing() { return new meter_billing_api_1.MeterBillingApi(this.cfg); }
    get entitlements() { return new entitlements_api_1.EntitlementsApi(this.cfg); }
    get notifications() { return new notifications_api_1.NotificationsApi(this.cfg); }
    get apps() { return new apps_api_1.AppsApi(this.cfg); }
    get portal() { return new meter_portal_api_1.MeterPortalApi(this.cfg); }
    get productCatalog() { return new product_catalog_api_1.ProductCatalogApi(this.cfg); }
    get subjects() { return new subjects_api_1.SubjectsApi(this.cfg); }
}
exports.MeterNamespace = MeterNamespace;
