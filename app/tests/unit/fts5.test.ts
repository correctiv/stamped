/**
 * The FTS5 spike, kept as a test.
 *
 * Stamped's second half — exploring an archive of a few hundred thousand messages — rests on
 * SQLite full-text search. But gjsify's `node:sqlite` is a **libgda wrapper**, not a sqlite3
 * binding, so "SQLite has FTS5" is a claim about a different library than the one this actually
 * runs on. If the module were missing or its tokenizer inactive, a search would answer "no
 * results" to everything and look like an empty archive rather than a broken build — the kind
 * of failure that makes a journalist conclude a mail is not in the leak.
 *
 * So the spike stays as a test, on both runtimes, rather than as a note in `docs/spikes.md`
 * claiming it worked once. It is deliberately small: it asks whether the capability is there,
 * not how the index will be shaped. All text is synthetic.
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from '@gjsify/unit';

/** One in-memory database with a tiny FTS5 table, handed to `body` and closed afterwards. */
function withFts(body: (db: DatabaseSync) => void): void {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE VIRTUAL TABLE messages USING fts5(subject, body)');
        body(db);
    } finally {
        db.close();
    }
}

export default async () => {
    await describe('FTS5 availability', async () => {
        await it('creates an FTS5 table at all', async () => {
            // The gate. `CREATE VIRTUAL TABLE … USING fts5` throws when the module is not
            // compiled in, which is the whole question this spike asked.
            withFts(() => {});
        });

        await it('finds a row by a word in the middle of a column', async () => {
            withFts((db) => {
                db.prepare('INSERT INTO messages(subject, body) VALUES (?, ?)').run(
                    'Quarterly figures',
                    'the attached spreadsheet covers the harbour contract',
                );
                const row = db
                    .prepare('SELECT subject FROM messages WHERE messages MATCH ?')
                    .get('harbour') as { subject?: string } | undefined;
                expect(row?.subject).toBe('Quarterly figures');
            });
        });

        await it('returns nothing for a word that is not there', async () => {
            // The other half of the gate: a tokenizer that matched everything would pass the
            // test above while being just as useless as one that matches nothing.
            withFts((db) => {
                db.prepare('INSERT INTO messages(subject, body) VALUES (?, ?)').run(
                    'Quarterly figures',
                    'the attached spreadsheet covers the harbour contract',
                );
                const rows = db
                    .prepare('SELECT subject FROM messages WHERE messages MATCH ?')
                    .all('lighthouse');
                expect(rows.length).toBe(0);
            });
        });

        await it('searches one column on its own', async () => {
            // `column : term` is how a "from:" or "subject:" filter will be expressed, so the
            // syntax being understood matters as much as the module being present.
            withFts((db) => {
                db.prepare('INSERT INTO messages(subject, body) VALUES (?, ?)').run(
                    'harbour contract',
                    'nothing of interest here',
                );
                const hit = db
                    .prepare('SELECT subject FROM messages WHERE messages MATCH ?')
                    .all('subject : harbour');
                expect(hit.length).toBe(1);
                const miss = db
                    .prepare('SELECT subject FROM messages WHERE messages MATCH ?')
                    .all('body : harbour');
                expect(miss.length).toBe(0);
            });
        });

        await it('ranks several hits without an error', async () => {
            // `ORDER BY rank` needs the auxiliary functions, not just the virtual table; a build
            // with FTS5 but without them fails here and nowhere above.
            withFts((db) => {
                const insert = db.prepare('INSERT INTO messages(subject, body) VALUES (?, ?)');
                insert.run('harbour', 'harbour harbour harbour');
                insert.run('elsewhere', 'one harbour mention');
                const rows = db
                    .prepare('SELECT subject FROM messages WHERE messages MATCH ? ORDER BY rank')
                    .all('harbour') as { subject?: string }[];
                expect(rows.length).toBe(2);
                expect(rows[0]?.subject).toBe('harbour');
            });
        });
    });
};
