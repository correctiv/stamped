/**
 * The PDF report, drawn: Cairo's PDF surface with Pango for the text.
 *
 * The numbers and flags come from `pdf-report-model.ts`; this file is wording and layout only. The
 * GI modules are imported inside {@link renderPdfReport}, not at the top: the model and its tests
 * run on Node, which has no `gi://`, and importing this module there must stay harmless.
 *
 * The page count is printed in every footer ("page 2/5"), and a PDF cannot be rewritten after the
 * fact, so the document is laid out TWICE: a dry run that draws nothing and counts pages, then the
 * real one. The same code runs both, so the two cannot disagree.
 */

import { describeVerdict, fmt, verdictLabel, _, _n } from '@stamped/core';

import { CLUSTER_FACTOR, CLUSTER_MIN_MESSAGES, TOP_DOMAINS, type PdfReportModel } from './pdf-report-model.ts';

/** A4 in PostScript points. */
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 56;
const FOOTER_H = 34;
const BODY_W = PAGE_W - 2 * MARGIN;
const CLUSTER_ROW_LIMIT = 150;

type Rgb = readonly [number, number, number];
const INK: Rgb = [0.1, 0.1, 0.12];
const MUTED: Rgb = [0.4, 0.4, 0.45];
const RULE: Rgb = [0.8, 0.8, 0.84];
const BOX_FILL: Rgb = [0.94, 0.95, 0.98];
const FLAG_FILL: Rgb = [1, 0.95, 0.82];

interface TextStyle {
    readonly size?: number;
    readonly bold?: boolean;
    readonly mono?: boolean;
    readonly color?: Rgb;
    readonly align?: 'left' | 'right';
    readonly gapAfter?: number;
}

/** The Cairo/Pango bits this file touches, typed loosely: the GI types are not loaded on Node. */
interface Gi {
    cairo: any;
    Pango: any;
    PangoCairo: any;
}

