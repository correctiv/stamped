/**
 * What an attachment says about its own history: an INDICATION, never a verdict.
 *
 * DKIM covers the message, and so the attachment's bytes as they were sent — it says nothing
 * about whether the file was made, or edited, before it was attached. The file's own metadata is
 * the only trace of that, and it is weak: anyone can set it, and many harmless tools rewrite it
 * (a PDF printer, a "save as", a mail gateway that re-packs Office files). So this answers a
 * narrow question — does the metadata contradict the message? — and says "indication, not proof".
 * It is NOT a {@link Verdict} and NOT a caveat; nothing here can change what DKIM proved.
 *
 * Two formats, on purpose: PDF (`/Info`, the XMP packet, the revision trail) and ZIP-based Office
 * files (`docProps/core.xml`). Other formats are "not examined", never "clean".
 *
 * Pure over bytes: the same attachment gives the same finding, so a stored result is a cache.
 */

import { decodeLatin1, splitMessage } from './bytes.ts';
import { headerValue, parseHeaderFields } from './headers.ts';
import { parseDate } from './message.ts';
import { type AttachmentContent, readAttachments } from './reading.ts';
import { looksLikeZip, zipEntry } from './zip.ts';

/**
 * The version of the rules in this file. A cache of findings was produced by one version;
 * CHANGING A RULE MEANS BUMPING THIS.
 */
export const ATTACHMENT_ANALYSER_VERSION = 1;

/** A file bigger than this is not examined: the scan reads all of it as one string. */
const MAX_BYTES = 64 * 1024 * 1024;

/** The properties part of an Office file is a few hundred bytes; a megabyte is already odd. */
const MAX_PROPERTIES = 1024 * 1024;

/** "Long after creation": a document edited a month later is a different document. */
export const LONG_AFTER_MS = 30 * 24 * 3600 * 1000;

/** A clock that is off by minutes is not a finding. */
const SKEW_MS = 5 * 60 * 1000;

/** A date that names no time zone could be off by a day either way. */
const UNZONED_SKEW_MS = 24 * 3600 * 1000;

export type AttachmentFormat = 'pdf' | 'office';

/** What the metadata of one attachment shows. Dates are epoch milliseconds. */
export interface AttachmentIndication {
    readonly format: AttachmentFormat;
    readonly createdAt?: number;
    readonly modifiedAt?: number;
    /** PDF: the program that wrote the file (`/Producer`). */
    readonly producer?: string;
    /** PDF: the program the document came from (`/Creator`); Office: the author. */
    readonly creator?: string;
    /** Office: who saved it last. */
    readonly lastModifiedBy?: string;
    /** PDF: saved revisions after the first, counted by `%%EOF` markers. */
    readonly updates: number;
    /** PDF: entries in the XMP edit history. Shown, not flagged: ordinary tools write them. */
    readonly historyEvents: number;
    /** Created or modified after the message says it was sent. */
    readonly modifiedAfterSent: boolean;
    /** Modified more than {@link LONG_AFTER_MS} after it was created. */
    readonly modifiedLongAfterCreation: boolean;
    /** PDF: the file was saved on top of an earlier version. */
    readonly incrementalUpdates: boolean;
}

/** Does the finding contain any of the three flags? The only thing a count may be built on. */
export function isFlagged(finding: AttachmentIndication): boolean {
    return finding.modifiedAfterSent || finding.modifiedLongAfterCreation || finding.incrementalUpdates;
}

interface Moment {
    readonly at: number;
    /** The source named a time zone, so the instant is exact. */
    readonly exact: boolean;
}

/** `D:20240501103000+02'00'` — every part after the year is optional. */
function pdfDate(value: string | undefined): Moment | undefined {
    const match =
        /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Zz])|([+-])(\d{2})'?(?:(\d{2})'?)?)?/.exec(
            (value ?? '').trim(),
        );
    if (!match) return undefined;
    const part = (index: number, fallback: number) => (match[index] ? Number(match[index]) : fallback);
    const utc = Date.UTC(Number(match[1]), part(2, 1) - 1, part(3, 1), part(4, 0), part(5, 0), part(6, 0));
    if (Number.isNaN(utc)) return undefined;
    if (match[7]) return { at: utc, exact: true };
    if (match[8]) {
        const offset = (Number(match[9]) * 60 + Number(match[10] ?? 0)) * 60 * 1000;
        return { at: utc - (match[8] === '-' ? -offset : offset), exact: true };
    }
    return { at: utc, exact: false };
}

