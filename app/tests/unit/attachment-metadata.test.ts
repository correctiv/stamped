/**
 * What an attachment says about its own history: the indication, its flags, the cache behind the
 * report, and the lines the reader shows. Every file is built in code, over `example.*`.
 */

import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from '@gjsify/unit';
import type { MessageFinding } from '@stamped/core';
import {
    analyseAttachment,
    ATTACHMENT_ANALYSER_VERSION,
    attachmentFindings,
    encodeLatin1,
    readAttachments,
    summarise,
} from '@stamped/import';
import {
    attachmentBreakdown,
    attachmentMetadataComplete,
    attachmentTotals,
    backfillAttachmentMetadata,
    type CasePaths,
    digest,
    indexMessage,
    openCase,
    openIndex,
    removeMessage,
    store,
} from '@stamped/store';

import { attachmentLines, attachmentSection, indicationLines } from '../../src/lib/attachment-metadata.ts';
import { reportPhases } from '../../src/lib/report-progress.ts';

const SENT = Date.UTC(2024, 2, 5, 9, 40);
const SENT_HEADER = 'Tue, 05 Mar 2024 09:40:00 +0000';
const UNSIGNED: MessageFinding = { verdict: 'unsigned', caveats: [], signatures: [] };

function pdf(parts: {
    info?: string;
    xmp?: string;
    extra?: string;
    markers?: number;
    head?: string;
}): Uint8Array {
    const markers = parts.markers ?? 1;
    let text = `%PDF-1.7\n${parts.head ?? ''}1 0 obj\n<< ${parts.info ?? ''} >>\nendobj\n${parts.xmp ?? ''}${parts.extra ?? ''}`;
    for (let i = 0; i < markers; i++) text += `trailer\n<< /Size 2 >>\nstartxref\n0\n%%EOF\n`;
    return encodeLatin1(text);
}

const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number): number[] => [...u16(n & 0xffff), ...u16((n >>> 16) & 0xffff)];

/** A ZIP with the given entries, each stored or deflated. The CRC is not read, so it is 0. */
function zip(entries: [name: string, content: string, deflate: boolean][]): Uint8Array {
    const out: number[] = [];
    const directory: number[] = [];
    for (const [name, content, deflate] of entries) {
        const data = Buffer.from(content);
        const packed = deflate ? deflateRawSync(data) : data;
        const method = deflate ? 8 : 0;
        const local = out.length;
        const label = [...Buffer.from(name)];
        out.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0), ...u32(0));
        out.push(
            ...u32(packed.length),
            ...u32(data.length),
            ...u16(label.length),
            ...u16(0),
            ...label,
            ...packed,
        );
        directory.push(
            ...u32(0x02014b50),
            ...u16(20),
            ...u16(20),
            ...u16(0),
            ...u16(method),
            ...u16(0),
            ...u16(0),
        );
        directory.push(...u32(0), ...u32(packed.length), ...u32(data.length), ...u16(label.length));
        directory.push(...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(local), ...label);
    }
    const start = out.length;
    out.push(...directory);
    out.push(...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length));
    out.push(...u32(directory.length), ...u32(start), ...u16(0));
    return new Uint8Array(out);
}

function office(created: string, modified: string, deflate = true): Uint8Array {
    const core =
        '<?xml version="1.0"?><cp:coreProperties>' +
        '<dc:creator>Ada Example</dc:creator><cp:lastModifiedBy>Grace Example</cp:lastModifiedBy>' +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
        `<dcterms:modified xsi:type="dcterms:W3CDTF">${modified}</dcterms:modified></cp:coreProperties>`;
    return zip([
        ['[Content_Types].xml', '<Types/>', deflate],
        ['docProps/core.xml', core, deflate],
    ]);
}

function odf(
    created: string,
    modified: string,
    initial = 'Ada Example',
    editor = 'Grace Example',
): Uint8Array {
    const meta =
        '<?xml version="1.0"?><office:document-meta><office:meta>' +
        `<meta:initial-creator>${initial}</meta:initial-creator><dc:creator>${editor}</dc:creator>` +
        `<meta:creation-date>${created}</meta:creation-date><dc:date>${modified}</dc:date>` +
        '</office:meta></office:document-meta>';
    return zip([
        ['mimetype', 'application/vnd.oasis.opendocument.text', false],
        ['meta.xml', meta, true],
    ]);
}

