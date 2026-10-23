// Test entry: aggregates every *.test.ts suite (each a default-exported async fn) and runs them
// under @gjsify/unit, on GJS and Node both (`gjsify test`). Keep this list in sync when adding a
// test file.
import { run } from '@gjsify/unit';

import activity from './unit/activity.test.ts';
import autokeys from './unit/autokeys.test.ts';
import cli from './unit/cli.test.ts';
import classify from './unit/classify.test.ts';
import folder from './unit/folder.test.ts';
import explain from './unit/explain.test.ts';
import keys from './unit/keys.test.ts';
import keyvault from './unit/keyvault.test.ts';
import verify from './unit/verify.test.ts';
import report from './unit/report.test.ts';
import fts5 from './unit/fts5.test.ts';
import importSuite from './unit/import.test.ts';
import store from './unit/store.test.ts';
import throughput from './unit/throughput.test.ts';
import people from './unit/people.test.ts';
import status from './unit/status.test.ts';
import activityStatus from './unit/activity-status.test.ts';
import view from './unit/view.test.ts';
import reading from './unit/reading.test.ts';
import openCopy from './unit/open-copy.test.ts';
import selfArgv from './unit/self-argv.test.ts';
import semantic from './unit/semantic.test.ts';
import llamaPrompts from './unit/llama-prompts.test.ts';
import indexer from './unit/indexer.test.ts';
import semanticState from './unit/semantic-state.test.ts';
import queryWorker from './unit/query-worker.test.ts';
import hybridSearch from './unit/hybrid-search.test.ts';
import modelPath from './unit/model-path.test.ts';
import semanticGui from './unit/semantic-gui.test.ts';
import semanticRun from './unit/semantic-run.test.ts';
import timecheck from './unit/timecheck.test.ts';
import pagedList from './unit/paged-list.test.ts';
import refreshScheduler from './unit/refresh-scheduler.test.ts';

run({
    activity,
    autokeys,
    cli,
    classify,
    folder,
    explain,
    keys,
    keyvault,
    verify,
    report,
    fts5,
    import: importSuite,
    store,
    throughput,
    people,
    status,
    activityStatus,
    view,
    reading,
    openCopy,
    selfArgv,
    semantic,
    llamaPrompts,
    indexer,
    semanticState,
    hybridSearch,
    modelPath,
    semanticGui,
    semanticRun,
    queryWorker,
    timecheck,
    pagedList,
    refreshScheduler,
});
