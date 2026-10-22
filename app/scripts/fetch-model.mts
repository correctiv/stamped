/**
 * Fetch the embedding model the release artifacts carry — and say where it goes.
 *
 *   node --experimental-strip-types scripts/fetch-model.mts fetch [--dest <dir>]
 *   node --experimental-strip-types scripts/fetch-model.mts ship-config --on|--off
 *
 * WHY A SCRIPT AND NOT A GIT FILE. The model is ~296 MiB; it is fetched at a PINNED revision and
 * verified once, here, and never committed. What IS committed is the licence and the NOTICE beside
 * it (`models/`), because redistribution of an Apache-2.0 work carries its licence with it.
 *
 * WHY `ship-config`. `gjsify ship`'s `extraFiles` is per PROJECT, not per format: one entry would
 * put 296 MiB into the .deb, the .rpm and the .msi as well, and a MISSING extraFiles source makes
 * the ship fail outright. The model belongs in the artifacts a person DOWNLOADS and runs — the
 * AppImage and the macOS `.app` — and nowhere else, so the entries live in a config file
 * (`.gjsifyrc.json`, gitignored, written here) that the release turns on for exactly those two
 * ships. When gjsify grows per-format extraFiles, this becomes one line in `package.json`.
 *
 * The metadata lives in `src/lib/model-path.ts` — the same constants the app resolves the model
 * with — so the pin has exactly one home.
 */

import { createHash } from 'node:crypto';
import {
    createReadStream,
    existsSync,
    mkdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
    EMBEDDING_MODEL_BYTES,
    EMBEDDING_MODEL_FILE,
    EMBEDDING_MODEL_LICENSE_FILE,
    EMBEDDING_MODEL_NOTICE_FILE,
    EMBEDDING_MODEL_REPO,
    EMBEDDING_MODEL_REVISION,
    EMBEDDING_MODEL_SHA256,
} from '../src/lib/model-path.ts';

const projectDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const modelDir = join(projectDir, 'models');
const shipConfigPath = join(projectDir, '.gjsifyrc.json');

/** The download URL of the pinned file. The revision is a commit sha, never a branch. */
function modelUrl(): string {
    return `https://huggingface.co/${EMBEDDING_MODEL_REPO}/resolve/${EMBEDDING_MODEL_REVISION}/${EMBEDDING_MODEL_FILE}`;
}

/** The sha256 of a file, streamed — 296 MiB do not belong in a string. */
async function sha256File(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
}

/**
 * Download the pinned file and verify it.
 *
 * The file is written under a temporary name and RENAMED into place, so an interrupted download
 * never leaves a half-written file that a later existence check would accept.
 */
async function fetchModel(dest: string): Promise<void> {
    const target = join(dest, EMBEDDING_MODEL_FILE);
    if (existsSync(target)) {
        if (
            statSync(target).size === EMBEDDING_MODEL_BYTES &&
            (await sha256File(target)) === EMBEDDING_MODEL_SHA256
        ) {
            console.log(`already there and verified: ${target}`);
            return;
        }
        console.log(`present but not the pinned file — refetching: ${target}`);
        rmSync(target);
    }
    mkdirSync(dest, { recursive: true });
    const partial = `${target}.part`;
    const response = await fetch(modelUrl(), { redirect: 'follow' });
    if (!response.ok || response.body === null) {
        throw new Error(`download failed: ${response.status} ${response.statusText}`);
    }
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial));
    const digest = await sha256File(partial);
    const size = statSync(partial).size;
    if (digest !== EMBEDDING_MODEL_SHA256) {
        rmSync(partial, { force: true });
        throw new Error(`sha256 mismatch: expected ${EMBEDDING_MODEL_SHA256}, got ${digest}`);
    }
    if (size !== EMBEDDING_MODEL_BYTES) {
        rmSync(partial, { force: true });
        throw new Error(`size mismatch: expected ${EMBEDDING_MODEL_BYTES}, got ${size}`);
    }
    renameSync(partial, target);
    console.log(`fetched ${target} (${size} bytes, sha256 ${digest})`);
}

/**
 * Turn the model's ship entries on or off.
 *
 * `--on` writes the config file gjsify reads next to `package.json`; `--off` removes it, so the
 * artifacts that must not carry 296 MiB are built without it. The destinations are `share/models/`
 * because that is where the app's own data lives in EVERY layout: `$APPDIR/usr/share` in the
 * AppImage, `Stamped.app/Contents/Resources/share` in the `.app`.
 */
function shipConfig(mode: 'on' | 'off'): void {
    if (mode === 'off') {
        rmSync(shipConfigPath, { force: true });
        console.log('ship config removed — the model ships in no artifact');
        return;
    }
    for (const file of [EMBEDDING_MODEL_FILE, EMBEDDING_MODEL_LICENSE_FILE, EMBEDDING_MODEL_NOTICE_FILE]) {
        if (!existsSync(join(modelDir, file))) {
            throw new Error(`missing models/${file} — run "fetch" before turning the ship config on`);
        }
    }
    const config = {
        ship: {
            extraFiles: {
                [`share/models/${EMBEDDING_MODEL_FILE}`]: `models/${EMBEDDING_MODEL_FILE}`,
                [`share/models/${EMBEDDING_MODEL_LICENSE_FILE}`]: `models/${EMBEDDING_MODEL_LICENSE_FILE}`,
                [`share/models/${EMBEDDING_MODEL_NOTICE_FILE}`]: `models/${EMBEDDING_MODEL_NOTICE_FILE}`,
            },
        },
    };
    writeFileSync(shipConfigPath, `${JSON.stringify(config, null, 4)}\n`);
    console.log(`ship config on — the model ships via ${shipConfigPath}`);
}

/** The entry point: a subcommand and its flags, nothing else. */
async function main(): Promise<void> {
    const [command = 'fetch', ...rest] = process.argv.slice(2);
    if (command === 'fetch') {
        const destIndex = rest.indexOf('--dest');
        const dest = destIndex === -1 ? modelDir : resolve(rest[destIndex + 1] ?? modelDir);
        await fetchModel(dest);
        return;
    }
    if (command === 'ship-config') {
        const mode = (rest[0] ?? '').replace(/^--/, '');
        if (mode !== 'on' && mode !== 'off') {
            throw new Error('usage: fetch-model.mts ship-config --on|--off');
        }
        shipConfig(mode);
        return;
    }
    throw new Error('usage: fetch-model.mts fetch [--dest <dir>] | fetch-model.mts ship-config --on|--off');
}

await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
