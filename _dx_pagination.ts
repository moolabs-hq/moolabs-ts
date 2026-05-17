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


export class Page<T> {
    public readonly items: readonly T[];
    public readonly nextCursor: string | null;
    public readonly total: number | null;

    private fetchNext: FetchNext<T> | null;
    private fetched = false;

    constructor(opts: {
        items: T[];
        nextCursor?: string | null;
        total?: number | null;
        fetchNext?: FetchNext<T> | null;
    }) {
        this.items = [...opts.items];
        this.nextCursor = opts.nextCursor ?? null;
        this.total = opts.total ?? null;
        this.fetchNext = opts.fetchNext ?? null;
    }

    /** Current-page length only (never triggers a fetch). Mirrors the
     *  Python __len__ semantics so `page.length` is safe to call. */
    get length(): number {
        return this.items.length;
    }

    /** Truthy when there are items on the CURRENT page (no fetch). */
    isNotEmpty(): boolean {
        return this.items.length > 0;
    }

    /** Async iteration yields items across ALL pages, fetching subsequent
     *  pages lazily. */
    async *[Symbol.asyncIterator](): AsyncIterator<T> {
        for (const item of this.items) {
            yield item;
        }
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        let current: Page<T> = this;
        while (true) {
            if (current.nextCursor === null) return;
            if (current.fetchNext === null) return;
            if (current.fetched) return;
            current.fetched = true;
            const fn = current.fetchNext;
            current.fetchNext = null;  // release ref for GC
            const next = await fn();
            if (next === null) return;
            for (const item of next.items) {
                yield item;
            }
            current = next;
        }
    }

    toString(): string {
        return `Page(items=<${this.items.length}>, nextCursor=${JSON.stringify(this.nextCursor)}, total=${this.total})`;
    }

    /** Terminal empty page factory for "no results" responses. */
    static empty<T>(): Page<T> {
        return new Page<T>({ items: [], nextCursor: null, total: 0, fetchNext: null });
    }
}
