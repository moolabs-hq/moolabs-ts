# Moolabs TypeScript SDK

Unified TypeScript / JavaScript SDK for the Moolabs platform. One package, one client, one auth flow — covers both billing (CLS) and usage (Meter) operations.

```typescript
import { Moolabs } from '@moolabs/sdk';

const client = new Moolabs({ apiKey: 'moo_live_...' });

// Billing / wallets / grants — routed to api.moolabs.com (CLS)
const wallet = await client.cls.wallets.createWallet({...});
const grants = await client.cls.grants.listGrants({...});

// Usage events / meters / subscriptions — routed to meter.moolabs.com
await client.meter.events.ingestEvents([...]);
const meters = await client.meter.meters.listMeters();
```

## Install

```bash
npm install @moolabs/sdk
# or
pnpm add @moolabs/sdk
# or
yarn add @moolabs/sdk
```

Targets Node 18+ and modern browsers (ESM + CJS dual-build).

## Authentication

Generate an API key in your Moolabs dashboard. The same key authenticates against both backends.

```typescript
import { Moolabs } from '@moolabs/sdk';

const client = new Moolabs({ apiKey: 'moo_live_...' });
```

For staging or private deployments, override the base URLs:

```typescript
const client = new Moolabs({
  apiKey: 'moo_test_...',
  clsBaseUrl: 'https://staging-api.moolabs.com',
  meterBaseUrl: 'https://staging-meter.moolabs.com',
});
```

## Two namespaces

### `client.cls.*` — CLS / billing operations

Routes calls to `https://api.moolabs.com`.

| Namespace | Purpose |
|---|---|
| `client.cls.wallets` | Wallet lifecycle, balances, transfers |
| `client.cls.grants` | Credit grants and grant policies |
| `client.cls.ledger` | Ledger entries, transfers, audit |
| `client.cls.alerts` | Balance / threshold alert subscriptions |
| `client.cls.autoTopup` | Auto-topup rules |
| `client.cls.rateCards` | Rate card definitions |
| `client.cls.rating` | Rate-event scoring |
| `client.cls.fxRates` | FX rate lookups |
| `client.cls.portal` | Portal token issuance (BFF flavor) |
| `client.cls.subscriptions` | Subscription bindings (BFF flavor) |

### `client.meter.*` — Usage / metering operations

Routes calls to `https://meter.moolabs.com`.

| Namespace | Purpose |
|---|---|
| `client.meter.events` | Ingest usage events |
| `client.meter.meters` | Define and query meters |
| `client.meter.customers` | Customer entity management |
| `client.meter.subscriptions` | Meter-side subscriptions |
| `client.meter.billing` | Meter-side billing primitives |
| `client.meter.entitlements` | Entitlement checks |
| `client.meter.notifications` | Webhook + notification channels |
| `client.meter.apps` | App registrations |
| `client.meter.portal` | Portal tokens (Meter flavor) |
| `client.meter.productCatalog` | Product catalog |
| `client.meter.subjects` | Subjects (e.g., users, accounts) |

## Quickstart — typical usage flows

### Ingest usage events

```typescript
await client.meter.events.ingestEvents([
  {
    id: 'evt_unique_id',
    type: 'api.request',
    subject: 'user_42',
    time: '2026-01-15T10:30:00Z',
    data: { endpoint: '/v1/predict', tokens: 1500 },
  },
]);
```

### Check entitlement

```typescript
const result = await client.meter.entitlements.checkEntitlement({
  subject: 'user_42',
  feature: 'ai-credits',
});

if (result.granted) {
  // serve the request
}
```

### Create a wallet + grant credits

```typescript
const wallet = await client.cls.wallets.createWallet({
  tenantId: 'tenant_xyz',
  poolId: 'pool_abc',
  ownerType: 'USER',
  ownerId: 'user_42',
});

await client.cls.grants.createGrant({
  walletId: wallet.id,
  amount: '100.00',
  expiresAt: '2026-12-31T23:59:59Z',
});
```

## Error handling

All errors extend `MoolabsError`. Specific subclasses for HTTP status families:

```typescript
import {
  Moolabs,
  MoolabsError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
  RateLimitError,
  RetryableError,
} from '@moolabs/sdk';

const client = new Moolabs({ apiKey: 'moo_live_...' });

try {
  const wallet = await client.cls.wallets.createWallet({...});
} catch (err) {
  if (err instanceof AuthenticationError) {
    // 401 — key invalid/expired
  } else if (err instanceof ValidationError) {
    // 422 — field-level validation
    console.error(err.errors);
  } else if (err instanceof RateLimitError) {
    // 429 — back off and retry
  } else if (err instanceof RetryableError) {
    // 5xx that's safe to retry
  } else if (err instanceof MoolabsError) {
    // any other API error
  } else {
    throw err; // not a Moolabs error
  }
}
```

## Webhook signature verification

```typescript
import { WebhookVerifier } from '@moolabs/sdk';

const verifier = new WebhookVerifier({ signingSecret: 'whsec_...' });

// Throws on tampering; returns parsed body on success.
const event = verifier.verify({
  body: rawBodyString,
  signature: req.headers['x-moolabs-signature'] as string,
});
```

## TypeScript types

All operations are fully typed via the generated OpenAPI types. Request and response shapes match the spec exactly.

```typescript
import { Moolabs, type WalletResponse } from '@moolabs/sdk';

const client = new Moolabs({ apiKey: 'moo_live_...' });

const wallet: WalletResponse = await client.cls.wallets.createWallet({...});
```

## Source + issues

- Source mirror: https://github.com/moolabs-hq/moolabs-ts
- Issues + feature requests: https://github.com/moolabs-hq/moolabs-ts/issues

This package is auto-generated from the Moolabs OpenAPI specs on every release. Direct edits to the mirror repo will be overwritten on next publish.
