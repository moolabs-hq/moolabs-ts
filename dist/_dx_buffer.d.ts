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
export declare const OVERFLOW_DROP_OLDEST = "drop_oldest";
export declare const OVERFLOW_RAISE = "raise";
export type OverflowPolicy = typeof OVERFLOW_DROP_OLDEST | typeof OVERFLOW_RAISE;
export declare class IngestBufferFull extends Error {
    constructor(message: string);
}
export interface IngestBufferConfig {
    /** Max events the queue holds before overflow policy fires. */
    readonly maxSize: number;
    /** Background poll interval, seconds. */
    readonly flushIntervalSec: number;
    /** close() blocks at most this long flushing pending events. */
    readonly shutdownFlushTimeoutSec: number;
    /** Overflow policy. */
    readonly overflow: OverflowPolicy;
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
export declare const DEFAULT_INGEST_BUFFER_CONFIG: IngestBufferConfig;
/** Drain callback: takes a batch of events, returns the count it
 *  successfully delivered (from the front of the batch). Returning fewer
 *  than the batch size keeps the unsent tail queued; rejecting/throwing
 *  leaves all events queued. */
export type DrainCallback<T> = (events: T[]) => Promise<number>;
export declare class IngestBuffer<T> {
    private readonly drain;
    private readonly config;
    private readonly queue;
    private readonly stats;
    private timer;
    private inFlight;
    private stopped;
    private readonly logger;
    constructor(opts: {
        drainCallback: DrainCallback<T>;
        config?: Partial<IngestBufferConfig>;
        /** Optional per-event diagnostic logger. Undefined = noop (no
         *  output). Propagated automatically from MoolabsOptions.logger
         *  in normal construction. */
        logger?: (msg: string, fields: Record<string, unknown>) => void;
    });
    /** Start the periodic drain timer. Idempotent. */
    start(): void;
    /** Add events to the queue. Honors the overflow policy. */
    enqueue(events: T[]): void;
    /** Stop the worker and attempt one final drain. Idempotent.
     *
     *  Returns a Promise that resolves once drain completes or the shutdown
     *  timeout expires. */
    close(timeoutSec?: number): Promise<void>;
    qsize(): number;
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
    recordTerminalDrop(count: number): void;
    getStats(): typeof this.stats;
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
    private drainOnce;
    /** Push `items` into `target` in chunks of up to 1024 elements per
     *  push call. The spread operator `target.push(...items)` expands to
     *  N positional args, which hits V8's ~65k arg limit on large arrays
     *  and throws RangeError. Chunked push avoids the limit at the cost
     *  of multiple push calls; negligible perf delta for any realistic
     *  buffer size. Static so concurrency tests can call it directly. */
    static pushChunked<T>(target: T[], items: readonly T[]): void;
}