interface ExifOptions {
    little?: boolean;
    dateTime?: string;
    original?: string;
    digitized?: string;
    software?: string;
    /** Make the Exif directory point back at IFD0. */
    cycle?: boolean;
    /** Point the Exif directory far outside the block. */
    wild?: boolean;
}

/** The TIFF structure of an EXIF block: IFD0 (Software, DateTime, ExifIFD) then the Exif directory. */
function exifTiff(options: ExifOptions): number[] {
    const little = options.little ?? true;
    const w16 = (n: number) => (little ? u16(n) : u16(n).reverse());
    const w32 = (n: number) => (little ? u32(n) : u32(n).reverse());
    const ascii = (text: string) => [...Buffer.from(`${text}\0`)];
    const entry = (tag: number, type: number, count: number, value: number) => [
        ...w16(tag),
        ...w16(type),
        ...w32(count),
        ...w32(value),
    ];
    const ifd0Entries = (options.software ? 1 : 0) + (options.dateTime ? 1 : 0) + 1;
    const exifEntries = (options.original ? 1 : 0) + (options.digitized ? 1 : 0);
    const ifd0At = 8;
    const exifAt = ifd0At + 2 + ifd0Entries * 12 + 4;
    const dataAt = exifAt + 2 + exifEntries * 12 + 4;
    const data: number[] = [];
    const place = (text: string): [count: number, at: number] => {
        const bytes = ascii(text);
        const at = dataAt + data.length;
        data.push(...bytes);
        return [bytes.length, at];
    };
    const ifd0: number[] = [];
    if (options.software) ifd0.push(...entry(0x0131, 2, ...place(options.software)));
    if (options.dateTime) ifd0.push(...entry(0x0132, 2, ...place(options.dateTime)));
    const target = options.cycle ? ifd0At : options.wild ? 0x7ffffff0 : exifAt;
    ifd0.push(...entry(0x8769, 4, 1, target));
    const exif: number[] = [];
    if (options.original) exif.push(...entry(0x9003, 2, ...place(options.original)));
    if (options.digitized) exif.push(...entry(0x9004, 2, ...place(options.digitized)));
    return [
        ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
        ...w16(42),
        ...w32(ifd0At),
        ...w16(ifd0Entries),
        ...ifd0,
        ...w32(0),
        ...w16(exifEntries),
        ...exif,
        ...w32(0),
        ...data,
    ];
}

/** A JPEG with an EXIF APP1 (when given), a comment segment, then start of scan. */
function jpeg(options?: ExifOptions, tiff?: number[]): Uint8Array {
    const out = [0xff, 0xd8, 0xff, 0xfe, 0, 6, 0x61, 0x62, 0x63, 0x64];
    const block = tiff ?? (options ? exifTiff(options) : undefined);
    if (block) {
        const payload = [...Buffer.from('Exif\0\0'), ...block];
        out.push(0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload);
    }
    out.push(0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9);
    return new Uint8Array(out);
}

function message(
    attachments: [name: string, type: string, content: Uint8Array][],
    subject = 'm',
): Uint8Array {
    const lines = [
        'From: ada@example.com',
        'To: grace@example.net',
        `Subject: ${subject}`,
        `Date: ${SENT_HEADER}`,
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain',
        '',
        'see attached',
    ];
    for (const [name, type, content] of attachments) {
        lines.push(
            '--b1',
            `Content-Type: ${type}; name="${name}"`,
            'Content-Transfer-Encoding: base64',
            `Content-Disposition: attachment; filename="${name}"`,
            '',
            Buffer.from(content).toString('base64'),
        );
    }
    lines.push('--b1--', '');
    return encodeLatin1(lines.join('\r\n'));
}

