/**
 * Webhook signature verification (HMAC).
 *
 * Symmetric to sdks/dx/python/moolabs/_dx_webhooks.py. Customer integrations
 * that receive Moolabs webhooks use this to verify a payload was sent by
 * Moolabs (not a forgery).
 *
 * Customer code:
 *
 *   import { WebhookVerifier } from '@moolabs/sdk';
 *
 *   const verifier = new WebhookVerifier({ secret: 'whsec_xxx' });
 *
 *   // In your HTTP handler:
 *   const rawBody = req.rawBody;
 *   const sig = req.headers['x-moolabs-signature'];  // "sha256=abc123..."
 *   if (!verifier.verifyHeader(rawBody, sig)) {
 *     return res.status(401).send('invalid signature');
 *   }
 *
 * Implementation note: uses Node's `crypto` module. Browser usage is NOT
 * supported (browsers can use the Web Crypto API but the shape differs).
 */
export interface WebhookVerifierConfig {
    secret: string;
}
export declare class WebhookVerifier {
    private readonly secret;
    constructor(config: WebhookVerifierConfig);
    /**
     * Verify a payload's signature against the secret.
     *
     * @param payload Raw webhook payload bytes (NOT decoded JSON).
     * @param signature Hex-encoded signature from the webhook header.
     * @param algorithm Hash algorithm — one of `sha256` or `sha512`.
     */
    verify(payload: Buffer | string, signature: string, algorithm?: string): boolean;
    /**
     * Verify using a signature header.
     *
     * Header format: `"sha256=<hex>"` or just `"<hex>"` (sha256 default).
     */
    verifyHeader(payload: Buffer | string, headerValue: string): boolean;
}
