import type { DatabaseSync, StatementSync } from 'node:sqlite';

const prepared = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/**
 * The statement for `sql` on `db`, prepared once. Indexing runs the same few statements per
 * message; on Gjs every `prepare()` is a fresh libgda parse, which costs time and holds each
 * bound text until the garbage collector runs — it cannot see that memory, so RSS grew with
 * the mail count.
 *
 * gjsify gap (unfixed, https://github.com/gjsify/gjsify/pull/2333): the bound text is released
 * only after a gjsify bump; until then this cache is what keeps the parse count down.
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
