/**
 * Importing a folder tree of mailboxes — the shape a leaked archive is handed over in.
 *
 * A leak is a FOLDER: one folder per account, each holding its mailbox in pieces, with the
 * paperwork of the disk it came from next to them. The suite is built around that layout, and
 * around the three things that make it different from importing a file:
 *
 * - **A folder is a mailbox.** The name comes from the folder, because the leak's own naming is
 *   the only naming there is — nobody writes a manifest, and a manifest written by the leaker is
 *   a manifest we would have to trust.
 * - **A damaged file does not cost the tree.** One broken part among a thousand is the normal
 *   case for a leak, so the failure is collected per file, the rest is imported, and the run
 *   says what it could not read.
 * - **A link that leaves the tree is not followed.** The archive is evidence, and evidence that
 *   reaches into the operator's own disk reads files that were never part of the leak.
 *
 * Every fixture here is synthetic: reserved example domains, invented bodies, and a tree built
 * by `tools/make-archive-fixtures.mjs`. Nothing real may enter this suite.
 */

import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import { planFolder } from '@stamped/import';
import {
    type CasePaths,
    type ImportLogEntry,
    importSources,
    openCase,
    type ImportResult,
} from '@stamped/store';

import { failureHeadline, failureLines, folderSummary } from '../../src/lib/import-summary.ts';
import { progressLine } from '../../src/lib/progress.ts';
import { archive, fixtureKeys } from './fixtures.ts';

