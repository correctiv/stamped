/**
 * The status button and the rows of its popover, as data: what each background job says.
 *
 * Plain text, not Pango markup: the popover is built from `Gtk.Label`s with markup off, so a
 * mailbox called `Mail & Co` shows as it is and nothing here is escaped. The tasks come out of
 * the registry in [`lib/activity.ts`](../../lib/activity.ts); the window only places the strings.
 *
 * The same rules as the banner this replaces: the import's percentage is by BYTES over the whole
 * run (the message total is the current mailbox's and would restart at every mailbox), and a
 * Cancel exists only for a subprocess the window started itself.
 */

import { fmt, _, _n, type LookupChannel } from '@stamped/core';

import type {
    ActivityKind,
    ActivityState,
    ActivityTask,
    ImportActivity,
    KeysActivity,
    PeopleActivity,
    ReverifyActivity,
} from '../../lib/activity.ts';
import { percent } from '../../lib/status.ts';
import { formatBytes, groupDigits } from './format.ts';

/** How the button draws: a calm icon, a spinner, or a filling circle. */
export type ButtonMode = 'idle' | 'busy' | 'progress';

export interface ButtonView {
    readonly mode: ButtonMode;
    /** 0 … 1; only meaningful for `progress`. */
    readonly fraction: number;
    /** A small dot over the button: a task failed and has not been dismissed. */
    readonly error: boolean;
    readonly tooltip: string;
}

export interface RowView {
    readonly kind: ActivityKind;
    readonly state: ActivityState;
    readonly title: string;
    /** One line: where the job is, or its result. */
    readonly subtitle: string;
    /** 0 … 1 while the job runs and knows it; `undefined` hides the bar. */
    readonly fraction: number | undefined;
    /** A second, dimmed line (rate and ETA, or a tally); `''` when there is none. */
    readonly stats: string;
    /** The expander's lines; empty means no expander. */
    readonly details: readonly string[];
    readonly cancellable: boolean;
}

function taskTitle(kind: ActivityKind): string {
    switch (kind) {
        case 'import':
            return _('Import');
        case 'keys':
            return _('Key lookup');
        case 'reverify':
            return _('Re-verification');
        case 'people':
            return _('People and timeline');
    }
}

function channelName(channel: LookupChannel): string {
    return channel === 'dns' ? _('DNS') : 'archive.prove.email';
}

/** `3 min` / `45 s` — a row has no room for seconds once there are minutes. */
function shortEta(seconds: number): string {
    if (seconds < 60) return fmt(_('{n} s'), { n: String(Math.max(0, Math.round(seconds))) });
    return fmt(_('{n} min'), { n: String(Math.round(seconds / 60)) });
}

/** What a running task is doing, for the button's tooltip. */
function runningLine(task: ActivityTask): string {
    switch (task.data.kind) {
        case 'import': {
            const pct = task.fraction === undefined ? undefined : Math.floor(task.fraction * 100);
            return pct === undefined
                ? _('Importing mail…')
                : fmt(_('Importing mail, {percent}%'), { percent: String(pct) });
        }
        case 'keys':
            return fmt(_('Looking up keys, {done} of {total}'), {
                done: groupDigits(task.data.done),
                total: groupDigits(task.data.total),
            });
        case 'reverify':
            return fmt(_('Re-verifying messages, {done} of {total}'), {
                done: groupDigits(task.data.checked),
                total: groupDigits(task.data.total),
            });
        case 'people':
            return _('Building the people list…');
    }
}

/** The button for a task list; one look, no state of its own. */
export function buttonView(tasks: readonly ActivityTask[]): ButtonView {
    const running = tasks.filter((task) => task.state === 'running');
    const failed = tasks.filter((task) => task.state === 'failed').length;
    const lines = running.map(runningLine);
    if (failed > 0) {
        lines.push(fmt(_n('{count} task failed', '{count} tasks failed', failed), { count: String(failed) }));
    }
    if (running.length === 0 && failed === 0) {
        lines.push(tasks.length === 0 ? _('No background work') : _('Background work finished'));
    }
    const single = running.length === 1 ? running[0]!.fraction : undefined;
    return {
        mode: running.length === 0 ? 'idle' : single === undefined ? 'busy' : 'progress',
        fraction: single ?? 0,
        error: failed > 0,
        tooltip: lines.join('\n'),
    };
}