/** An ISO 8601 date, as XMP and Office write it. */
function isoDate(value: string | undefined): Moment | undefined {
    const text = (value ?? '').trim();
    if (!/^\d{4}-\d{2}(-\d{2})?/.test(text)) return undefined;
    const exact = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
    const at = Date.parse(exact || !/T/.test(text) ? text : `${text}Z`);
    return Number.isNaN(at) ? undefined : { at, exact: exact && /T/.test(text) };
}

function clean(value: string | undefined): string | undefined {
    // eslint-disable-next-line no-control-regex
    const text = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return text === '' ? undefined : text.slice(0, 200);
}

/** The string that starts at `from` in PDF syntax: `( … )` with escapes, or `< hex >`. */
function pdfString(text: string, from: number): string | undefined {
    let raw = '';
    if (text[from] === '(') {
        let depth = 0;
        for (let at = from; at < text.length && at < from + 4096; at++) {
            const char = text[at] as string;
            if (char === '\\') {
                const next = text[++at] ?? '';
                const octal = /^[0-7]{1,3}/.exec(text.slice(at, at + 3))?.[0];
                if (octal !== undefined) {
                    raw += String.fromCharCode(parseInt(octal, 8) & 0xff);
                    at += octal.length - 1;
                } else {
                    raw +=
                        ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[next] ??
                        next;
                }
                continue;
            }
            if (char === '(' && depth++ === 0) continue;
            if (char === ')' && --depth === 0) break;
            raw += char;
        }
    } else if (text[from] === '<') {
        const end = text.indexOf('>', from);
        if (end < 0 || end - from > 8192) return undefined;
        const hex = text.slice(from + 1, end).replace(/\s+/g, '');
        if (!/^[0-9a-fA-F]*$/.test(hex)) return undefined;
        // an odd count ends on a half byte, which the spec reads as if followed by 0
        const even = hex.length % 2 === 0 ? hex : `${hex}0`;
        for (let at = 0; at < even.length; at += 2)
            raw += String.fromCharCode(parseInt(even.slice(at, at + 2), 16));
    } else {
        return undefined;
    }
    if (raw.startsWith('\u00fe\u00ff')) {
        let out = '';
        for (let at = 2; at + 1 < raw.length; at += 2)
            out += String.fromCharCode(raw.charCodeAt(at) * 256 + raw.charCodeAt(at + 1));
        return out;
    }
    return raw;
}

/** The value of a `/Key` in an Info dictionary. The LAST one wins: an update overrides. */
function pdfInfo(text: string, key: string): string | undefined {
    const pattern = new RegExp(`/${key}\\s*(?=\\(|<(?!<))`, 'g');
    let found: string | undefined;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        const value = pdfString(text, match.index + match[0].length);
        if (value !== undefined) found = value;
    }
    return found;
}

/** The text of an XMP property, as element (`<k>v</k>`) or attribute (`k="v"`); last wins. */
function xmpValue(text: string, key: string): string | undefined {
    const pattern = new RegExp(`${key}(?:>\\s*|\\s*=\\s*")([^<"]+)`, 'g');
    let found: string | undefined;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) found = match[1];
    return found;
}

function latest(...moments: (Moment | undefined)[]): Moment | undefined {
    return moments.reduce<Moment | undefined>(
        (best, moment) => (moment && (!best || moment.at > best.at) ? moment : best),
        undefined,
    );
}

function earliest(...moments: (Moment | undefined)[]): Moment | undefined {
    return moments.reduce<Moment | undefined>(
        (best, moment) => (moment && (!best || moment.at < best.at) ? moment : best),
        undefined,
    );
}

