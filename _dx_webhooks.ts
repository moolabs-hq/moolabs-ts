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

import { createHmac, timingSafeEqual } from 'crypto';

export interface WebhookVerifierConfig {
    secret: string;
}

const SUPPORTED_ALGORITHMS = ['sha256', 'sha512'] as const;
type SupportedAlgorithm = typeof SUPPORTED_ALGORITHMS[number];

function isSupportedAlgorithm(algo: string): algo is SupportedAlgorithm {
    return (SUPPORTED_ALGORITHMS as readonly string[]).includes(algo);
}

export class WebhookVerifier {
    private readonly secret: Buffer;

    constructor(config: WebhookVerifierConfig) {
        if (!config.secret) {
            throw new Error('WebhookVerifier: secret cannot be empty');
        }
        this.secret = Buffer.from(config.secret, 'utf-8');
    }

    /**
     * Verify a payload's signature against the secret.
     *
     * @param payload Raw webhook payload bytes (NOT decoded JSON).
     * @param signature Hex-encoded signature from the webhook header.
     * @param algorithm Hash algorithm — one of `sha256` or `sha512`.
     */
    verify(
        payload: Buffer | string,
        signature: string,
        algorithm: string = 'sha256',
    ): boolean {
        if (!isSupportedAlgorithm(algorithm)) {
            throw new Error(
                `unsupported algorithm: ${algorithm} (expected one of ${SUPPORTED_ALGORITHMS.join(', ')})`,
            );
        }

        const payloadBuf = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
        const expected = createHmac(algorithm, this.secret).update(payloadBuf).digest('hex');

        // Constant-time compare; require equal lengths up front to avoid
        // timingSafeEqual throwing on mismatched lengths.
        if (expected.length !== signature.length) {
            return false;
        }
        return timingSafeEqual(Buffer.from(expected, 'utf-8'), Buffer.from(signature, 'utf-8'));
    }

    /**
     * Verify using a signature header.
     *
     * Header format: `"sha256=<hex>"` or just `"<hex>"` (sha256 default).
     */
    verifyHeader(payload: Buffer | string, headerValue: string): boolean {
        if (headerValue.includes('=')) {
            const eq = headerValue.indexOf('=');
            const algorithm = headerValue.slice(0, eq);
            const signature = headerValue.slice(eq + 1);
            return this.verify(payload, signature, algorithm);
        }
        return this.verify(payload, headerValue, 'sha256');
    }
}
