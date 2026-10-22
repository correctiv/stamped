import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.SPIKE_BIG_DB!);
const rt = typeof (globalThis as any).imports !== 'undefined' ? 'gjs' : 'node';
const qs: Record<string, string> = {
    cte100: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<100) SELECT count(*) AS n FROM c',
    cte100sub: 'SELECT count(*) AS n FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<100) SELECT x FROM c)',
    cte100all: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<100) SELECT x FROM c LIMIT 3',
    join: 'SELECT count(*) AS n FROM big a JOIN big b ON a.bucket = b.bucket WHERE a.id < 4000',
    like: "SELECT count(*) AS n FROM big a, big b WHERE b.snippet LIKE '%' || (a.id % 9) || ' lorem%' AND a.id < 300",
};
for (const [k, sql] of Object.entries(qs)) {
    const t = performance.now();
    try {
        const r = db.prepare(sql).all();
        console.log(`[${rt}] ${k} ok ${JSON.stringify(r)} ${Math.round(performance.now() - t)}ms`);
    } catch (e: any) {
        console.log(`[${rt}] ${k} ERR ${e?.message} ${Math.round(performance.now() - t)}ms`);
    }
}
process.exit(0);
