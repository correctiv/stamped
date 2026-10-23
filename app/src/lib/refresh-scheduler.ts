/**
 * Which panes of the window a change makes stale, and when to reload them.
 *
 * A run that ends (import, key lookup, re-verification) used to reload every pane at once, and
 * two runs ending in the same second reloaded everything twice. Here a change names the panes it
 * touched, bursts are merged into one set, and the reload starts once the burst has been quiet
 * for a moment. Only one reload is out at a time; what is asked for meanwhile waits for it.
 * Timers are injected so a test needs no main loop.
 */

export const PANES = ['sidebar', 'list', 'keys', 'overview', 'people', 'timeline', 'backfill'] as const;
export type Pane = (typeof PANES)[number];

/** Panes that show a verdict or a key: all a key lookup or a re-verification can change. */
export const VERDICT_PANES: readonly Pane[] = ['sidebar', 'list', 'keys', 'overview'];

/** Panes that read the address table, which only the people backfill writes. */
export const PEOPLE_PANES: readonly Pane[] = ['people', 'timeline'];

export interface RefreshSchedulerOptions {
    /** Quiet time before a reload starts, in milliseconds. */
    readonly delayMs: number;
    /**
     * Reload these panes. Resolves with the panes it did not get to, so they are asked for again;
     * a run that stopped because the case changed returns none.
     */
    readonly run: (panes: ReadonlySet<Pane>) => Promise<readonly Pane[]>;
    readonly setTimer: (callback: () => void, delayMs: number) => unknown;
    readonly clearTimer: (timer: unknown) => void;
}

export class RefreshScheduler {
    private readonly delayMs: number;
    private readonly runPanes: (panes: ReadonlySet<Pane>) => Promise<readonly Pane[]>;
    private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
    private readonly clearTimer: (timer: unknown) => void;
    private dirty = new Set<Pane>();
    private timer: unknown = undefined;
    private running = false;
    private epoch = 0;

    constructor(options: RefreshSchedulerOptions) {
        this.delayMs = options.delayMs;
        this.runPanes = options.run;
        this.setTimer = options.setTimer;
        this.clearTimer = options.clearTimer;
    }

    /** Panes waiting for a reload. */
    get pending(): ReadonlySet<Pane> {
        return this.dirty;
    }

    /** Mark panes stale. Every call restarts the quiet time; a reload in flight is not touched. */
    request(panes: readonly Pane[]): void {
        if (panes.length === 0) return;
        for (const pane of panes) this.dirty.add(pane);
        this.arm();
    }

    /** Forget everything asked for: the case it was asked about is gone. */
    cancel(): void {
        this.epoch++;
        this.dirty = new Set();
        this.disarm();
    }

    private arm(): void {
        this.disarm();
        if (this.running) return; // the end of the running reload arms again
        this.timer = this.setTimer(() => {
            this.timer = undefined;
            void this.start();
        }, this.delayMs);
    }

    private disarm(): void {
        if (this.timer === undefined) return;
        this.clearTimer(this.timer);
        this.timer = undefined;
    }

    private async start(): Promise<void> {
        if (this.running || this.dirty.size === 0) return;
        const panes = this.dirty;
        this.dirty = new Set();
        const epoch = this.epoch;
        this.running = true;
        try {
            const left = await this.runPanes(panes);
            if (epoch === this.epoch) for (const pane of left) this.dirty.add(pane);
        } catch {
            // A failed reload leaves the panes as they were; the next change asks again.
        } finally {
            this.running = false;
        }
        if (this.dirty.size > 0) this.arm();
    }
}

/** The panes a finished background run leaves stale. `import` rewrites everything. */
export function panesAfterRun(kind: string): readonly Pane[] {
    switch (kind) {
        case 'keys':
        case 'reverify':
            return VERDICT_PANES;
        case 'people':
            return PEOPLE_PANES;
        case 'semantic':
            return ['list'];
        default:
            return PANES;
    }
}
