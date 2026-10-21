/**
 * Text preparation for embedding.
 *
 * WHY STRIP QUOTES AND SIGNATURES: quoted replies repeat the thread and bloat the embedding
 * with text from other people; a signature is boilerplate that drowns the signal. The goal is
 * to embed "what this message says" rather than "what this thread says". Context is fixed at
 * 512 tokens per the spike decision (tokens estimated roughly by characters here; the embedder
 * will truncate according to model context).
 */

// ~2000 characters is a conservative cap for ~512 tokens across common languages;
// we cap by characters (not tokens) to keep this pure and dependency-free.
const MAX_EMBED_CHARS = 2000;

/**
 * The reply headers that open a quoted mail. The mail client writes them; the quoted mail
 * follows. Everything from that line on belongs to the OTHER person's message, so the line
 * itself ends the part that is ours.
 *
 * The German marker comes with the umlaut ("Ursprüngliche") or transcribed ("Urspruengliche"),
 * the latter from mailers that cannot write one. A marker that is not recognised would leave
 * the whole quoted mail in the text to be embedded.
 */
const REPLY_HEADER_RE =
    /^\s*(?:On\s+.*\bwrote\b\s*:|Am\s+.*\bschrieb\b.*:|-----Original Message-----|-----Urspr(?:ü|ue)ngliche Nachricht-----)/i;

/**
 * The signature separator of RFC 3676: a line of exactly two dashes. Only whitespace may
 * follow, so that a sentence starting with two dashes ("-- yes, in principle") is not
 * mistaken for the end of the message.
 */
const SIGNATURE_SEP = /^--[ \t]*$/;

/**
 * Strip quoted reply lines and common reply headers/signatures; collapse whitespace.
 * Returns text to embed (subject + body combined by the caller).
 */
export function documentText(subject: string | undefined, body: string): string {
    const lines = body.split(/\r?\n/);
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Drop everything after a signature separator
        if (SIGNATURE_SEP.test(line)) {
            break;
        }
        // Drop quoted reply lines
        if (line.startsWith('>')) {
            continue;
        }
        // Drop common reply headers
        if (REPLY_HEADER_RE.test(line)) {
            break;
        }
        kept.push(line);
    }
    const subjectPart = subject && subject.trim() ? subject.trim() : '';
    const bodyPart = kept.join('\n');
    const combined = subjectPart ? (bodyPart ? `${subjectPart}\n\n${bodyPart}` : subjectPart) : bodyPart;
    // Collapse whitespace
    const collapsed = combined
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (collapsed.length <= MAX_EMBED_CHARS) {
        return collapsed;
    }
    // Hard cap by characters to avoid bloating context; prefer cutting at a word boundary
    let cut = collapsed.slice(0, MAX_EMBED_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > MAX_EMBED_CHARS * 0.8) {
        cut = cut.slice(0, lastSpace);
    }
    return cut.trim();
}
