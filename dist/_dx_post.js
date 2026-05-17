"use strict";
/** Testable HTTP-post helper for the at-most-once buffer drain.
 *
 * Extracted from _dx_client.ts (round-5 — closes round-4 I-NEW-1) so
 * the fetch+keepalive+classify path is unit-testable without
 * constructing a full Moolabs client (which depends on the openapi-
 * generator-generated typed client tree).
 *
 * The helper does ONLY two things:
 *   1. POST events as JSON via fetch+keepalive.
 *   2. Classify the response into a tagged-union outcome.
 *
 * Side effects (stats bumps, logger calls, resolver outcome reporting)
 * are the caller's job — the helper is pure I/O + classification.
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.postEventsBatchAndClassify = postEventsBatchAndClassify;
const INGEST_CONTENT_TYPE = 'application/cloudevents-batch+json';
/** HTTP status codes treated as terminal (non-retryable). */
const TERMINAL_STATUSES = new Set([400, 401, 403, 404, 422]);
/** Post a batch of events and classify the outcome.
 *
 *  Never throws — network errors / unexpected fetch rejections are
 *  caught and returned as `{ type: 'network' }`. This is part of the
 *  at-most-once contract: the customer's buffer has already removed
 *  these events; throwing would just produce an unhandled rejection.
 *
 *  `fetchImpl` defaults to the global fetch (Node 18+ / browser). Tests
 *  pass a mock that returns synthetic Response shapes.
 */
function postEventsBatchAndClassify(url_1, apiKey_1, events_1) {
    return __awaiter(this, arguments, void 0, function* (url, apiKey, events, fetchImpl = fetch) {
        try {
            const resp = yield fetchImpl(url, {
                method: 'POST',
                body: JSON.stringify(events),
                keepalive: true, // browser keeps the request alive across page unload; Node ignores
                headers: {
                    'Content-Type': INGEST_CONTENT_TYPE,
                    'Authorization': `Bearer ${apiKey}`,
                },
            });
            if (resp.ok) {
                return { type: 'success' };
            }
            if (TERMINAL_STATUSES.has(resp.status)) {
                return { type: 'terminal', status: resp.status };
            }
            return { type: 'transient', status: resp.status };
        }
        catch (err) {
            return { type: 'network', err };
        }
    });
}
