/**
 * Moolabs SDK error hierarchy.
 *
 * Ported from moolabs-app_legacy/sdks/typescript-unified/src/errors.ts and
 * trimmed for Phase-1 minimal-DX scope. Targets ES6 (the openapi-generator
 * tsconfig target) so we DO NOT use the `Error(msg, {cause})` form which
 * requires ES2022.
 *
 * The wrapper at _dx_client.ts maps openapi-generator's AxiosError to these
 * types based on HTTP status. Customer code:
 *
 *   import { Moolabs, AuthenticationError, RateLimitError } from '@moolabs/sdk';
 *
 *   const client = new Moolabs({ apiKey: 'moo_live_xxx' });
 *   try {
 *     await client.billing.listInvoices();
 *   } catch (e) {
 *     if (e instanceof AuthenticationError) ...     // 401
 *     if (e instanceof RateLimitError) await sleep(e.retryAfter ?? 5);
 *   }
 */

export interface MoolabsErrorOptions {
    statusCode?: number;
    responseBody?: unknown;
    source?: 'cls' | 'metering';
}

export class MoolabsError extends Error {
    public readonly statusCode?: number;
    public readonly responseBody?: unknown;
    public readonly source?: 'cls' | 'metering';

    constructor(message: string, options?: MoolabsErrorOptions) {
        super(message);
        this.name = 'MoolabsError';
        this.statusCode = options?.statusCode;
        this.responseBody = options?.responseBody;
        this.source = options?.source;
    }
}

export class AuthenticationError extends MoolabsError {
    constructor(message = 'Authentication failed', options?: MoolabsErrorOptions) {
        super(message, { ...options, statusCode: options?.statusCode ?? 401 });
        this.name = 'AuthenticationError';
    }
}

export class AuthorizationError extends MoolabsError {
    constructor(message = 'Insufficient permissions', options?: MoolabsErrorOptions) {
        super(message, { ...options, statusCode: options?.statusCode ?? 403 });
        this.name = 'AuthorizationError';
    }
}

export class NotFoundError extends MoolabsError {
    constructor(message = 'Resource not found', options?: MoolabsErrorOptions) {
        super(message, { ...options, statusCode: options?.statusCode ?? 404 });
        this.name = 'NotFoundError';
    }
}

export interface ValidationErrorOptions extends MoolabsErrorOptions {
    fieldErrors?: Array<{ field: string; message: string }>;
}

export class ValidationError extends MoolabsError {
    public readonly fieldErrors?: Array<{ field: string; message: string }>;
    constructor(message = 'Validation failed', options?: ValidationErrorOptions) {
        super(message, { ...options, statusCode: options?.statusCode ?? 422 });
        this.name = 'ValidationError';
        this.fieldErrors = options?.fieldErrors;
    }
}

export interface RateLimitErrorOptions extends MoolabsErrorOptions {
    retryAfter?: number;
}

export class RateLimitError extends MoolabsError {
    public readonly retryAfter?: number;
    constructor(message = 'Rate limit exceeded', options?: RateLimitErrorOptions) {
        super(message, { ...options, statusCode: 429 });
        this.name = 'RateLimitError';
        this.retryAfter = options?.retryAfter;
    }
}

export class RetryableError extends MoolabsError {
    constructor(message = 'Transient error', options?: MoolabsErrorOptions) {
        super(message, options);
        this.name = 'RetryableError';
    }
}

export class NetworkError extends MoolabsError {
    constructor(message = 'Network error', options?: MoolabsErrorOptions) {
        super(message, options);
        this.name = 'NetworkError';
    }
}
