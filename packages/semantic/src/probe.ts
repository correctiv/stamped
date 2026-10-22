/**
 * A short on/off probe: embed a handful of real messages, time it, and say whether embedding
 * the whole archive on THIS machine is worth switching on by default.
 *
 * Not a benchmark. A few messages measure the machine's order of magnitude (a fast desktop and
 * a laptop on two threads differ by a factor of ten, which is what the answer turns on), not
 * its last digit.
 */

import { documentText } from './prepare.ts';
import type { Embedder } from './embedder.ts';
import type { DocumentSource, SourceDocument } from './indexer.ts';

/**
 * The longest an archive may take for the probe to recommend switching indexing on. A day of
 * background work is the limit of "it will have finished before it was noticed"; past that the
 * journalist is waiting for a feature that is still half-built, on a machine that is warm and
 * loud the whole time, and should choose it deliberately. The spike's 100,000 messages took
 * 7.8 h on ten threads.
 */
export const PROBE_MAX_ARCHIVE_HOURS = 24;

/** How many messages the probe times. Enough to average out one long mail, few enough to take seconds. */
export const PROBE_SAMPLE_SIZE = 8;

/** The model reads at most this many tokens of a message — see `prepare.ts`. */
const CONTEXT_TOKENS = 512;
/** Rough, across the languages of a mailbox; the embedder has no tokenizer to ask. */
const CHARS_PER_TOKEN = 4;

export interface ProbeResult {
    /** Messages timed. */
    readonly sampled: number;
    readonly seconds: number;
    readonly docsPerSecond: number;
    /** Estimated, see {@link CHARS_PER_TOKEN}; comparable between runs, not an exact count. */
    readonly tokensPerSecond: number;
    /** For `pending` messages, at the measured speed. */
    readonly estimatedSeconds: number;
    readonly recommendation: 'on' | 'off';
}

export function estimateTokens(doc: Pick<SourceDocument, 'subject' | 'body'>): number {
    return Math.min(CONTEXT_TOKENS, Math.ceil(documentText(doc.subject, doc.body).length / CHARS_PER_TOKEN));
}

/**
 * Pick the probe's messages: evenly spaced through the first stretch of the priority order,
 * with an empty body skipped (it would time the prompt, not the text). The source cannot jump,
 * so the sample is of the newest mail only.
 */
export function sampleForProbe(source: DocumentSource, size = PROBE_SAMPLE_SIZE): SourceDocument[] {
    const window = source.next(undefined, size * 8);
    const step = Math.max(1, Math.floor(window.length / size));
    const picked = window.filter((_, i) => i % step === 0).map((entry) => entry.hash);
    return source.read(picked).filter((doc) => doc.body.trim() !== '').slice(0, size);
}

/**
 * Time the embedder on `documents` and extrapolate to `pending` messages.
 *
 * The first message is embedded untimed when there are three or more: the first call loads the
 * model's buffers and would make every machine look slow.
 */
export async function probeEmbedder(
    embedder: Embedder,
    documents: readonly SourceDocument[],
    pending: number,
    options: { now?: () => number } = {},
): Promise<ProbeResult> {
    if (documents.length === 0) {
        return { sampled: 0, seconds: 0, docsPerSecond: 0, tokensPerSecond: 0, estimatedSeconds: 0, recommendation: 'on' };
    }
    const now = options.now ?? Date.now;
    const toEmbed = (docs: readonly SourceDocument[]) => docs.map((doc) => ({ subject: doc.subject, body: doc.body }));

    let timed = documents;
    if (documents.length >= 3) {
        await embedder.embedDocuments(toEmbed(documents.slice(0, 1)));
        timed = documents.slice(1);
    }
    const started = now();
    await embedder.embedDocuments(toEmbed(timed));
    const seconds = Math.max((now() - started) / 1000, 1e-3);

    const tokens = timed.reduce((sum, doc) => sum + estimateTokens(doc), 0);
    const docsPerSecond = timed.length / seconds;
    const estimatedSeconds = Math.max(0, pending) / docsPerSecond;
    return {
        sampled: timed.length,
        seconds,
        docsPerSecond,
        tokensPerSecond: tokens / seconds,
        estimatedSeconds,
        recommendation: estimatedSeconds <= PROBE_MAX_ARCHIVE_HOURS * 3600 ? 'on' : 'off',
    };
}
