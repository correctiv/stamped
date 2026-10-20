/**
 * Splitting an mbox into messages, a chunk at a time.
 *
 * WHY A PUSH STATE MACHINE and not "read the file and split it": an archive is the whole point of
 * this tool and a journalist's mbox is routinely several gigabytes. `readFileSync` on one of
 * those either throws (a JS string and a Uint8Array both have hard size limits) or takes the
 * machine down with it. So the file is read in chunks and this class holds exactly ONE message at
 * a time — the archive's size stops being a limit and the largest single message becomes one.
 *
 * The class is PURE in the sense that matters: it never touches a filesystem. It is fed bytes
 * from anywhere — a file, a test, a socket — which is what makes the mbox rules below testable
 * without writing a single temporary file.
 *
 * ## The two things mbox gets wrong, and what this does about them
 *
 * **There is no mbox standard.** A message begins at a line starting `From ` — and nothing stops
 * a BODY line from starting `From `. Two conventions exist for escaping that, they are not
 * distinguishable by inspection, and a wrong guess silently cuts a message in half. See
 * {@link looksLikeSeparator} and {@link unquote}.
 *
 * **The quoting must be undone before anything else looks at the bytes.** A `>From ` left in the
 * body is a byte the sender never sent, so its body hash is not the signed one and a perfectly
 * good message reports as `body-altered` — Stamped's strongest accusation, produced by its own
 * reader. That is the failure this module exists to prevent.
 */

import { concat, CR, decodeLatin1, isBlankLine, LF } from './bytes.ts';

/** One message as it came out of an archive, with where it came from. */
export interface RawMessage {
    /** The message bytes, mbox quoting undone — what the sender's signature is over. */
    readonly raw: Uint8Array;
    /** Byte offset of the message's start in the source, for the import log. */
    readonly offset: number;
}

/**
 * How `From ` was escaped in the body of this archive.
 *
 * - `mboxrd` — any run of `>` before `From ` had one `>` added. Reversible without loss, which is
 *   why it is the default and why every modern writer uses it.
 * - `mboxo` — only a literal `From ` became `>From `. NOT reversible: a body line that genuinely
 *   read `>From ` is now indistinguishable from an escaped one, and whichever way a reader
 *   decides, some archive somewhere is corrupted by it.
 *
 * The two cannot be told apart by looking at a file. `mboxrd` is the default because being wrong
 * that way touches only lines starting with two or more `>` — quoted quoted text — while being
 * wrong the other way touches ordinary quoted replies, which are everywhere.
 */
export type MboxFlavour = 'mboxrd' | 'mboxo';

/**
 * Does this line start a new message?
 *
 * Starting with `From ` is NOT enough. The rule here also demands the ctime-ish date that every
 * mbox writer puts there (`From ada@example.com Tue Mar  5 09:41:00 2024`), because the two ways
 * of being wrong are not equally bad:
 *
 * - Too eager, and a body paragraph beginning "From the desk of …" cuts a message in two. Both
 *   halves then fail verification, and the half without headers is reported as a message that
 *   never existed. A silent corruption that looks like a finding.
 * - Too strict, and an exotic archive arrives as one enormous message. Obvious — the import says
 *   it found one message — and fixable.
 *
 * So the strict reading wins. The envelope sender is `\S*` rather than an address because
 * Thunderbird writes a bare `-` there, and `\d{1,2}` rather than ctime's space-padded `%e`
 * because enough writers trim it.
 */
export function looksLikeSeparator(line: Uint8Array): boolean {
    if (line.length < 5) return false;
    // `From ` as bytes, before decoding anything: the overwhelming majority of lines fail here,
    // and decoding each of them first would make the check cost a string per line of the archive.
    if (line[0] !== 0x46 || line[1] !== 0x72 || line[2] !== 0x6f || line[3] !== 0x6d) return false;
    if (line[4] !== 0x20) return false;
    // 200 bytes reaches past the longest plausible envelope sender and keeps a pathological line
    // (a megabyte without a newline) from being decoded in full just to be rejected.
    return SEPARATOR.test(decodeLatin1(line.subarray(0, 200)));
}

const SEPARATOR = /^From \S* +[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} /;

/**
 * Undo the `>` an mbox writer added before a `From ` line, if it added one.
 *
 * Returns the line unchanged when there is nothing to undo, so the common case allocates nothing.
 */
export function unquote(line: Uint8Array, flavour: MboxFlavour): Uint8Array {
    if (line.length === 0 || line[0] !== 0x3e) return line;
    let at = 0;
    while (at < line.length && line[at] === 0x3e) at++;
    if (flavour === 'mboxo' && at !== 1) return line;
    // `From` + a space, right after the run of `>`.
    if (line[at] !== 0x46 || line[at + 1] !== 0x72 || line[at + 2] !== 0x6f) return line;
    if (line[at + 3] !== 0x6d || line[at + 4] !== 0x20) return line;
    return line.subarray(1);
}

/**
 * An mbox reader: feed it bytes, it calls back with whole messages.
 *
 * Not an async iterator, deliberately. The GJS runtime has no always-on event loop (see
 * `app/src/index.ts`), and a splitter that yields would need one for a job that never waits on
 * anything. A callback keeps the whole read synchronous and the memory ceiling obvious.
 */