function judge(
    format: AttachmentFormat,
    created: Moment | undefined,
    modified: Moment | undefined,
    sentAt: number | undefined,
    rest: Pick<AttachmentIndication, 'producer' | 'creator' | 'lastModifiedBy' | 'updates' | 'historyEvents'>,
): AttachmentIndication {
    const newest = latest(created, modified);
    const skew = [created, modified].every((moment) => moment === undefined || moment.exact)
        ? SKEW_MS
        : UNZONED_SKEW_MS;
    return {
        format,
        ...(created ? { createdAt: created.at } : {}),
        ...(modified ? { modifiedAt: modified.at } : {}),
        ...rest,
        modifiedAfterSent: sentAt !== undefined && newest !== undefined && newest.at > sentAt + skew,
        modifiedLongAfterCreation:
            created !== undefined && modified !== undefined && modified.at - created.at > LONG_AFTER_MS,
        incrementalUpdates: rest.updates > 0,
    };
}

function analysePdf(content: Uint8Array, sentAt: number | undefined): AttachmentIndication {
    const text = decodeLatin1(content);
    const encrypted = /\/Encrypt\b/.test(text);
    const markers = text.match(/%%EOF/g)?.length ?? 0;
    // A linearized file carries two end markers by design: the first-page section and the rest.
    const linearized = /\/Linearized\b/.test(text.slice(0, 2048)) ? 1 : 0;
    const info = (key: string) => (encrypted ? undefined : clean(pdfInfo(text, key)));

    const created = earliest(pdfDate(info('CreationDate')), isoDate(xmpValue(text, 'xmp:CreateDate')));
    const modified = latest(pdfDate(info('ModDate')), isoDate(xmpValue(text, 'xmp:ModifyDate')));
    const producer = info('Producer') ?? clean(xmpValue(text, 'pdf:Producer'));
    const creator = info('Creator') ?? clean(xmpValue(text, 'xmp:CreatorTool'));
    return judge('pdf', created, modified, sentAt, {
        ...(producer ? { producer } : {}),
        ...(creator ? { creator } : {}),
        updates: Math.max(0, markers - 1 - linearized),
        historyEvents: text.match(/(?<!\/)stEvt:action(?:>|\s*=\s*")/g)?.length ?? 0,
    });
}

function analyseOffice(content: Uint8Array, sentAt: number | undefined): AttachmentIndication | undefined {
    if (!zipEntry(content, '[Content_Types].xml', MAX_PROPERTIES)) return undefined;
    const properties = zipEntry(content, 'docProps/core.xml', MAX_PROPERTIES);
    if (!properties) return undefined;
    const xml = new TextDecoder().decode(properties);
    const element = (tag: string) =>
        clean(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(xml)?.[1]);
    const creator = element('dc:creator');
    const lastModifiedBy = element('cp:lastModifiedBy');
    return judge(
        'office',
        isoDate(element('dcterms:created')),
        isoDate(element('dcterms:modified')),
        sentAt,
        {
            ...(creator ? { creator } : {}),
            ...(lastModifiedBy ? { lastModifiedBy } : {}),
            updates: 0,
            historyEvents: 0,
        },
    );
}

/**
 * The indication for one attachment, or `undefined` when it is not a format this looks at, is
 * too big, or has no readable properties. `sentAt` is the message's `Date:` in epoch ms.
 */
export function analyseAttachment(content: Uint8Array, sentAt?: number): AttachmentIndication | undefined {
    if (content.length === 0 || content.length > MAX_BYTES) return undefined;
    const head = decodeLatin1(content.subarray(0, 1024));
    if (head.includes('%PDF-')) return analysePdf(content, sentAt);
    if (looksLikeZip(content)) {
        try {
            return analyseOffice(content, sentAt);
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/** One examined attachment of a message. */
export interface AttachmentFinding {
    /** Position among the message's attachments, in the order {@link readAttachments} lists them. */
    readonly index: number;
    readonly name: string;
    readonly indication: AttachmentIndication;
}

/**
 * Every examinable attachment of one raw message, compared against the message's own `Date:`.
 * The date is the one the message states, not a proven one — only a signature that covers
 * `Date` makes it more than the sender's say-so, and that is for the verdict to tell.
 */
export function attachmentFindings(raw: Uint8Array): AttachmentFinding[] {
    const { header } = splitMessage(raw);
    const sent = parseDate(headerValue(parseHeaderFields(header), 'Date') ?? '');
    const out: AttachmentFinding[] = [];
    readAttachments(raw).forEach((attachment: AttachmentContent, index) => {
        const indication = analyseAttachment(attachment.content, sent);
        if (indication) out.push({ index, name: attachment.name, indication });
    });
    return out;
}
