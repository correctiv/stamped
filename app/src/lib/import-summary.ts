/**
 * What an import of a folder tree reports that an import of plain sources does not.
 *
 * A plain import reports messages. A folder import reports a STRUCTURE as well: how many
 * mailboxes the tree held, how many files were read, and how many files were left alone because
 * they are not mail. Those three numbers are what a journalist needs to decide whether the
 * archive they were handed is the archive they imported — a tree of 12 mailboxes that yielded
 * 4 is a different story from a tree of 12 mailboxes that yielded 12, and only the numbers say
 * which one happened.
 *
 * The failures are NOT in here: they go to stderr, one file per line, because a file that could
 * not be read is an error and not a count.
 */

import { fmt, _, _n } from '@stamped/core';
import type { ImportResult } from '@stamped/store';

/** The lines a folder import prints after the message counts. Empty for a plain import. */
export function folderSummary(result: ImportResult): string[] {
    if (result.mailboxes === 0) return [];
    const lines = [
        fmt(
            _n(
                '{mailboxes} mailbox, {files} files read.',
                '{mailboxes} mailboxes, {files} files read.',
                result.mailboxes,
            ),
            { mailboxes: String(result.mailboxes), files: String(result.files) },
        ),
    ];
    if (result.skipped > 0) {
        lines.push(
            fmt(
                _n(
                    '{count} file was not mail and was left alone.',
                    '{count} files were not mail and were left alone.',
                    result.skipped,
                ),
                { count: String(result.skipped) },
            ),
        );
    }
    return lines;
}

/** One line per file that could not be read. */
export function failureLines(result: ImportResult): string[] {
    return result.failures.map((failure) => failure.reason);
}

/**
 * The sentence that ends a run with files missing from it.
 *
 * Thrown, not printed: a folder import that could not read every file is a PARTIAL import, and
 * a script that reads the exit code must not read it as a clean run. The count is in the
 * sentence, because "something went wrong" is not something an operator can act on.
 */
export function failureHeadline(result: ImportResult): string {
    return fmt(
        _n(
            '{count} file could not be read; the import is incomplete.',
            '{count} files could not be read; the import is incomplete.',
            result.failures.length,
        ),
        { count: String(result.failures.length) },
    );
}
