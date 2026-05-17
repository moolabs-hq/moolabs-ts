/**
 * G5 in-memory ingest buffer — TypeScript port of _dx_buffer.py.
 *
 * Same shape as Python: bounded queue + background drain. JS-specific
 * differences:
 *   - No background "thread" — uses `setInterval` for periodic drain ticks.
 *     Drain callback is async; the buffer awaits it under a simple `inFlight`
 *     flag (so two drain ticks never overlap).
 *   - No locks — JS event-loop concurrency makes mutations on the queue
 *     atomic.
 *   - Graceful shutdown via `close()` returns a Promise that resolves once
 *     the final drain attempt completes or the shutdown timeout expires.
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
export const OVERFLOW_DROP_OLDEST = 'drop_oldest';
export const OVERFLOW_RAISE = 'raise';
export class IngestBufferFull extends Error {
    constructor(message) {
        super(message);
        this.name = 'IngestBufferFull';
    }
}
/** Default tunables — match Python's IngestBufferConfig + Go's
 *  DefaultIngestBufferConfig.
 *
 *  Optimized for per-customer HTTP request rate (3 req/min at 20s
 *  flush) over per-event latency. Throughput ceiling =
 *  maxSize / flushIntervalSec = 50 evt/s; customers sustaining
 *  >25 evt/s should raise maxSize via MoolabsOptions.bufferMax to
 *  keep a 2× safety margin, otherwise getStats().dropped will
 *  increment continuously under normal operation.
 *
 *  Peak memory: ~500 KB worst case (1000 events × ~500 bytes typical).
 *  Per-event latency to backend: up to flushIntervalSec (20s).
 *  Process-exit hang: up to shutdownFlushTimeoutSec (60s) when the
 *  backend is unreachable at close() time. */
