/** Reading a pair list from a file, and naming the file when it is wrong. */

import { existsSync, readFileSync } from 'node:fs';

import { fmt, parsePairList, type PairCount, _ } from '@stamped/core';

export function readPairFile(path: string): PairCount[] {
    if (!existsSync(path)) {
        throw new Error(fmt(_('Pair file {path} does not exist.'), { path }));
    }
    try {
        return parsePairList(readFileSync(path, 'utf8'));
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(fmt(_('Pair file {path}: {reason}'), { path, reason }));
    }
}
