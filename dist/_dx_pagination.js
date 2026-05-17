"use strict";
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
var __await = (this && this.__await) || function (v) { return this instanceof __await ? (this.v = v, this) : new __await(v); }
var __asyncGenerator = (this && this.__asyncGenerator) || function (thisArg, _arguments, generator) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var g = generator.apply(thisArg, _arguments || []), i, q = [];
    return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function () { return this; }, i;
    function awaitReturn(f) { return function (v) { return Promise.resolve(v).then(f, reject); }; }
    function verb(n, f) { if (g[n]) { i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; if (f) i[n] = f(i[n]); } }
    function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
    function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r); }
    function fulfill(value) { resume("next", value); }
    function reject(value) { resume("throw", value); }
    function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Page = void 0;
class Page {
    constructor(opts) {
        var _a, _b, _c;
        this.fetched = false;
        this.items = [...opts.items];
        this.nextCursor = (_a = opts.nextCursor) !== null && _a !== void 0 ? _a : null;
        this.total = (_b = opts.total) !== null && _b !== void 0 ? _b : null;
        this.fetchNext = (_c = opts.fetchNext) !== null && _c !== void 0 ? _c : null;
    }
    /** Current-page length only (never triggers a fetch). Mirrors the
     *  Python __len__ semantics so `page.length` is safe to call. */
    get length() {
        return this.items.length;
    }
    /** Truthy when there are items on the CURRENT page (no fetch). */
    isNotEmpty() {
        return this.items.length > 0;
    }
    /** Async iteration yields items across ALL pages, fetching subsequent
     *  pages lazily. */
    [Symbol.asyncIterator]() {
        return __asyncGenerator(this, arguments, function* _a() {
            for (const item of this.items) {
                yield yield __await(item);
            }
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            let current = this;
            while (true) {
                if (current.nextCursor === null)
                    return yield __await(void 0);
                if (current.fetchNext === null)
                    return yield __await(void 0);
                if (current.fetched)
                    return yield __await(void 0);
                current.fetched = true;
                const fn = current.fetchNext;
                current.fetchNext = null; // release ref for GC
                const next = yield __await(fn());
                if (next === null)
                    return yield __await(void 0);
                for (const item of next.items) {
                    yield yield __await(item);
                }
                current = next;
            }
        });
    }
    toString() {
        return `Page(items=<${this.items.length}>, nextCursor=${JSON.stringify(this.nextCursor)}, total=${this.total})`;
    }
    /** Terminal empty page factory for "no results" responses. */
    static empty() {
        return new Page({ items: [], nextCursor: null, total: 0, fetchNext: null });
    }
}
exports.Page = Page;
