// Test entry: aggregates every *.test.ts suite (each a default-exported async fn) and runs them
// under @gjsify/unit, on GJS and Node both (`gjsify test`). Keep this list in sync when adding a
// test file.
import { run } from '@gjsify/unit';

import autokeys from './unit/autokeys.test.ts';
import classify from './unit/classify.test.ts';
import keys from './unit/keys.test.ts';
import keyvault from './unit/keyvault.test.ts';
import verify from './unit/verify.test.ts';
import report from './unit/report.test.ts';
import fts5 from './unit/fts5.test.ts';
import importSuite from './unit/import.test.ts';
import store from './unit/store.test.ts';
import view from './unit/view.test.ts';

run({
    autokeys,
    classify,
    keys,
    keyvault,
    verify,
    report,
    fts5,
    import: importSuite,
    store,
    view,
});
