import type { DatabaseSync, StatementSync } from 'node:sqlite';

const prepared = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/**
 * The statement for `sql` on `db`, prepared once. Indexing runs the same few statements per
 * message; on Gjs every `prepare()` is a fresh native parse (measured on libgda), which costs time and leaves every
 * bound text as garbage the collector reaches late — it cannot see that native memory, so RSS
 * between two collections grew with the mail count.
 *
 * This stays after any gjsify bump: gjsify's own statement cache (PR #2333) lives inside one
 * `StatementSync`, so it only pays off for a caller that keeps that object — which is what this
 * map does, one per database and SQL text.
 *
 * Nothing here is invalidated. `createSchema()` drops every table, which is safe only because it
 * runs when the database is opened, before any statement has been cached for it; a caller that
 * changed the schema later would have to open a new connection.
 */
export function statementFor(db: DatabaseSync, sql: string): StatementSync {
    let statements = prepared.get(db);
    if (!statements) {
        statements = new Map();
        prepared.set(db, statements);
    }
    let statement = statements.get(sql);
    if (!statement) {
        statement = db.prepare(sql);
        statements.set(sql, statement);
    }
    return statement;
}
