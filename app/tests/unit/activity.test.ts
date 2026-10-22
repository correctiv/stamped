/**
 * The task registry behind the header bar's status button, its import watcher, and the view
 * models for the button and the popover rows. All synthetic numbers; no case folder involved.
 */

import { describe, expect, it } from '@gjsify/unit';
import type { ImportStatus } from '@stamped/store';

import {
    ActivityRegistry,
    ImportWatcher,
    importRunning,
    type ImportActivity,
    type KeysActivity,
} from '../../src/lib/activity.ts';
import { buttonView, rowView } from '../../src/gui/view/activity.ts';

function status(over: Partial<ImportStatus> = {}): ImportStatus {
    return {
        version: 1,
        state: 'running',
        pid: process.pid,
        startedAt: '2026-10-21T10:00:00.000Z',
        updatedAt: new Date().toISOString(),
        sources: ['/leak'],
        mailbox: 'ada@example.com',
        mailsDone: 250,
        mailsTotal: 1000,
        bytesRead: 250,
        bytesTotal: 1000,
        rate: 25,
        bytesRate: 2500,
        eta: 150,
        errors: 0,
        ...over,
    };
}

const keys = (over: Partial<KeysActivity> = {}): KeysActivity => ({
    kind: 'keys',
    channel: 'dns',
    done: 0,
    total: 10,
    found: 0,
    notFound: 0,
    errors: 0,
    ...over,
});

const importData = (over: Partial<ImportStatus> = {}, own = true): ImportActivity => {
    const s = status(over);
    return { kind: 'import', status: s, orphaned: s.state === 'running' && !importRunning(s), own };
};

