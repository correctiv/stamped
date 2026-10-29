/**
 * The paging bookkeeping behind the message list, with no widget in it.
 *
 * The window shows a list that can be hundreds of thousands of rows long and fetches it a page at
 * a time. What decides whether a fetch may start, whether its answer is still wanted, and when the
 * list has ended used to be five loose fields in `window.ts`; here it is one object a test can
 * drive. The page itself and the model it lands in are the caller's: `fetch` returns rows,
 * `onPage` puts them somewhere.
 */

export interface PagedListOptions<T> {
    /** Rows a full page holds; a shorter page ends the list. */
    readonly pageSize: number;
    /** Where a page goes. `replace` is true for the first page of a fresh list. */
    readonly onPage: (page: readonly T[], replace: boolean) => void;
}

export class PagedList<T> {
    private generation = 0;
    private loading = false;
    private more = true;
    private fetched = 0;
    private total = 0;
    /** Whether the last page came back full — without it a revised total cannot say `hasMore`. */
    private lastFull = true;
    private readonly pageSize: number;
    private readonly onPage: (page: readonly T[], replace: boolean) => void;

    constructor(options: PagedListOptions<T>) {
        this.pageSize = options.pageSize;
        this.onPage = options.onPage;
    }

    /** Rows delivered so far. */
    get loaded(): number {
        return this.fetched;
    }

    get hasMore(): boolean {
        return this.more;
    }

    get isLoading(): boolean {
        return this.loading;
    }

    /**
     * Start a new list of `total` rows. Whatever fetch is still out belongs to the old list and
     * its answer is dropped when it lands.
     *
     * `total` is OPTIONAL because counting can be the slower half: for a text query the count is
     * a full search of its own, and waiting for it before fetching the first page left the list
     * empty while its first page was already cheap to get. Without a total the list fetches
     * until a short page ends it, and {@link setTotal} fills the number in when it arrives.
     */
    reset(total?: number): void {
        this.generation++;
        this.loading = false;
        this.fetched = 0;
        this.lastFull = true;
        this.total = total ?? Number.POSITIVE_INFINITY;
        this.more = this.total > 0;
    }

    /** The row count, once the count has answered. The pages already delivered stay. */
    setTotal(total: number): void {
        this.total = total;
        this.more = this.lastFull && this.fetched < total;
    }

    /**
     * Fetch the next page, unless there is none or one is already out.
     *
     * Returns true when a page was delivered. `loading` is set before the await so a scroll
     * handler firing again cannot ask for the same offset twice.
     */
    async loadMore(fetch: (offset: number) => Promise<readonly T[]>): Promise<boolean> {
        if (this.loading || !this.more) return false;
        const generation = this.generation;
        const offset = this.fetched;
        this.loading = true;
        let page: readonly T[];
        try {
            page = await fetch(offset);
        } finally {
            if (generation === this.generation) this.loading = false;
        }
        if (generation !== this.generation) return false;
        this.onPage(page, offset === 0);
        this.fetched += page.length;
        this.lastFull = page.length === this.pageSize;
        this.more = this.lastFull && this.fetched < this.total;
        return true;
    }

    /** Declare the list complete as it stands — a merged result ends the paging. */
    finish(loaded: number): void {
        this.generation++;
        this.loading = false;
        this.more = false;
        this.lastFull = false;
        this.fetched = loaded;
    }
}

/**
 * Whether the scroll position is close enough to the end to want the next page.
 *
 * `margin` is in the adjustment's units (pixels): a page is fetched while the person still has
 * that much list left, so the fetch hides behind the scrolling instead of after it.
 */
export function nearEnd(value: number, pageSize: number, upper: number, margin: number): boolean {
    return value + pageSize >= upper - margin;
}