function withCase(body: (db: DatabaseSync, paths: CasePaths) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'stamped-attachments-'));
    try {
        const paths = openCase(root);
        const db = openIndex(paths);
        try {
            body(db, paths);
        } finally {
            db.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function add(db: DatabaseSync, paths: CasePaths, bytes: Uint8Array): string {
    store(paths, bytes);
    const hash = digest(bytes);
    indexMessage(db, { hash, bytes: bytes.length, summary: summarise(bytes), finding: UNSIGNED });
    return hash;
}

function rowCount(db: DatabaseSync): number {
    return Number((db.prepare('SELECT count(*) AS n FROM attachment_metadata').get() as { n: number }).n);
}

const CLEAN_PDF = pdf({
    info: '/Producer (Printer One) /CreationDate (D:20240301100000Z) /ModDate (D:20240301100000Z)',
});
const LATE_PDF = pdf({ info: '/CreationDate (D:20240301100000Z) /ModDate (D:20240420100000Z)' });
const REVISED_PDF = pdf({ info: '/CreationDate (D:20240301100000Z)', markers: 2 });

export default async () => {
    await describe('PDF indication', async () => {
        await it('says nothing about a file that predates the message', async () => {
            const finding = analyseAttachment(CLEAN_PDF, SENT);
            expect(finding?.format).toBe('pdf');
            expect(finding?.producer).toBe('Printer One');
            expect(finding?.createdAt).toBe(Date.UTC(2024, 2, 1, 10));
            expect(finding?.modifiedAfterSent).toBe(false);
            expect(finding?.modifiedLongAfterCreation).toBe(false);
            expect(finding?.incrementalUpdates).toBe(false);
        });

        await it('flags a modification after the message was sent, and long after creation', async () => {
            const finding = analyseAttachment(LATE_PDF, SENT);
            expect(finding?.modifiedAfterSent).toBe(true);
            expect(finding?.modifiedLongAfterCreation).toBe(true);
        });

        await it('flags nothing about the send date when the message has none', async () => {
            expect(analyseAttachment(LATE_PDF)?.modifiedAfterSent).toBe(false);
        });

        await it('counts saved revisions, and a linearized file starts with one extra marker', async () => {
            expect(analyseAttachment(REVISED_PDF, SENT)?.updates).toBe(1);
            expect(analyseAttachment(REVISED_PDF, SENT)?.incrementalUpdates).toBe(true);
            const linear = pdf({
                head: '<< /Linearized 1 >>\n',
                markers: 2,
                info: '/CreationDate (D:20240301100000Z)',
            });
            expect(analyseAttachment(linear, SENT)?.updates).toBe(0);
            expect(analyseAttachment(linear, SENT)?.incrementalUpdates).toBe(false);
        });

        await it('allows a clock that is minutes off, but not a date without a zone to be exact', async () => {
            const near = pdf({ info: '/CreationDate (D:20240305094300Z)' });
            expect(analyseAttachment(near, SENT)?.modifiedAfterSent).toBe(false);
            const exact = pdf({ info: '/CreationDate (D:20240305100000Z)' });
            expect(analyseAttachment(exact, SENT)?.modifiedAfterSent).toBe(true);
            const unzoned = pdf({ info: '/CreationDate (D:20240305100000)' });
            expect(analyseAttachment(unzoned, SENT)?.modifiedAfterSent).toBe(false);
            const offset = pdf({ info: "/CreationDate (D:20240305120000+02'00')" });
            expect(analyseAttachment(offset, SENT)?.createdAt).toBe(Date.UTC(2024, 2, 5, 10));
        });

        await it('does not count the end markers of a PDF embedded in a PDF', async () => {
            const inner =
                '%PDF-1.4\n1 0 obj\n<< /Length 7 >>\nstream\nBT ET\nendstream\nendobj\ntrailer\n<< >>\nstartxref\n0\n%%EOF\n';
            const embedded = pdf({
                info: '/CreationDate (D:20240301100000Z)',
                extra: `5 0 obj\n<< /Type /EmbeddedFile /Length ${inner.length} >>\nstream\n${inner}\nendstream\nendobj\n`,
            });
            expect(analyseAttachment(embedded, SENT)?.updates).toBe(0);
            expect(analyseAttachment(embedded, SENT)?.incrementalUpdates).toBe(false);
            // a real incremental update after the embedded file still counts
            const updated = pdf({
                info: '/CreationDate (D:20240301100000Z)',
                extra: `5 0 obj\n<< /Length ${inner.length} >>\nstream\n${inner}\nendstream\nendobj\n`,
                markers: 2,
            });
            expect(analyseAttachment(updated, SENT)?.updates).toBe(1);
        });

        await it('counts every marker when the stream keywords do not balance', async () => {
            const broken = pdf({ extra: '5 0 obj\n<< /Length 9 >>\nstream\nxx\n', markers: 2 });
            expect(analyseAttachment(broken, SENT)?.updates).toBe(1);
        });

        await it('lets the last Info entry win, as an update overrides', async () => {
            const text = pdf({
                info: '/Producer (First)',
                extra: '2 0 obj\n<< /Producer (Second) >>\nendobj\n',
            });
            expect(analyseAttachment(text, SENT)?.producer).toBe('Second');
        });

        await it('reads hex and UTF-16 strings and PDF escapes', async () => {
            const hex = pdf({ info: '/Producer <FEFF00410042> /Creator (Tool \\(1\\) \\101)' });
            const finding = analyseAttachment(hex, SENT);
            expect(finding?.producer).toBe('AB');
            expect(finding?.creator).toBe('Tool (1) A');
        });

        await it('falls back to the XMP packet, and shows its edit history without flagging it', async () => {
            const xmp =
                '<x:xmpmeta><xmp:CreateDate>2024-03-01T10:00:00Z</xmp:CreateDate>' +
                '<xmp:ModifyDate>2024-03-02T10:00:00Z</xmp:ModifyDate>' +
                '<xmpMM:History><rdf:Seq><rdf:li><stEvt:action>saved</stEvt:action></rdf:li>' +
                '<rdf:li><stEvt:action>saved</stEvt:action></rdf:li></rdf:Seq></xmpMM:History></x:xmpmeta>\n';
            const finding = analyseAttachment(pdf({ xmp }), SENT);
            expect(finding?.createdAt).toBe(Date.UTC(2024, 2, 1, 10));
            expect(finding?.modifiedAt).toBe(Date.UTC(2024, 2, 2, 10));
            expect(finding?.historyEvents).toBe(2);
            expect(finding?.modifiedAfterSent).toBe(false);
        });

        await it('ignores the Info strings of an encrypted file', async () => {
            const text = pdf({
                info: '/Producer (Secret) /ModDate (D:20250101000000Z)',
                extra: '/Encrypt 9 0 R\n',
            });
            const finding = analyseAttachment(text, SENT);
            expect(finding?.producer).toBe(undefined);
            expect(finding?.modifiedAfterSent).toBe(false);
        });
    });

    await describe('Office indication', async () => {
        await it('reads the properties part, stored or deflated', async () => {
            for (const deflate of [true, false]) {
                const finding = analyseAttachment(
                    office('2024-03-01T10:00:00Z', '2024-03-02T10:00:00Z', deflate),
                    SENT,
                );
                expect(finding?.format).toBe('office');
                expect(finding?.creator).toBe('Ada Example');
                expect(finding?.lastModifiedBy).toBe('Grace Example');
                expect(finding?.createdAt).toBe(Date.UTC(2024, 2, 1, 10));
                expect(finding?.modifiedAfterSent).toBe(false);
            }
        });

        await it('flags a file saved after the message was sent', async () => {
            const finding = analyseAttachment(office('2024-03-01T10:00:00Z', '2024-06-01T10:00:00Z'), SENT);
            expect(finding?.modifiedAfterSent).toBe(true);
            expect(finding?.modifiedLongAfterCreation).toBe(true);
            expect(finding?.incrementalUpdates).toBe(false);
        });
    });

    await describe('OpenDocument indication', async () => {
        await it('reads meta.xml, told from Office by its entries and not by name', async () => {
            const finding = analyseAttachment(odf('2024-03-01T10:00:00Z', '2024-03-02T10:00:00Z'), SENT);
            expect(finding?.format).toBe('odf');
            expect(finding?.creator).toBe('Ada Example');
            expect(finding?.lastModifiedBy).toBe('Grace Example');
            expect(finding?.createdAt).toBe(Date.UTC(2024, 2, 1, 10));
            expect(finding?.modifiedAt).toBe(Date.UTC(2024, 2, 2, 10));
            expect(finding?.modifiedAfterSent).toBe(false);
            expect(finding?.modifiedLongAfterCreation).toBe(false);
        });

        await it('flags a file saved after the message was sent, and long after creation', async () => {
            const finding = analyseAttachment(odf('2024-03-01T10:00:00', '2024-06-01T10:00:00'), SENT);
            expect(finding?.modifiedAfterSent).toBe(true);
            expect(finding?.modifiedLongAfterCreation).toBe(true);
            expect(finding?.incrementalUpdates).toBe(false);
        });

        await it('leaves out the last editor when it is the author', async () => {
            const finding = analyseAttachment(
                odf('2024-03-01T10:00:00Z', '2024-03-01T11:00:00Z', 'Ada Example', 'Ada Example'),
                SENT,
            );
            expect(finding?.lastModifiedBy).toBe(undefined);
        });
    });

    await describe('image indication', async () => {
        await it('reads EXIF in both byte orders', async () => {
            for (const little of [true, false]) {
                const finding = analyseAttachment(
                    jpeg({
                        little,
                        original: '2024:03:01 10:00:00',
                        dateTime: '2024:03:02 11:30:00',
                        software: 'Editor One',
                    }),
                    SENT,
                );
                expect(finding?.format).toBe('image');
                expect(finding?.createdAt).toBe(Date.UTC(2024, 2, 1, 10));
                expect(finding?.modifiedAt).toBe(Date.UTC(2024, 2, 2, 11, 30));
                expect(finding?.producer).toBe('Editor One');
                expect(finding?.modifiedAfterSent).toBe(false);
            }
        });

        await it('falls back to DateTimeDigitized, and reads a bare TIFF', async () => {
            const finding = analyseAttachment(jpeg({ digitized: '2024:03:01 10:00:00' }), SENT);
            expect(finding?.createdAt).toBe(Date.UTC(2024, 2, 1, 10));
            const tiff = analyseAttachment(
                new Uint8Array(exifTiff({ little: false, dateTime: '2024:03:02 11:30:00' })),
                SENT,
            );
            expect(tiff?.format).toBe('image');
            expect(tiff?.modifiedAt).toBe(Date.UTC(2024, 2, 2, 11, 30));
        });

        await it('applies the one-day skew, since EXIF names no time zone', async () => {
            // 10:40, an hour after the message was sent: inside the skew, so not flagged
            expect(
                analyseAttachment(jpeg({ original: '2024:03:05 10:40:00' }), SENT)?.modifiedAfterSent,
            ).toBe(false);
            expect(
                analyseAttachment(jpeg({ original: '2024:03:07 10:40:00' }), SENT)?.modifiedAfterSent,
            ).toBe(true);
        });

        await it('flags a photo edited long after it was taken', async () => {
            const finding = analyseAttachment(
                jpeg({ original: '2023:01:01 10:00:00', dateTime: '2023:06:01 10:00:00' }),
                SENT,
            );
            expect(finding?.modifiedLongAfterCreation).toBe(true);
            expect(finding?.modifiedAfterSent).toBe(false);
        });

        await it('survives a cyclic or out-of-range directory offset', async () => {
            const cyclic = analyseAttachment(jpeg({ cycle: true, dateTime: '2024:03:02 11:30:00' }), SENT);
            expect(cyclic?.modifiedAt).toBe(Date.UTC(2024, 2, 2, 11, 30));
            const wild = analyseAttachment(jpeg({ wild: true, dateTime: '2024:03:02 11:30:00' }), SENT);
            expect(wild?.modifiedAt).toBe(Date.UTC(2024, 2, 2, 11, 30));
            const nothing = analyseAttachment(jpeg({ wild: true }), SENT);
            expect(nothing).toBe(undefined);
            // the first directory itself points to the end of the world, and to its own header
            const broken = exifTiff({ dateTime: '2024:03:02 11:30:00' });
            broken.splice(4, 4, ...u32(0x7fffff00));
            expect(analyseAttachment(jpeg(undefined, broken), SENT)).toBe(undefined);
            const self = exifTiff({ dateTime: '2024:03:02 11:30:00' });
            self.splice(4, 4, ...u32(4));
            expect(analyseAttachment(jpeg(undefined, self), SENT)).toBe(undefined);
        });

        await it('answers undefined for a JPEG without EXIF, a truncated one, and a PNG', async () => {
            expect(analyseAttachment(jpeg(), SENT)).toBe(undefined);
            expect(analyseAttachment(jpeg({ dateTime: '2024:03:02 11:30:00' }).subarray(0, 30), SENT)).toBe(
                undefined,
            );
            expect(analyseAttachment(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), SENT)).toBe(
                undefined,
            );
            expect(analyseAttachment(jpeg({ dateTime: '0000:00:00 00:00:00' }), SENT)).toBe(undefined);
        });
    });

    await describe('what is not examined', async () => {
        await it('answers undefined for other formats, empty input and a ZIP without properties', async () => {
            expect(analyseAttachment(encodeLatin1('just text'), SENT)).toBe(undefined);
            expect(analyseAttachment(new Uint8Array(0), SENT)).toBe(undefined);
            expect(analyseAttachment(zip([['a.txt', 'x', false]]), SENT)).toBe(undefined);
            expect(analyseAttachment(zip([['[Content_Types].xml', '<Types/>', false]]), SENT)).toBe(
                undefined,
            );
            expect(analyseAttachment(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), SENT)).toBe(
                undefined,
            );
        });
    });

    await describe('attachments of a message', async () => {
        await it('keeps the content apart from the readable body, and numbers the examined ones', async () => {
            const raw = message([
                ['notes.txt', 'text/plain', encodeLatin1('hello')],
                ['late.pdf', 'application/pdf', LATE_PDF],
            ]);
            const all = readAttachments(raw);
            expect(all.length).toBe(2);
            expect(all[1]?.content.length).toBe(LATE_PDF.length);
            const findings = attachmentFindings(raw);
            expect(findings.length).toBe(1);
            expect(findings[0]?.index).toBe(1);
            expect(findings[0]?.name).toBe('late.pdf');
            expect(findings[0]?.indication.modifiedAfterSent).toBe(true);
        });

        await it('uses the Date header of the message as stated', async () => {
            const raw = message([['clean.pdf', 'application/pdf', CLEAN_PDF]]);
            expect(attachmentFindings(raw)[0]?.indication.modifiedAfterSent).toBe(false);
        });
    });

    await describe('attachment cache', async () => {
        const messages = () => [
            message([['clean.pdf', 'application/pdf', CLEAN_PDF]], 'one'),
            message([['late.pdf', 'application/pdf', LATE_PDF]], 'two'),
            message([['rev.pdf', 'application/pdf', REVISED_PDF]], 'three'),
            message([['n.txt', 'text/plain', encodeLatin1('x')]], 'four'),
        ];
        const EXPECTED = {
            looked: 4,
            examined: 3,
            flagged: 2,
            modifiedAfterSent: 1,
            modifiedLongAfterCreation: 1,
            incrementalUpdates: 1,
        };

        await it('is empty and incomplete until someone asks', async () => {
            withCase((db, paths) => {
                for (const bytes of messages()) add(db, paths, bytes);
                expect(rowCount(db)).toBe(0);
                expect(attachmentMetadataComplete(db)).toBe(false);
                expect(attachmentTotals(db).looked).toBe(0);
            });
        });

        await it('counts a message once, from the cache, and answers the same twice', async () => {
            withCase((db, paths) => {
                for (const bytes of messages()) add(db, paths, bytes);
                expect(attachmentBreakdown(db, paths)).toStrictEqual(EXPECTED);
                expect(attachmentBreakdown(db, paths)).toStrictEqual(EXPECTED);
                expect(attachmentMetadataComplete(db)).toBe(true);
                expect(rowCount(db)).toBe(4);
            });
        });

        await it('resumes in small batches', async () => {
            withCase((db, paths) => {
                for (const bytes of messages()) add(db, paths, bytes);
                expect(backfillAttachmentMetadata(db, paths, 3)).toStrictEqual({ done: false, processed: 3 });
                expect(attachmentMetadataComplete(db)).toBe(false);
                expect(backfillAttachmentMetadata(db, paths, 3)).toStrictEqual({ done: false, processed: 1 });
                expect(backfillAttachmentMetadata(db, paths, 3)).toStrictEqual({ done: true, processed: 0 });
                expect(attachmentTotals(db)).toStrictEqual(EXPECTED);
            });
        });

        await it('picks up a message imported after the fill', async () => {
            withCase((db, paths) => {
                for (const bytes of messages()) add(db, paths, bytes);
                attachmentBreakdown(db, paths);
                add(db, paths, message([['late2.pdf', 'application/pdf', LATE_PDF]], 'five'));
                expect(attachmentMetadataComplete(db)).toBe(false);
                expect(attachmentBreakdown(db, paths).modifiedAfterSent).toBe(2);
            });
        });

        await it('removeMessage drops the row', async () => {
            withCase((db, paths) => {
                const hashes = messages().map((bytes) => add(db, paths, bytes));
                attachmentBreakdown(db, paths);
                removeMessage(db, hashes[1] as string);
                expect(rowCount(db)).toBe(3);
            });
        });

        await it('refills when the analyser version differs', async () => {
            withCase((db, paths) => {
                for (const bytes of messages()) add(db, paths, bytes);
                attachmentBreakdown(db, paths);
                db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
                    'attachment_metadata_version',
                    String(ATTACHMENT_ANALYSER_VERSION + 1),
                );
                db.exec('UPDATE attachment_metadata SET flags = 0');
                expect(attachmentMetadataComplete(db)).toBe(false);
                expect(attachmentBreakdown(db, paths)).toStrictEqual(EXPECTED);
            });
        });
    });

    await describe('what the person reads', async () => {
        await it('leaves the section out when no attachment was examined', async () => {
            const none = {
                looked: 3,
                examined: 0,
                flagged: 0,
                modifiedAfterSent: 0,
                modifiedLongAfterCreation: 0,
                incrementalUpdates: 0,
            };
            expect(attachmentSection(none)).toBe(undefined);
        });

        await it('says "not proof" before any number, and keeps the four rows', async () => {
            const section = attachmentSection({
                looked: 9,
                examined: 4,
                flagged: 2,
                modifiedAfterSent: 1,
                modifiedLongAfterCreation: 2,
                incrementalUpdates: 0,
            });
            expect(section?.note.includes('not proof')).toBe(true);
            expect(section?.rows.map((row) => row[1])).toStrictEqual([4, 1, 2, 0]);
            expect(section?.rows[2]?.[0].includes('30 days')).toBe(true);
        });

        await it('writes the facts, then the flags with the caveat', async () => {
            const lines = indicationLines(analyseAttachment(LATE_PDF, SENT)!);
            expect(lines.length).toBe(2);
            expect(lines[0]).toBe('Created 2024-03-01 10:00 UTC · Modified 2024-04-20 10:00 UTC');
            expect(lines[1]?.includes('An indication, not proof.')).toBe(true);
            expect(indicationLines(analyseAttachment(CLEAN_PDF, SENT)!).length).toBe(1);
        });

        await it('maps lines to the position of the attachment', async () => {
            const raw = message([
                ['notes.txt', 'text/plain', encodeLatin1('hello')],
                ['late.pdf', 'application/pdf', LATE_PDF],
            ]);
            const lines = attachmentLines(raw);
            expect([...lines.keys()]).toStrictEqual([1]);
            expect(attachmentLines(encodeLatin1('not a message')).size).toBe(0);
        });

        await it('puts the attachment fill before the rendering, and only when asked for', async () => {
            expect(reportPhases(false, true)).toStrictEqual([
                'summary',
                'digest',
                'body',
                'anchors',
                'attachments',
                'render',
            ]);
            expect(reportPhases(true, true).slice(-3)).toStrictEqual(['unsigned', 'attachments', 'render']);
            expect(reportPhases(false)).toStrictEqual(['summary', 'digest', 'body', 'anchors', 'render']);
        });
    });
};
