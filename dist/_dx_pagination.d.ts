/**
 * Page<T> pagination — TypeScript port of _dx_pagination.py.
 *
 * Same contract as Python: list methods return a `Page<T>` that exposes
 * `.items` / `.nextCursor` / `.total` AND is iterable (across all pages,
 * lazily).
 *
 * Async-iterator instead of sync because each page fetch is an HTTP call;
 * Symbol.asyncIterator is the idiomatic JS way to express this. Customer
 * code:
 *
 *   for await (const item of page) {
 *     ...
 *   }
 */
export type FetchNext<T> = () => Promise<Page<T> | null>;
export declare class Page<T> {
    readonly items: readonly T[];
    readonly nextCursor: string | null;
    readonly total: number | null;
    private fetchNext;
    private fetched;
    constructor(opts: {
        items: T[];
        nextCursor?: string | null;
        total?: number | null;
        fetchNext?: FetchNext<T> | null;
    });
    /** Current-page length only (never triggers a fetch). Mirrors the
     *  Python __len__ semantics so `page.length` is safe to call. */
    get length(): number;
    /** Truthy when there are items on the CURRENT page (no fetch). */
    isNotEmpty(): boolean;
    /** Async iteration yields items across ALL pages, fetching subsequent
     *  pages lazily. */
    [Symbol.asyncIterator](): AsyncIterator<T>;
    toString(): string;
    /** Terminal empty page factory for "no results" responses. */
    static empty<T>(): Page<T>;
}