function escapeMarkup(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** One pass over the document: measures always, draws unless `dry`. */
class Writer {
    page = 1;
    y = MARGIN;
    private readonly cr: any;
    private readonly surface: any;

    constructor(
        private readonly gi: Gi,
        file: string,
        private readonly dry: boolean,
        private readonly total: number,
        private readonly footer: string,
    ) {
        this.surface = new gi.cairo.PDFSurface(dry ? '/dev/null' : file, PAGE_W, PAGE_H);
        this.cr = new gi.cairo.Context(this.surface);
    }

    private layout(text: string, width: number, style: TextStyle) {
        const { Pango, PangoCairo } = this.gi;
        const layout = PangoCairo.create_layout(this.cr);
        // 72 dpi: one font point is one user unit, like everything else on this page.
        PangoCairo.context_set_resolution(layout.get_context(), 72);
        const family = style.mono ? 'Monospace' : 'Sans';
        const weight = style.bold ? ' Bold' : '';
        layout.set_font_description(Pango.FontDescription.from_string(`${family}${weight} ${style.size ?? 10}`));
        layout.set_width(Math.round(width * Pango.SCALE));
        layout.set_wrap(style.mono ? Pango.WrapMode.WORD_CHAR : Pango.WrapMode.WORD_CHAR);
        layout.set_alignment(style.align === 'right' ? Pango.Alignment.RIGHT : Pango.Alignment.LEFT);
        layout.set_markup(escapeMarkup(text), -1);
        return layout;
    }

    private height(text: string, width: number, style: TextStyle): number {
        return this.layout(text, width, style).get_pixel_size()[1];
    }

    private draw(text: string, x: number, y: number, width: number, style: TextStyle): void {
        if (this.dry) return;
        const layout = this.layout(text, width, style);
        this.color(style.color ?? INK);
        this.cr.moveTo(x, y);
        this.gi.PangoCairo.show_layout(this.cr, layout);
    }

    private color(rgb: Rgb): void {
        this.cr.setSourceRGB(rgb[0], rgb[1], rgb[2]);
    }

    private fillRect(x: number, y: number, w: number, h: number, rgb: Rgb): void {
        if (this.dry) return;
        this.color(rgb);
        this.cr.rectangle(x, y, w, h);
        this.cr.fill();
    }

    private rule(y: number): void {
        if (this.dry) return;
        this.color(RULE);
        this.cr.setLineWidth(0.5);
        this.cr.moveTo(MARGIN, y);
        this.cr.lineTo(PAGE_W - MARGIN, y);
        this.cr.stroke();
    }

    private get bottom(): number {
        return PAGE_H - MARGIN - FOOTER_H;
    }

    /** Start a new page when `needed` points do not fit above the footer. */
    ensure(needed: number): void {
        if (this.y + needed > this.bottom) this.newPage();
    }

    private drawFooter(): void {
        const style: TextStyle = { size: 8, color: MUTED };
        this.rule(PAGE_H - MARGIN - FOOTER_H + 12);
        const y = PAGE_H - MARGIN - FOOTER_H + 18;
        this.draw(this.footer, MARGIN, y, BODY_W * 0.75, style);
        this.draw(
            fmt(_('Page {page}/{total}'), { page: String(this.page), total: String(this.total) }),
            MARGIN + BODY_W * 0.75,
            y,
            BODY_W * 0.25,
            { ...style, align: 'right' },
        );
    }

    newPage(): void {
        this.drawFooter();
        if (!this.dry) this.cr.showPage();
        this.page++;
        this.y = MARGIN;
    }

    finish(): number {
        this.drawFooter();
        if (!this.dry) this.cr.showPage();
        this.surface.finish();
        this.cr.$dispose();
        return this.page;
    }

    text(text: string, style: TextStyle = {}, indent = 0): void {
        const width = BODY_W - indent;
        const h = this.height(text, width, style);
        this.ensure(h);
        this.draw(text, MARGIN + indent, this.y, width, style);
        this.y += h + (style.gapAfter ?? 6);
    }

    heading(text: string): void {
        this.ensure(60);
        this.y += 8;
        this.text(text, { size: 15, bold: true, gapAfter: 4 });
        this.rule(this.y);
        this.y += 8;
    }

    subheading(text: string): void {
        this.ensure(40);
        this.text(text, { size: 11, bold: true, gapAfter: 4 });
    }

    /** A shaded box around a title and paragraphs; one page only, so it must be shorter than that. */
    box(title: string, paragraphs: readonly string[], fill: Rgb = BOX_FILL): void {
        const pad = 10;
        const inner = BODY_W - 2 * pad;
        const titleStyle: TextStyle = { size: 12, bold: true };
        const bodyStyle: TextStyle = { size: 10 };
        const heights = paragraphs.map((p) => this.height(p, inner, bodyStyle) + 6);
        const total = 2 * pad + this.height(title, inner, titleStyle) + 6 + heights.reduce((a, b) => a + b, 0);
        this.ensure(total);
        this.fillRect(MARGIN, this.y, BODY_W, total, fill);
        let y = this.y + pad;
        this.draw(title, MARGIN + pad, y, inner, titleStyle);
        y += this.height(title, inner, titleStyle) + 6;
        paragraphs.forEach((p, i) => {
            this.draw(p, MARGIN + pad, y, inner, bodyStyle);
            y += heights[i] ?? 0;
        });
        this.y += total + 10;
    }

    /** Rows of cells, columns as fractions of the body width. The first row is the header. */
    table(rows: readonly (readonly string[])[], fractions: readonly number[], options: TableOptions = {}): void {
        const widths = fractions.map((f) => f * BODY_W);
        const gap = 4;
        rows.forEach((cells, index) => {
            const header = index === 0;
            const style: TextStyle = { size: 9, bold: header, color: header ? MUTED : INK };
            const cellStyle = (col: number): TextStyle => ({
                ...style,
                ...(options.rightAligned?.includes(col) ? { align: 'right' as const } : {}),
                ...(options.mono?.includes(col) && !header ? { mono: true } : {}),
            });
            const h = Math.max(
                ...cells.map((c, col) => this.height(c, (widths[col] ?? 0) - gap, cellStyle(col))),
            );
            this.ensure(h + 4);
            if (options.highlight?.includes(index)) this.fillRect(MARGIN, this.y - 1, BODY_W, h + 3, FLAG_FILL);
            let x = MARGIN;
            cells.forEach((c, col) => {
                this.draw(c, x, this.y, (widths[col] ?? 0) - gap, cellStyle(col));
                x += widths[col] ?? 0;
            });
            this.y += h + 3;
            if (header) {
                this.rule(this.y);
                this.y += 3;
            }
        });
        this.y += 6;
    }
}

interface TableOptions {
    readonly rightAligned?: readonly number[];
    readonly mono?: readonly number[];
    readonly highlight?: readonly number[];
}

function percent(share: number): string {
    const pct = share * 100;
    return `${pct >= 10 || pct === 0 ? Math.round(pct) : pct.toFixed(1)}%`;
}

/** Lay the whole document out on `writer`. Every user-visible string is built here, at call time. */
function compose(w: Writer, model: PdfReportModel): void {
    // --- cover ---
    w.y += 40;
    w.text(_('Email verification report'), { size: 24, bold: true, gapAfter: 4 });
    w.text(_('DKIM signature check of an email archive'), { size: 12, color: MUTED, gapAfter: 24 });
    w.table(
        [
            [_('Case'), model.caseName],
            [_('Checked on'), model.checkedAt],
            [_('Stamped version'), model.version],
            [
                _('Messages'),
                model.earliest !== undefined && model.latest !== undefined
                    ? fmt(_('{count} (dated {earliest} to {latest})'), {
                          count: String(model.messages),
                          earliest: model.earliest,
                          latest: model.latest,
                      })
                    : String(model.messages),
            ],
            [
                _('Key coverage'),
                model.provenance.lastFetched !== undefined
                    ? fmt(_('{count} keys in the key store, the latest obtained on {date}'), {
                          count: String(model.provenance.keys),
                          date: model.provenance.lastFetched.slice(0, 10),
                      })
                    : _('No keys in the key store'),
            ],
            [_('SHA-256 of the raw set'), model.digest.sha256],
        ],
        [0.28, 0.72],
        { mono: [1] },
    );
    w.text(
        _(
            'The SHA-256 is computed over the sorted SHA-256 hashes of the raw messages, one per line. It changes when a message is added, removed or altered.',
        ),
        { size: 8, color: MUTED },
    );

    // --- summary ---
    w.heading(_('Summary'));
    w.text(
        fmt(_n('{count} message was checked.', '{count} messages were checked.', model.messages), {
            count: String(model.messages),
        }),
    );
    w.table(
        [
            [_('Verdict'), _('Messages'), _('Share'), ''],
            ...model.verdicts.map((v) => [verdictLabel(v.verdict), String(v.messages), percent(v.share), '']),
        ],
        [0.35, 0.2, 0.15, 0.3],
        { rightAligned: [1, 2] },
    );
    for (const v of model.verdicts) {
        if (v.messages > 0) w.text(describeVerdict(v.verdict), { size: 9, color: MUTED, gapAfter: 3 });
    }

    // --- what the verdicts mean ---
    w.y += 6;
    w.box(_('What the verdicts mean — and what they do not mean'), [
        _(
            '“Body altered” and “Headers altered” do not mean that someone manipulated the message. Archive and export software, mail gateways, character-set or line-ending conversions and mailing lists change messages in transit or at rest, and any such change breaks a signature. The verdict says that the message no longer matches its signature, not why.',
        ),
        _(
            '“Unsigned” does not mean forged. Many senders and servers never signed their mail, and some archives remove or rename signatures. Without a signature a message is neither confirmed nor contradicted.',
        ),
        _(
            '“Unverifiable” is not a negative finding. It means that the key needed to check the signature was not available, or could not be used. Nothing could be checked, in either direction.',
        ),
    ]);

    // --- unsigned breakdown ---
    if (model.unsigned !== undefined) {
        const u = model.unsigned;
        w.heading(_('Why messages are unsigned'));
        w.text(
            fmt(
                _n(
                    'Read from the header block of {count} unsigned message. The groups overlap: one message can be in several.',
                    'Read from the header blocks of {count} unsigned messages. The groups overlap: one message can be in several.',
                    u.examined,
                ),
                { count: String(u.examined) },
            ),
            { size: 9 },
        );
        const rows: string[][] = [
            [_('Reason'), _('Messages')],
            [_('Never transported (no Received header)'), String(u.neverTransported)],
            [_('Signature header renamed'), String(u.renamedSignature)],
            [_('dkim=pass in Authentication-Results'), String(u.authResultsPass)],
            [_('ARC signature only'), String(u.arcOnly)],
        ];
        if (u.embedded !== undefined) rows.push([_('Signature only in an embedded message'), String(u.embedded)]);
        w.table(rows, [0.75, 0.25], { rightAligned: [1] });
    }

    // --- clusters ---
    w.heading(_('Altered mail by mailbox and year'));
    if (model.clusters.length === 0) {
        w.text(_('The import log names no mailboxes and no messages were dated.'), { size: 9 });
    } else {
        w.text(
            fmt(
                _(
                    'A row is flagged when it holds at least {min} messages and its altered share is at least {factor} times the share of the whole case ({share}).',
                ),
                {
                    min: String(CLUSTER_MIN_MESSAGES),
                    factor: String(CLUSTER_FACTOR),
                    share: percent(model.caseAlteredShare),
                },
            ),
            { size: 9 },
        );
        if (model.anonymized) {
            w.text(_('Mailbox names are replaced by M1, M2, … in the order of their size.'), { size: 9 });
        }
        const shown = model.clusters.slice(0, CLUSTER_ROW_LIMIT);
        const rows: string[][] = [
            [_('Mailbox'), _('Year'), _('Messages'), _('Altered'), _('Share'), ''],
            ...shown.map((c) => [
                c.mailbox ?? _('(unnamed)'),
                c.year === undefined ? _('undated') : String(c.year),
                String(c.messages),
                String(c.bodyAltered + c.headersAltered),
                percent(c.alteredShare),
                c.flagged ? _('Flagged') : '',
            ]),
        ];
        w.table(rows, [0.32, 0.1, 0.14, 0.14, 0.12, 0.18], {
            rightAligned: [2, 3, 4],
            highlight: shown.flatMap((c, i) => (c.flagged ? [i + 1] : [])),
        });
        if (model.clusters.length > shown.length) {
            w.text(
                fmt(_('{count} further rows are not shown.'), {
                    count: String(model.clusters.length - shown.length),
                }),
                { size: 9, color: MUTED },
            );
        }
        if (model.clusters.some((c) => c.flagged)) {
            w.box(
                _('Notable concentration'),
                [
                    _(
                        'Notable concentration – points to a common technical cause (e.g. archive or export software); no statement about individual messages.',
                    ),
                ],
                FLAG_FILL,
            );
        }
    }

    // --- domains ---
    w.heading(fmt(_('Top {n} signing domains per verdict'), { n: String(TOP_DOMAINS) }));
    if (model.domains.length === 0) {
        w.text(_('No message carries a signature.'), { size: 9 });
    }
    for (const entry of model.domains) {
        w.subheading(verdictLabel(entry.verdict));
        w.table(
            [[_('Domain'), _('Messages')], ...entry.domains.map((d) => [d.domain, String(d.messages)])],
            [0.75, 0.25],
            { rightAligned: [1] },
        );
    }

    // --- key provenance ---
    const p = model.provenance;
    w.heading(_('Where the keys come from'));
    w.table(
        [
            [_('Source'), _('Keys')],
            [_('Published DNS record, looked up with consent'), String(p.dns)],
            [_('archive.prove.email (a third party’s snapshots)'), String(p.archiveProveEmail)],
            [_('Shipped with the archive'), String(p.archive)],
            [_('Supplied by the operator'), String(p.operator)],
        ],
        [0.75, 0.25],
        { rightAligned: [1] },
    );
    w.text(
        fmt(
            _n(
                '{messages} message waits for a key that is not in the store ({pairs} distinct selectors in total).',
                '{messages} messages wait for a key that is not in the store ({pairs} distinct selectors in total).',
                p.messagesWithoutKey,
            ),
            { messages: String(p.messagesWithoutKey), pairs: String(p.pairsWithoutKey) },
        ),
        { size: 9 },
    );
    w.text(
        fmt(
            _n(
                '{count} message could not be checked because its key had expired.',
                '{count} messages could not be checked because their key had expired.',
                p.messagesExpired,
            ),
            { count: String(p.messagesExpired) },
        ),
        { size: 9 },
    );

    // --- method ---
    w.heading(_('Method and limits'));
    for (const paragraph of [
        _(
            'Each DKIM signature (RFC 6376) of each message was checked on its own: the hash of the body, then the signature over the signed header fields, against the public key published for the signing domain and selector.',
        ),
        _(
            'A valid signature proves that the signed parts of the message are unchanged since the signing server added it. It does not prove who wrote the message, and it says nothing about the parts the signature does not cover.',
        ),
        _(
            'Keys are taken from the key store of the case. Stamped does not query DNS on its own; a key that was not supplied is reported as missing, not guessed.',
        ),
        fmt(
            _(
                'Tool: Stamped {version}. Every figure in this report can be reproduced from the raw messages with `stamped reverify` and `stamped report`.',
            ),
            { version: model.version },
        ),
    ]) {
        w.text(paragraph, { size: 10 });
    }
}

/**
 * Write the report to `file`.
 *
 * Async only because the GI modules are loaded on demand; the drawing itself is synchronous.
 */
export async function renderPdfReport(model: PdfReportModel, file: string): Promise<{ pages: number }> {
    const cairo = (await import('cairo')).default;
    const Pango = (await import('@girs/pango-1.0')).default;
    const PangoCairo = (await import('@girs/pangocairo-1.0')).default;
    const gi: Gi = { cairo, Pango, PangoCairo };
    const footer = fmt(_('{case} · {date}'), { case: model.caseName, date: model.checkedAt });

    const dry = new Writer(gi, file, true, 0, footer);
    compose(dry, model);
    const total = dry.finish();

    const real = new Writer(gi, file, false, total, footer);
    compose(real, model);
    return { pages: real.finish() };
}
