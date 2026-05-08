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
export declare class MoolabsError extends Error {
    readonly statusCode?: number;
    readonly responseBody?: unknown;
    readonly source?: 'cls' | 'metering';
    constructor(message: string, options?: MoolabsErrorOptions);
}
export declare class AuthenticationError extends MoolabsError {
    constructor(message?: string, options?: MoolabsErrorOptions);
}
export declare class AuthorizationError extends MoolabsError {
    constructor(message?: string, options?: MoolabsErrorOptions);
}
export declare class NotFoundError extends MoolabsError {
    constructor(message?: string, options?: MoolabsErrorOptions);
}
export interface ValidationErrorOptions extends MoolabsErrorOptions {
    fieldErrors?: Array<{
        field: string;
        message: string;
    }>;
}
export declare class ValidationError extends MoolabsError {
    readonly fieldErrors?: Array<{
        field: string;
        message: string;
    }>;
    constructor(message?: string, options?: ValidationErrorOptions);
}
export interface RateLimitErrorOptions extends MoolabsErrorOptions {
    retryAfter?: number;
}
export declare class RateLimitError extends MoolabsError {
    readonly retryAfter?: number;
    constructor(message?: string, options?: RateLimitErrorOptions);
}
export declare class RetryableError extends MoolabsError {
    constructor(message?: string, options?: MoolabsErrorOptions);
}
export declare class NetworkError extends MoolabsError {
    constructor(message?: string, options?: MoolabsErrorOptions);
}