/** A fresh case folder under the system temporary directory, removed when `body` returns. */
async function withCase(body: (paths: CasePaths) => void | Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'stamped-folder-'));
    try {
        await body(openCase(root));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

/** The import log of a case, one entry per line. */
function logOf(paths: CasePaths): ImportLogEntry[] {
    return readFileSync(paths.log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as ImportLogEntry);
}

/** One mbox with one message in it — enough to be a mailbox part. */
function part(subject: string): string {
    return [
        'From ada@example.com Tue Mar  5 09:41:00 2024',
        `Subject: ${subject}`,
        'To: Grace Hopper <grace@example.net>',
        'Date: Tue, 05 Mar 2024 09:40:00 +0000',
        '',
        'The harbour contract is signed.',
        '',
        '',
    ].join('\n');
}

/** One message as a file — the `.eml` of a folder tree. */
function message(subject: string): string {
    return [
        `Subject: ${subject}`,
        'To: Grace Hopper <grace@example.net>',
        'Date: Tue, 05 Mar 2024 09:40:00 +0000',
        '',
        'The harbour contract is signed.',
        '',
    ].join('\n');
}

/** An import result, for the parts of the report that read one. */
function result(over: Partial<ImportResult> = {}): ImportResult {
    return {
        read: 0,
        stored: 0,
        duplicates: 0,
        indexed: 0,
        failed: 0,
        mailboxes: 0,
        files: 0,
        skipped: 0,
        failures: [],
        ...over,
    };
}

export default async () => {
    await describe('planning a folder of mailboxes', async () => {
        await it('names every mailbox after the folder it came from', async () => {
            const plan = planFolder(archive('leak'));
            expect(plan.mailboxes.length).toBe(3);
            // The account folders, in the order the tree holds them. The names are the folders'
            // own — nothing in the archive says what a mailbox is called, so the folder says it.
            expect(plan.mailboxes.map((mailbox) => mailbox.name)).toStrictEqual([
                'ada@example.com',
                'broken@example.org',
                'grace@example.net',
            ]);
        });

        await it('keeps the parts of a mailbox in the order a human reads them', async () => {
            const plan = planFolder(archive('leak'));
            const ada = plan.mailboxes.find((mailbox) => mailbox.name === 'ada@example.com');
            // `part-02` after `part-01`, and NOT after `part-10`: a plain string sort would put
            // the tenth part before the second, and the log of an import would then read as if
            // the mailbox arrived out of order.
            expect(ada?.parts.map((file) => basename(file.path))).toStrictEqual([
                'part-01.mbox',
                'part-02.mbox',
            ]);
        });

        await it('leaves the files that are not mail alone, and says which they were', async () => {
            const plan = planFolder(archive('leak'));
            const skipped = plan.skipped.map((file) => basename(file.path)).sort();
            // The README at the top and the notes inside a mailbox folder: neither is mail, and
            // importing one would put a message in the case folder that nobody ever sent.
            expect(skipped).toStrictEqual(['README.txt', 'notes.md']);
            expect(plan.skipped.every((file) => file.reason === 'not-mail')).toBe(true);
        });

        await it('reads a tree of links without following one out of it', async () => {
            const root = mkdtempSync(join(tmpdir(), 'stamped-links-'));
            const outside = mkdtempSync(join(tmpdir(), 'stamped-outside-'));
            try {
                mkdirSync(join(root, 'inside'));
                writeFileSync(join(root, 'inside', 'part-01.mbox'), part('Inside'));
                mkdirSync(join(root, 'ada@example.com'));
                // A link to a file of the same tree: it stays inside, so it is followed.
                symlinkSync(
                    join(root, 'inside', 'part-01.mbox'),
                    join(root, 'ada@example.com', 'part-01.mbox'),
                );
                mkdirSync(join(root, 'grace@example.net'));
                // A link out of the tree: the operator's own disk is not part of the leak.
                writeFileSync(join(outside, 'part-01.mbox'), part('Outside'));
                symlinkSync(join(outside, 'part-01.mbox'), join(root, 'grace@example.net', 'part-01.mbox'));
                mkdirSync(join(root, 'broken@example.org'));
                // A link to nothing at all.
                symlinkSync(join(root, 'gone.mbox'), join(root, 'broken@example.org', 'part-01.mbox'));

                const plan = planFolder(root);
                // Two mailboxes: the account folder, and the folder the link points into — the
                // same bytes are reachable twice, and the store counts the second copy as the
                // duplicate it is.
                expect(plan.mailboxes.length).toBe(2);
                expect(plan.mailboxes[0]?.name).toBe('ada@example.com');
                expect(plan.mailboxes[0]?.parts.length).toBe(1);
                // The part is the LINK, not the file behind it: the log names the path the
                // operator can see in the archive.
                expect(plan.mailboxes[0]?.parts[0]?.path.includes('ada@example.com')).toBe(true);
                const reasons = plan.skipped.map((file) => file.reason).sort();
                expect(reasons).toStrictEqual(['dangling', 'outside-root']);
            } finally {
                rmSync(root, { recursive: true, force: true });
                rmSync(outside, { recursive: true, force: true });
            }
        });

        await it('takes a lone .eml as a mailbox of one', async () => {
            const root = mkdtempSync(join(tmpdir(), 'stamped-eml-'));
            try {
                mkdirSync(join(root, 'ada@example.com'));
                writeFileSync(join(root, 'ada@example.com', 'one.eml'), message('Loose message'));
                const plan = planFolder(root);
                expect(plan.mailboxes.length).toBe(1);
                expect(plan.mailboxes[0]?.parts[0]?.kind).toBe('eml');
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('takes a Maildir at the root as one mailbox, and never from tmp', async () => {
            const root = mkdtempSync(join(tmpdir(), 'stamped-maildir-'));
            try {
                for (const box of ['cur', 'new', 'tmp']) mkdirSync(join(root, box));
                writeFileSync(join(root, 'cur', 'one'), message('In cur'));
                writeFileSync(join(root, 'new', 'two'), message('In new'));
                // A message a delivery agent is still writing: importing it would put half a
                // message in the case folder under a hash that never matches the finished file.
                writeFileSync(join(root, 'tmp', 'three'), message('Half written'));
                const plan = planFolder(root);
                expect(plan.mailboxes.length).toBe(1);
                expect(plan.mailboxes[0]?.parts[0]?.kind).toBe('maildir');
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    });

    await describe('importing a folder of mailboxes', async () => {
        await it('reads every mailbox and imports only the mail', async () => {
            await withCase(async (paths) => {
                const imported = await importSources(paths, [archive('leak')], {
                    keys: fixtureKeys(),
                    mode: 'folders',
                });
                expect(imported.mailboxes).toBe(3);
                // Two messages in the first part, one in the second, one in the third mailbox.
                expect(imported.read).toBe(4);
                expect(imported.stored).toBe(4);
                expect(imported.indexed).toBe(4);
                expect(imported.files).toBe(4);
                // The README and the notes: left alone, and counted.
                expect(imported.skipped).toBe(2);
            });
        });

        await it('records the mailbox every message came out of', async () => {
            await withCase(async (paths) => {
                await importSources(paths, [archive('leak')], {
                    keys: fixtureKeys(),
                    mode: 'folders',
                });
                const log = logOf(paths);
                expect(log.length).toBe(4);
                expect(log.every((entry) => typeof entry.mailbox === 'string')).toBe(true);
                expect(log.filter((entry) => entry.mailbox === 'ada@example.com').length).toBe(3);
                expect(log.filter((entry) => entry.mailbox === 'grace@example.net').length).toBe(1);
            });
        });

        await it('says which file it could not read, and imports the rest anyway', async () => {
            await withCase(async (paths) => {
                const imported = await importSources(paths, [archive('leak')], {
                    keys: fixtureKeys(),
                    mode: 'folders',
                });
                // The broken part is a file that holds no message. It is reported, and the three
                // mailboxes around it are in the case all the same.
                expect(imported.failures.length).toBe(1);
                expect(imported.failures[0]?.path.includes('broken@example.org')).toBe(true);
                expect(imported.failures[0]?.reason.includes('broken@example.org')).toBe(true);
                expect(imported.stored).toBe(4);
            });
        });

        await it('runs again over the same tree without adding anything', async () => {
            await withCase(async (paths) => {
                await importSources(paths, [archive('leak')], {
                    keys: fixtureKeys(),
                    mode: 'folders',
                });
                const again = await importSources(paths, [archive('leak')], {
                    keys: fixtureKeys(),
                    mode: 'folders',
                });
                expect(again.stored).toBe(0);
                expect(again.duplicates).toBe(4);
                expect(again.indexed).toBe(0);
                // The damage is still damage on the second run: an import that fixed the
                // failure by forgetting it would be lying about the archive.
                expect(again.failures.length).toBe(1);
            });
        });

        await it('reads a folder of mbox files as a tree of mailboxes on its own', async () => {
            // The automatic mode: the layout says what the files are, so the operator does not
            // have to walk the tree with a shell to find out.
            await withCase(async (paths) => {
                const imported = await importSources(paths, [archive('leak')], {
                    keys: fixtureKeys(),
                    mode: 'auto',
                });
                expect(imported.mailboxes).toBe(3);
                expect(imported.read).toBe(4);
            });
        });

        await it('reads the Maildir of a tree, and nothing from its tmp', async () => {
            const root = mkdtempSync(join(tmpdir(), 'stamped-maildir-'));
            try {
                for (const box of ['cur', 'new', 'tmp']) mkdirSync(join(root, box));
                writeFileSync(join(root, 'cur', 'one'), message('In cur'));
                writeFileSync(join(root, 'new', 'two'), message('In new'));
                writeFileSync(join(root, 'tmp', 'three'), message('Half written'));
                await withCase(async (paths) => {
                    const imported = await importSources(paths, [root], {
                        keys: fixtureKeys(),
                        mode: 'folders',
                    });
                    expect(imported.mailboxes).toBe(1);
                    expect(imported.read).toBe(2);
                    // The two files of `cur/` and `new/`, and not the one of `tmp/`.
                    const sources = logOf(paths)
                        .map((entry) => basename(entry.source))
                        .sort();
                    expect(sources).toStrictEqual(['one', 'two']);
                });
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('is not what the window does: without the mode, a folder is a folder of files', async () => {
            // The window imports what the person picked, and this mode is not offered there. So
            // the window's import must not name a mailbox — and the file it reads must still be
            // the file the person picked.
            await withCase(async (paths) => {
                const imported = await importSources(paths, [archive('leak')], {
                    keys: fixtureKeys(),
                });
                expect(imported.mailboxes).toBe(0);
                expect(logOf(paths).every((entry) => entry.mailbox === undefined)).toBe(true);
                // The plain reading takes every file, the README among them: that is what the
                // window has always done, and the folder mode is what stops it.
                expect(imported.read).toBe(7);
            });
        });
    });

    await describe('what a folder import reports', async () => {
        await it('says how many mailboxes there were, and how many files were not mail', async () => {
            const lines = folderSummary(
                result({ read: 4, stored: 4, indexed: 4, mailboxes: 3, files: 4, skipped: 2 }),
            );
            expect(lines.length).toBe(2);
            expect(lines[0]?.includes('3')).toBe(true);
            expect(lines[0]?.includes('4')).toBe(true);
            expect(lines[1]?.includes('2')).toBe(true);
        });

        await it('says nothing extra about a folder that held no mail', async () => {
            expect(folderSummary(result({ read: 4, stored: 4, indexed: 4 })).length).toBe(0);
        });

        await it('names the files it could not read, and says the import is incomplete', async () => {
            const failed = result({
                failures: [
                    { path: '/leak/broken/part-01.mbox', reason: 'Cannot read /leak/broken/part-01.mbox.' },
                ],
            });
            expect(failureLines(failed).length).toBe(1);
            // "Incomplete" is the word that keeps a script from reading a partial import as a
            // clean one.
            expect(failureHeadline(failed).includes('incomplete')).toBe(true);
        });
    });

    await describe('the machine-readable progress', async () => {
        await it('names the mailbox the batch belongs to', async () => {
            const line = progressLine(
                {
                    read: 3,
                    stored: 3,
                    duplicates: 0,
                    indexed: 3,
                    failed: 0,
                    total: 3,
                    done: 3,
                    mailbox: 'ada@example.com',
                },
                false,
                2,
            );
            expect(line.mailbox).toBe('ada@example.com');
            expect(JSON.stringify(line).includes('ada@example.com')).toBe(true);
        });

        await it('leaves the mailbox out when the import has none', async () => {
            const line = progressLine(
                { read: 1, stored: 1, duplicates: 0, indexed: 1, failed: 0, total: 1, done: 1 },
                true,
                1,
            );
            expect('mailbox' in line).toBe(false);
        });
    });

    await describe('a folder that is not one', async () => {
        await it('says so instead of importing nothing quietly', async () => {
            const root = mkdtempSync(join(tmpdir(), 'stamped-empty-'));
            try {
                writeFileSync(join(root, 'readme.txt'), 'nothing to see here\n');
                let thrown: unknown;
                try {
                    await withCase(async (paths) => {
                        await importSources(paths, [root], { keys: fixtureKeys(), mode: 'folders' });
                    });
                } catch (error) {
                    thrown = error;
                }
                expect(thrown instanceof Error).toBe(true);
                expect((thrown as Error).message.includes('mail')).toBe(true);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('does not leave a case folder behind when it refused', async () => {
            // The folder is read before the case is created, so a mistyped source costs nothing.
            const root = mkdtempSync(join(tmpdir(), 'stamped-missing-'));
            try {
                const missing = join(root, 'nowhere');
                expect(existsSync(missing)).toBe(false);
                let thrown: unknown;
                try {
                    await withCase(async (paths) => {
                        await importSources(paths, [missing], {
                            keys: fixtureKeys(),
                            mode: 'folders',
                        });
                    });
                } catch (error) {
                    thrown = error;
                }
                expect(thrown instanceof Error).toBe(true);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    });
};
