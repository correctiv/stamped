/**
 * Numbers and dates for a window, where the terminal's verbatim strings do not fit.
 *
 * Pure, and deliberately free of `Intl` and of GLib: the view models are tested on Node as well
 * as GJS, and a formatter that reads the system locale would make the tests depend on the machine
 * they run on. Dates come out as ISO, which also happens to be the right default for archive work
 * — `03/04/2019` is two different days depending on who reads it.
 */

import { fmt, _ } from '@stamped/core';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function pad(value: number): string {
    return value < 10 ? `0${value}` : String(value);
}

/**
 * `2019-03-04` for a list row, taken FROM THE HEADER AS WRITTEN.
 *
 * Not from `sentAt`: that is an instant, and rendering an instant means choosing a time zone, so
 * a mail written late on the 4th in Berlin would show as the 3rd in UTC. The day a message says
 * it was sent is evidence; a day this tool computed from it is not. `sentAt` is only the fallback
 * for a header too broken to read a date out of, and the detail pane shows the raw header anyway.
 */
export function shortDate(date: string, sentAt?: number): string {
    const parsed = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(date);
    if (parsed) {
        const month = MONTHS.indexOf(parsed[2].toLowerCase());
        if (month >= 0) return `${parsed[3]}-${pad(month + 1)}-${pad(Number(parsed[1]))}`;
    }
    if (sentAt !== undefined && Number.isFinite(sentAt)) {
        return new Date(sentAt).toISOString().slice(0, 10);
    }
    return _('(no date)');
}

/** `1,204` — grouped in threes, so six figures of mail can be read at a glance. */
export function groupDigits(value: number): string {
    const digits = String(Math.trunc(Math.abs(value)));
    let out = '';
    for (let i = 0; i < digits.length; i++) {
        if (i > 0 && (digits.length - i) % 3 === 0) out += '\u202f';
        out += digits[i];
    }
    return value < 0 ? `-${out}` : out;
}

/**
 * `4.2 MB` for a size a person reads, in powers of 1000.
 *
 * Decimal rather than binary units, as GNOME's HIG asks: the number beside a mailbox is compared
 * against what a file manager said about the same file, not against a memory map.
 */
export function formatBytes(bytes: number): string {
    const size = Math.max(0, Math.trunc(bytes));
    if (size < 1000) return fmt(_('{n} B'), { n: String(size) });
    const units = [_('{n} kB'), _('{n} MB'), _('{n} GB'), _('{n} TB')];
    let value = size / 1000;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    const rounded = value < 10 ? value.toFixed(1) : String(Math.round(value));
    return fmt(units[unit], { n: rounded });
}

/**
 * The first twelve characters of a hash, as the CLI prints it.
 *
 * Twelve because that is what `stamped search` shows, and the two have to be greppable against
 * each other — a journalist reads a hash off the window to pass it to the CLI.
 */
export function shortHash(hash: string): string {
    return hash.slice(0, 12);
}
