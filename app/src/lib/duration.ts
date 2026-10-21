/** How long a command took, for the line it prints at the end. */

import { fmt, _ } from '@stamped/core';

export function formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    const total = Math.round(ms / 1000);
    return `${Math.floor(total / 60)} min ${total % 60} s`;
}

export function durationLine(startedAt: number): string {
    return fmt(_('Took {duration}.'), { duration: formatDuration(Date.now() - startedAt) });
}
