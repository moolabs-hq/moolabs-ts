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
export class MoolabsError extends Error {
    constructor(message, options) {
        super(message);
        this.name = 'MoolabsError';
        this.statusCode = options === null || options === void 0 ? void 0 : options.statusCode;
        this.responseBody = options === null || options === void 0 ? void 0 : options.responseBody;
        this.source = options === null || options === void 0 ? void 0 : options.source;
    }
}
export class AuthenticationError extends MoolabsError {
    constructor(message = 'Authentication failed', options) {
        var _a;
        super(message, Object.assign(Object.assign({}, options), { statusCode: (_a = options === null || options === void 0 ? void 0 : options.statusCode) !== null && _a !== void 0 ? _a : 401 }));
        this.name = 'AuthenticationError';
    }
}
export class AuthorizationError extends MoolabsError {
    constructor(message = 'Insufficient permissions', options) {
        var _a;
        super(message, Object.assign(Object.assign({}, options), { statusCode: (_a = options === null || options === void 0 ? void 0 : options.statusCode) !== null && _a !== void 0 ? _a : 403 }));
        this.name = 'AuthorizationError';
    }
}
export class NotFoundError extends MoolabsError {
    constructor(message = 'Resource not found', options) {
        var _a;
        super(message, Object.assign(Object.assign({}, options), { statusCode: (_a = options === null || options === void 0 ? void 0 : options.statusCode) !== null && _a !== void 0 ? _a : 404 }));
        this.name = 'NotFoundError';
    }
}
export class ValidationError extends MoolabsError {
    constructor(message = 'Validation failed', options) {
        var _a;
        super(message, Object.assign(Object.assign({}, options), { statusCode: (_a = options === null || options === void 0 ? void 0 : options.statusCode) !== null && _a !== void 0 ? _a : 422 }));
        this.name = 'ValidationError';
        this.fieldErrors = options === null || options === void 0 ? void 0 : options.fieldErrors;
    }
}
export class RateLimitError extends MoolabsError {
    constructor(message = 'Rate limit exceeded', options) {
        super(message, Object.assign(Object.assign({}, options), { statusCode: 429 }));
        this.name = 'RateLimitError';
        this.retryAfter = options === null || options === void 0 ? void 0 : options.retryAfter;
    }
}
export class RetryableError extends MoolabsError {
    constructor(message = 'Transient error', options) {
        super(message, options);
        this.name = 'RetryableError';
    }
}
export class NetworkError extends MoolabsError {
    constructor(message = 'Network error', options) {
        super(message, options);
        this.name = 'NetworkError';
    }
}