export class MboxSplitter {
    private readonly emit: (message: RawMessage) => void;
    private readonly flavour: MboxFlavour;

    /** The current message's lines, each already unquoted and already COPIED — see {@link feed}. */
    private lines: Uint8Array[] = [];
    private size = 0;
    /** A line the last chunk ended in the middle of. */
    private partial: Uint8Array[] = [];
    private partialSize = 0;
    /** Absolute offset of the next byte to be consumed, for the import log. */
    private position = 0;
    private start = 0;
    private open = false;
    /**
     * Was the line before this one empty? A separator is only believed after a blank line (or at
     * the very beginning), which is the second half of the rule in {@link looksLikeSeparator}.
     */
    private afterBlank = true;
    /** How many trailing blank lines are pending — see {@link finishMessage}. */
    private blanks = 0;

    constructor(emit: (message: RawMessage) => void, flavour: MboxFlavour = 'mboxrd') {
        this.emit = emit;
        this.flavour = flavour;
    }

    /**
     * Hand over the next chunk of the archive.
     *
     * The buffer may be REUSED by the caller as soon as this returns: everything retained across
     * the call is copied. That is what lets the reader own one buffer for the whole file instead
     * of allocating one per chunk.
     */
    feed(chunk: Uint8Array): void {
        let from = 0;
        for (let i = 0; i < chunk.length; i++) {
            if (chunk[i] !== LF) continue;
            this.takeLine(chunk.subarray(from, i + 1));
            from = i + 1;
        }
        if (from < chunk.length) {
            const rest = chunk.subarray(from);
            this.partial.push(rest.slice());
            this.partialSize += rest.length;
        }
    }

    /** No more bytes: flush a last line without a newline, and the message it belongs to. */
    end(): void {
        if (this.partialSize > 0) {
            const line = concat(this.partial, this.partialSize);
            this.partial = [];
            this.partialSize = 0;
            this.takeLine(line);
        }
        this.finishMessage();
    }

    /** One complete line, with its end-of-line still attached. */
    private takeLine(fragment: Uint8Array): void {
        const line =
            this.partialSize > 0
                ? concat([...this.partial, fragment], this.partialSize + fragment.length)
                : fragment;
        if (this.partialSize > 0) {
            this.partial = [];
            this.partialSize = 0;
        }
        const offset = this.position;
        this.position += line.length;

        if (this.afterBlank && looksLikeSeparator(line)) {
            this.finishMessage();
            this.start = offset;
            this.open = true;
            this.afterBlank = false;
            return;
        }

        const blank = isBlankLine(line);
        this.afterBlank = blank;
        if (!this.open) {
            // Bytes before the first separator. A leading blank line or an mbox header comment is
            // not a message, and inventing one from it would put a message in the case folder
            // that nobody ever sent.
            return;
        }
        if (blank) {
            // Held back, not appended: whether it belongs to this message depends on what comes
            // next, and only {@link finishMessage} knows that.
            this.blanks++;
            return;
        }
        for (let i = 0; i < this.blanks; i++) this.lines.push(BLANK);
        this.size += this.blanks * BLANK.length;
        this.blanks = 0;
        const unquoted = this.unquoteLine(line);
        this.lines.push(unquoted.slice());
        this.size += unquoted.length;
    }

    private unquoteLine(line: Uint8Array): Uint8Array {
        return unquote(line, this.flavour);
    }

    /**
     * Emit the message built so far.
     *
     * ONE trailing blank line is dropped, because in mbox it belongs to the separator rather than
     * to the message — a writer puts it there to make the next `From ` recognisable. Any further
     * blank lines were in the body and stay. Nothing about a DKIM verdict turns on this (both
     * canonicalizations in RFC 6376 § 3.4 fold trailing CRLFs away), but the raw store is
     * byte-exact, so the question has to be ANSWERED rather than left to whichever branch ran.
     */
    private finishMessage(): void {
        if (!this.open) {
            this.blanks = 0;
            return;
        }
        for (let i = 1; i < this.blanks; i++) this.lines.push(BLANK);
        this.size += Math.max(0, this.blanks - 1) * BLANK.length;
        this.blanks = 0;

        if (this.lines.length > 0) {
            this.emit({ raw: concat(this.lines, this.size), offset: this.start });
        }
        this.lines = [];
        this.size = 0;
        this.open = false;
    }
}

/** The blank line held back and sometimes put back. LF only — see {@link isBlankLine}. */
const BLANK = new Uint8Array([LF]);

/**
 * Does this look like an mbox rather than a single message?
 *
 * Asked of the first bytes of a file whose name does not say. A `.eml` exported by a mail client
 * sometimes carries a `From ` line too, which is exactly why the same strict rule decides both
 * questions: a file that starts with a believable separator is an archive of at least one
 * message, and reading a one-message archive as an mbox gives the same message back.
 */
export function looksLikeMbox(head: Uint8Array): boolean {
    let end = 0;
    while (end < head.length && head[end] !== LF) end++;
    if (end > 0 && head[end - 1] === CR) end--;
    return looksLikeSeparator(head.subarray(0, end));
}
