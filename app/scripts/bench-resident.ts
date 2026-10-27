/**
 * Measures the resident vector index against a vectors.db: the first load, a search, a refresh.
 *
 *   gjsify build scripts/bench-resident.ts --app gjs --outfile dist/bench-resident.gjs.mjs
 *   /usr/bin/time -f %M gjsify run dist/bench-resident.gjs.mjs <vectors.db> <modelId> <dimensions>
 *
 * Read-only: it opens the file the way the helper does and never writes to it.
 */

import { openVectorDbForSearch, sqliteVectorSource, VectorIndex } from '@stamped/semantic';

const [path, modelId, dims] = process.argv.slice(-3);
const dimensions = Number(dims);
const db = openVectorDbForSearch(path!, { modelId: modelId!, dimensions });
if (db === undefined) throw new Error('no usable vectors.db for that model');

const query = new Float32Array(dimensions);
for (let i = 0; i < dimensions; i++) query[i] = Math.sin(i + 1);

const index = new VectorIndex(sqliteVectorSource(db), dimensions);
let t = Date.now();
await index.load();
console.log(`load     ${Date.now() - t} ms  (${index.size} vectors, ${index.skipped} skipped)`);
for (let run = 1; run <= 3; run++) {
    t = Date.now();
    const hits = index.search(query, 250);
    console.log(
        `search#${run} ${Date.now() - t} ms  (top ${hits.length}, best ${hits[0]?.score.toFixed(4)})`,
    );
}
t = Date.now();
console.log(`refresh  ${Date.now() - t} ms  (${await index.refresh()})`);
db.close();
