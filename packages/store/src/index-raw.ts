/**
 * What indexing one message means, once its verdict is known.
 *
 * The importer and the rebuild of an index both end here, so a message that went in by an import
 * and the same message put back by `case reindex` get the same rows: the row, the text, the
 * addresses, the cached headers and explanations. Two copies of this list would drift the day
 * one more cache table is added, and a rebuilt index would then differ from the one it replaces.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { MessageFinding } from '@stamped/core';
import { splitMessage, summarise } from '@stamped/import';

import { writeBodyExplanations } from './body-explanations.ts';
import { indexMessage } from './index-db.ts';
import { writeReceiverAnchors } from './receiver-anchors.ts';
import { writeUnsignedHeaders } from './unsigned-headers.ts';

export function indexRaw(
    db: DatabaseSync,
    hash: string,
    raw: Uint8Array,
    finding: MessageFinding,
    options: { fresh?: boolean; firstVerdict?: string | null } = {},
): void {
    indexMessage(db, { hash, bytes: raw.length, summary: summarise(raw), finding }, options);
    // The header is in hand already: cache it, no re-read later.
    if (finding.verdict === 'unsigned') writeUnsignedHeaders(db, hash, splitMessage(raw).header);
    writeBodyExplanations(db, hash, finding, raw);
    writeReceiverAnchors(db, hash, finding, raw);
}