function importRow(task: ActivityTask, data: ImportActivity): Omit<RowView, 'kind' | 'state' | 'title'> {
    const status = data.status;
    const running = task.state === 'running';
    const pct = String(percent(status.bytesRead, status.bytesTotal));
    const details: string[] = [];
    if (status.mailbox !== undefined) details.push(fmt(_('Mailbox: {mailbox}'), { mailbox: status.mailbox }));
    details.push(fmt(_('Sources: {sources}'), { sources: status.sources.join(', ') }));
    details.push(
        fmt(_('{read} of {total} read'), {
            read: formatBytes(status.bytesRead),
            total: formatBytes(status.bytesTotal),
        }),
    );
    if (status.errors > 0) {
        details.push(
            fmt(_n('{count} message has no verdict', '{count} messages have no verdict', status.errors), {
                count: groupDigits(status.errors),
            }),
        );
    }

    let subtitle: string;
    if (running) {
        subtitle = status.mailbox === undefined ? `${pct}%` : `${pct}% · ${status.mailbox}`;
    } else if (data.orphaned) {
        subtitle = _('Interrupted. Its process is gone. Run the import again to resume.');
    } else if (status.state === 'cancelled') {
        subtitle = _('Cancelled. Run it again to resume.');
    } else if (status.state === 'failed') {
        subtitle = _('The import failed');
    } else {
        subtitle = fmt(_n('Finished, {count} message', 'Finished, {count} messages', status.mailsDone), {
            count: groupDigits(status.mailsDone),
        });
    }

    const stats: string[] = [];
    if (running) {
        stats.push(
            fmt(_n('{count} message', '{count} messages', status.mailsDone), {
                count: groupDigits(status.mailsDone),
            }),
        );
        if (status.rate > 0) {
            stats.push(
                fmt(_('{rate} messages/s, {bytes}/s'), {
                    rate: String(status.rate),
                    bytes: formatBytes(status.bytesRate),
                }),
            );
        }
        if (status.eta >= 0) stats.push(fmt(_('about {time} left'), { time: shortEta(status.eta) }));
    }
    return {
        subtitle,
        fraction: running ? task.fraction : undefined,
        stats: stats.join(' · '),
        details,
        cancellable: running && data.own,
    };
}

function keysRow(task: ActivityTask, data: KeysActivity): Omit<RowView, 'kind' | 'state' | 'title'> {
    const running = task.state === 'running';
    const tally = [
        fmt(_('{count} found'), { count: groupDigits(data.found) }),
        fmt(_('{count} not found'), { count: groupDigits(data.notFound) }),
    ];
    if (data.errors > 0) {
        tally.push(
            fmt(_n('{count} error', '{count} errors', data.errors), { count: groupDigits(data.errors) }),
        );
    }
    const channel = channelName(data.channel);
    return {
        subtitle: running
            ? fmt(_('{done} of {total} · {channel}'), {
                  done: groupDigits(data.done),
                  total: groupDigits(data.total),
                  channel,
              })
            : task.state === 'failed'
              ? (task.reason ?? _('The lookup failed'))
              : fmt(_('Finished · {channel}'), { channel }),
        fraction: running ? task.fraction : undefined,
        stats: tally.join(' · '),
        details: [],
        cancellable: false,
    };
}

function reverifyRow(task: ActivityTask, data: ReverifyActivity): Omit<RowView, 'kind' | 'state' | 'title'> {
    const running = task.state === 'running';
    const changed = fmt(_n('{count} verdict changed', '{count} verdicts changed', data.changed), {
        count: groupDigits(data.changed),
    });
    return {
        subtitle: running
            ? fmt(_('{done} of {total} messages'), {
                  done: groupDigits(data.checked),
                  total: groupDigits(data.total),
              })
            : task.state === 'failed'
              ? (task.reason ?? _('The re-verification failed'))
              : fmt(_n('{count} message checked', '{count} messages checked', data.checked), {
                    count: groupDigits(data.checked),
                }),
        fraction: running ? task.fraction : undefined,
        stats: changed,
        details: [],
        cancellable: false,
    };
}

function peopleRow(task: ActivityTask, data: PeopleActivity): Omit<RowView, 'kind' | 'state' | 'title'> {
    return {
        subtitle:
            task.state === 'running'
                ? fmt(_n('{count} message indexed', '{count} messages indexed', data.processed), {
                      count: groupDigits(data.processed),
                  })
                : task.state === 'failed'
                  ? (task.reason ?? _('Indexing stopped'))
                  : _('Finished'),
        fraction: undefined,
        stats: '',
        details: [],
        cancellable: false,
    };
}

/** One popover row. */
export function rowView(task: ActivityTask): RowView {
    const head = { kind: task.kind, state: task.state, title: taskTitle(task.kind) };
    switch (task.data.kind) {
        case 'import':
            return { ...head, ...importRow(task, task.data) };
        case 'keys':
            return { ...head, ...keysRow(task, task.data) };
        case 'reverify':
            return { ...head, ...reverifyRow(task, task.data) };
        case 'people':
            return { ...head, ...peopleRow(task, task.data) };
    }
}
