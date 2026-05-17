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

const INGEST_CONTENT_TYPE = 'application/cloudevents-batch+json';

/** Classified outcome of one drain HTTP attempt. */
export type DrainOutcome =
    | { type: 'success' }
    | { type: 'terminal'; status: number }     // 400/401/403/404/422 — no retry
    | { type: 'transient'; status: number }    // 5xx, 429 — retryable IF buffer kept events
    | { type: 'network'; err: unknown };       // fetch threw (DNS, abort, etc.)

/** HTTP status codes treated as terminal (non-retryable). */
const TERMINAL_STATUSES = new Set<number>([400, 401, 403, 404, 422]);

/** Minimal fetch signature — accepts either the global fetch or a
 *  test-supplied mock. The full fetch type is too restrictive for
 *  Vitest mocks; this loose shape captures what we actually need. */
export type FetchLike = (
    url: string,
    init?: { method?: string; body?: string; keepalive?: boolean; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number }>;

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
export async function postEventsBatchAndClassify(
    url: string,
    apiKey: string,
    events: unknown[],
    fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<DrainOutcome> {
    try {
        const resp = await fetchImpl(url, {
            method: 'POST',
            body: JSON.stringify(events),
            keepalive: true,   // browser keeps the request alive across page unload; Node ignores
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
    } catch (err) {
        return { type: 'network', err };
    }
}