export const DEFAULT_INGEST_BUFFER_CONFIG = {
    maxSize: 1000,
    flushIntervalSec: 20.0,
    shutdownFlushTimeoutSec: 60.0,
    overflow: OVERFLOW_DROP_OLDEST,
};
export class IngestBuffer {
    constructor(opts) {
        var _a, _b;
        this.queue = [];
        this.stats = {
            enqueued: 0,
            dropped: 0, // dropped on overflow
            delivered: 0,
            drainFailures: 0,
            terminalDrops: 0, // dropped: non-retryable upstream status
            abandonedOnShutdown: 0, // lost: close() timed out before final drain
        };
        this.timer = null;
        this.inFlight = false;
        this.stopped = false;
        const config = Object.assign(Object.assign({}, DEFAULT_INGEST_BUFFER_CONFIG), ((_a = opts.config) !== null && _a !== void 0 ? _a : {}));
        if (config.maxSize <= 0)
            throw new Error(`maxSize must be positive, got ${config.maxSize}`);
        if (config.flushIntervalSec <= 0)
            throw new Error(`flushIntervalSec must be positive, got ${config.flushIntervalSec}`);
        if (config.shutdownFlushTimeoutSec < 0)
            throw new Error(`shutdownFlushTimeoutSec must be non-negative, got ${config.shutdownFlushTimeoutSec}`);
        if (config.overflow !== OVERFLOW_DROP_OLDEST && config.overflow !== OVERFLOW_RAISE) {
            throw new Error(`overflow must be 'drop_oldest' or 'raise', got ${config.overflow}`);
        }
        this.drain = opts.drainCallback;
        this.config = config;
        this.logger = (_b = opts.logger) !== null && _b !== void 0 ? _b : (() => { });
    }
    /** Start the periodic drain timer. Idempotent. */
    start() {
        if (this.timer !== null)
            return;
        this.stopped = false;
        this.timer = setInterval(() => { void this.drainOnce(); }, this.config.flushIntervalSec * 1000);
    }
    /** Add events to the queue. Honors the overflow policy. */
    enqueue(events) {
        if (events.length === 0)
            return;
        const newSize = this.queue.length + events.length;
        const overflow = Math.max(0, newSize - this.config.maxSize);
        if (overflow > 0) {
            if (this.config.overflow === OVERFLOW_RAISE) {
                throw new IngestBufferFull(`ingest buffer full at ${this.queue.length} events (maxSize=${this.config.maxSize}); ${events.length} event(s) rejected`);
            }
            // drop_oldest: pop from front to make room
            const popFromExisting = Math.min(overflow, this.queue.length);
            this.queue.splice(0, popFromExisting);
            this.stats.dropped += popFromExisting;
            // If new batch itself exceeds maxSize, only the last maxSize fit
            if (events.length > this.config.maxSize) {
                const excess = events.length - this.config.maxSize;
                this.stats.dropped += excess;
                events = events.slice(excess);
            }
            // Counter already bumped above. Per-event log too — noop
            // unless customer provided a logger. Both signals available;
            // SDK never writes to console by default.
            this.logger('moolabs.ingestBuffer.overflowDropOldest', { maxSize: this.config.maxSize });
        }
        this.queue.push(...events);
        this.stats.enqueued += events.length;
    }
    /** Stop the worker and attempt one final drain. Idempotent.
     *
     *  Returns a Promise that resolves once drain completes or the shutdown
     *  timeout expires. */
    close(timeoutSec) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.stopped) {
                return;
            }
            this.stopped = true;
            if (this.timer !== null) {
                clearInterval(this.timer);
                this.timer = null;
            }
            // Best-effort final drain, bounded by timeout
            const limit = timeoutSec !== null && timeoutSec !== void 0 ? timeoutSec : this.config.shutdownFlushTimeoutSec;
            const deadline = performance.now() / 1000 + limit;
            try {
                const drainPromise = this.drainOnce();
                yield Promise.race([drainPromise, new Promise((resolve) => {
                        const remaining = Math.max(0, (deadline - performance.now() / 1000) * 1000);
                        setTimeout(() => resolve(), remaining);
                    })]);
            }
            catch (_a) {
                // swallow; final drain is best-effort
            }
            if (this.queue.length > 0) {
                // Counter (always) + per-event log (noop unless customer
                // provided one). Both signals available; SDK never writes
                // to console by default.
                this.stats.abandonedOnShutdown += this.queue.length;
                this.logger('moolabs.ingestBuffer.eventsAbandonedOnShutdown', { count: this.queue.length });
            }
        });
    }
    qsize() {
        return this.queue.length;
    }
    /** Bump the terminal-drop counter. Called by the SDK's buffer drain
     *  when a non-retryable HTTP status (auth/validation/removed-route)
     *  was returned for a batch — events are removed from the queue
     *  (retrying with the same key/body fails identically), and this
     *  counter is one of two customer-visible signals that data was lost.
     *
     *  Library does not write to console by default. Pass a logger via
     *  MoolabsOptions.logger to receive the same event as a structured
     *  log line ('moolabs.ingest_buffer.terminal_drop'); otherwise poll
     *  getStats() and diff to detect bad-key scenarios. */
    recordTerminalDrop(count) {
        this.stats.terminalDrops += count;
    }
    getStats() {
        return Object.assign({}, this.stats);
    }
    // ── internals ──
    /**
     * Pop the queue into an in-flight batch BEFORE awaiting drain, then
     * re-front any undelivered tail after drain returns.
     *
     * Pre-2026-05-16 design: snapshot + splice-after. That had a race
     * where concurrent enqueue() with drop_oldest could splice the queue
     * front (between await and post-await splice), so the post-await
     * `this.queue.splice(0, clamped)` would remove newly-enqueued events
     * instead of the snapshot. Silent data loss.
     *
     * New design: pop-everything-before-await. In-flight events are no
     * longer in the queue, so concurrent enqueue + drop_oldest can't
     * touch them. Failed drain → all events re-fronted. Partial delivery
     * → undelivered tail re-fronted. JS's single-threaded event loop
     * guarantees the pop+clear is atomic relative to enqueue().
     */
    drainOnce() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.inFlight)
                return; // never overlap two drain calls
            if (this.queue.length === 0)
                return;
            this.inFlight = true;
            try {
                // Atomic pop+clear under the event-loop's synchronous block.
                // `queue` is declared readonly (array reference can't be reassigned),
                // so we splice() out the whole contents in one synchronous call.
                // splice mutates in place and returns the removed elements — a single
                // event-loop tick, so concurrent enqueue() can't interleave.
                const batch = this.queue.splice(0, this.queue.length);
                let delivered = 0;
                let drainFailed = false;
                try {
                    delivered = yield this.drain(batch);
                }
                catch (_a) {
                    drainFailed = true;
                }
                const clamped = Math.max(0, Math.min(delivered, batch.length));
                const undelivered = batch.slice(clamped);
                // Re-front undelivered tail. New events that arrived during
                // await go AFTER the re-fronted tail.
                //   1. Splice them OUT of `queue` to capture the "new tail"
                //   2. push undelivered then new tail back into queue
                // This avoids reassigning `queue` (readonly) while preserving order.
                //
                // Chunked push (post-review M-NEW-3): `push(...veryLargeArray)`
                // expands to a function call with N arguments and hits V8's
                // ~65k arg limit, throwing RangeError. Customers who configure
                // bufferMax above ~50k can hit this with a fully-undelivered
                // batch. Chunking the push at 1024 elements keeps the per-call
                // arg count well under any JS engine's limit.
                if (undelivered.length > 0) {
                    const newTail = this.queue.splice(0, this.queue.length);
                    IngestBuffer.pushChunked(this.queue, undelivered);
                    IngestBuffer.pushChunked(this.queue, newTail);
                }
                if (drainFailed) {
                    this.stats.drainFailures += 1;
                }
                if (clamped > 0) {
                    this.stats.delivered += clamped;
                }
            }
            finally {
                this.inFlight = false;
            }
        });
    }
    /** Push `items` into `target` in chunks of up to 1024 elements per
     *  push call. The spread operator `target.push(...items)` expands to
     *  N positional args, which hits V8's ~65k arg limit on large arrays
     *  and throws RangeError. Chunked push avoids the limit at the cost
     *  of multiple push calls; negligible perf delta for any realistic
     *  buffer size. Static so concurrency tests can call it directly. */
    static pushChunked(target, items) {
        const CHUNK = 1024;
        for (let i = 0; i < items.length; i += CHUNK) {
            const end = Math.min(i + CHUNK, items.length);
            // slice() copies; push(...slice) spreads at most CHUNK args.
            target.push(...items.slice(i, end));
        }
    }
}