export default async () => {
    await describe('activity registry', async () => {
        await it('keeps one task per kind and notifies on every change', () => {
            const registry = new ActivityRegistry();
            let calls = 0;
            const stop = registry.subscribe(() => calls++);
            registry.start(keys());
            registry.update(keys({ done: 5, found: 3, notFound: 2 }));
            expect(registry.list().length).toBe(1);
            expect(registry.get('keys')?.fraction).toBe(0.5);
            expect(calls).toBe(2);
            stop();
            registry.dismiss('keys');
            expect(calls).toBe(2);
            expect(registry.list().length).toBe(0);
        });

        await it('keeps a finished task until it is dismissed, and ignores late updates', () => {
            const registry = new ActivityRegistry();
            registry.start(keys());
            registry.finish(keys({ done: 10, found: 8, notFound: 2 }));
            registry.update(keys({ done: 1 }));
            const task = registry.get('keys');
            expect(task?.state).toBe('done');
            expect(task?.fraction).toBe(1);
            expect((task!.data as KeysActivity).done).toBe(10);
            registry.dismiss('keys');
            expect(registry.get('keys')).toBe(undefined);
        });

        await it('records a failure with its reason', () => {
            const registry = new ActivityRegistry();
            registry.start(keys());
            registry.fail(keys({ done: 3 }), 'offline');
            expect(registry.get('keys')?.state).toBe('failed');
            expect(registry.get('keys')?.reason).toBe('offline');
            expect(registry.summary().failed).toBe(1);
            expect(registry.summary().running).toBe(0);
        });

        await it('summarises a single running task with its fraction', () => {
            const registry = new ActivityRegistry();
            registry.start(keys({ done: 2 }));
            registry.update(keys({ done: 2 }));
            expect(registry.summary().fraction).toBe(0.2);
            registry.start({ kind: 'people', processed: 0 });
            expect(registry.summary().running).toBe(2);
            expect(registry.summary().fraction).toBe(undefined);
        });
    });

    await describe('import watcher', async () => {
        await it('shows a live run, updates it, and reports its end once', () => {
            const registry = new ActivityRegistry();
            const watcher = new ImportWatcher(registry);
            expect(watcher.poll(status(), true)).toBe(undefined);
            expect(registry.get('import')?.state).toBe('running');
            watcher.poll(status({ bytesRead: 500 }), true);
            expect(registry.get('import')?.fraction).toBe(0.5);
            const ended = watcher.poll(status({ state: 'finished', bytesRead: 1000 }), true);
            expect(ended?.status.state).toBe('finished');
            expect(registry.get('import')?.state).toBe('done');
            expect(watcher.poll(status({ state: 'finished' }), true)).toBe(undefined);
        });

        await it('does not show an old result nobody saw start', () => {
            const registry = new ActivityRegistry();
            const watcher = new ImportWatcher(registry);
            expect(watcher.poll(status({ state: 'finished' }), false)).toBe(undefined);
            expect(registry.list().length).toBe(0);
        });

        await it('reports a run the window started even if it never saw it running', () => {
            const registry = new ActivityRegistry();
            const watcher = new ImportWatcher(registry);
            const old = status({ state: 'finished', startedAt: '2026-10-21T09:00:00.000Z' });
            watcher.expect('2026-10-21T10:00:00.000Z');
            expect(watcher.poll(old, false)).toBe(undefined);
            const ended = watcher.poll(status({ state: 'finished' }), false);
            expect(ended?.status.state).toBe('finished');
            expect(registry.get('import')?.state).toBe('done');
            expect(watcher.poll(status({ state: 'finished' }), false)).toBe(undefined);
        });

        await it('shows an interrupted run as failed, and does not bring a dismissed one back', () => {
            const registry = new ActivityRegistry();
            const watcher = new ImportWatcher(registry);
            const dead = status({ pid: 2 ** 22 + 12345 });
            expect(watcher.poll(dead, false)?.orphaned).toBe(true);
            expect(registry.get('import')?.state).toBe('failed');
            registry.dismiss('import');
            expect(watcher.poll(dead, false)).toBe(undefined);
            expect(registry.get('import')).toBe(undefined);
        });
    });

    await describe('status button and rows', async () => {
        await it('is calm when idle, a spinner while busy, a circle with progress', () => {
            const registry = new ActivityRegistry();
            expect(buttonView(registry.list()).mode).toBe('idle');
            registry.start({ kind: 'people', processed: 0 });
            expect(buttonView(registry.list()).mode).toBe('busy');
            registry.start(keys({ done: 5 }));
            expect(buttonView(registry.list()).mode).toBe('busy');
            registry.finish({ kind: 'people', processed: 3 });
            const view = buttonView(registry.list());
            expect(view.mode).toBe('progress');
            expect(view.fraction).toBe(0.5);
            expect(view.tooltip.includes('5 of 10')).toBe(true);
        });

        await it('flags a failed task with the error dot', () => {
            const registry = new ActivityRegistry();
            registry.start(keys());
            registry.fail(keys());
            const view = buttonView(registry.list());
            expect(view.error).toBe(true);
            expect(view.mode).toBe('idle');
        });

        await it('offers Cancel only for an import this window started', () => {
            const registry = new ActivityRegistry();
            registry.start(importData({}, true));
            expect(rowView(registry.get('import')!).cancellable).toBe(true);
            registry.start(importData({}, false));
            expect(rowView(registry.get('import')!).cancellable).toBe(false);
        });

        await it('shows the import by bytes, with mailbox, rate and time left', () => {
            const registry = new ActivityRegistry();
            registry.start(importData());
            const row = rowView(registry.get('import')!);
            expect(row.subtitle).toBe('25% · ada@example.com');
            expect(row.fraction).toBe(0.25);
            expect(row.stats.endsWith('about 3 min left')).toBe(true);
            expect(row.details.length > 0).toBe(true);
        });

        await it('tallies a key lookup, with errors only when there are some', () => {
            const registry = new ActivityRegistry();
            registry.start(keys({ done: 4, found: 3, notFound: 1 }));
            expect(rowView(registry.get('keys')!).stats).toBe('3 found · 1 not found');
            registry.update(keys({ done: 5, found: 3, notFound: 1, errors: 1 }));
            expect(rowView(registry.get('keys')!).stats.endsWith('1 error')).toBe(true);
        });

        await it('keeps the error count and the reason on a failed key lookup', () => {
            const registry = new ActivityRegistry();
            registry.start(keys({ done: 2, found: 1, notFound: 0, errors: 3 }));
            registry.fail(keys({ done: 2, found: 1, notFound: 0, errors: 3 }), 'the archive is down');
            const row = rowView(registry.get('keys')!);
            expect(row.subtitle).toBe('the archive is down');
            expect(row.stats).toBe('1 found · 0 not found · 3 errors');
            expect(registry.summary().failed).toBe(1);
        });
    });
};
