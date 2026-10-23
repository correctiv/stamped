/**
 * The PDF report as data: every number and flag the document prints, with no text and no drawing.
 *
 * Kept apart from the renderer so the part a journalist has to be able to defend — which cluster is
 * flagged, how a share is computed, what an anonymised mailbox is called — runs on Node as well as
 * on GJS and is tested without a PDF library. The renderer only lays this out.
 */

import type { Verdict, VaultEntry } from '@stamped/core';
import { describeVerdict, formatPercent, VERDICTS, verdictLabel } from '@stamped/core';
import type {
    CaseReport,
    PeriodRow,
    RawSetDigest,
    BodyExplanationTotals,
    UnsignedBreakdown,
    VerdictDomains,
} from '@stamped/store';

/** A mailbox-year is flagged from this many messages, and from this multiple of the case average. */
export const CLUSTER_MIN_MESSAGES = 500;
export const CLUSTER_FACTOR = 3;

/** The domains listed per verdict. */
export const TOP_DOMAINS = 15;

export interface PdfReportInput {
    readonly caseName: string;
    readonly checkedAt: Date;
    readonly version: string;
    readonly report: CaseReport;
    readonly periods: readonly PeriodRow[];
    readonly domains: readonly VerdictDomains[];
    readonly digest: RawSetDigest;
    /** The key store's entries; empty when the case has none. */
    readonly keys: readonly VaultEntry[];
    /** Only when the person asked for it: reading it costs one raw file per unsigned message. */
    readonly unsigned?: UnsignedBreakdown;
    readonly bodyAltered?: BodyExplanationTotals;
    readonly anonymizeMailboxes?: boolean;
}

export interface VerdictShare {
    readonly verdict: Verdict;
    readonly messages: number;
    /** 0..1 of all messages; 0 for an empty case. */
    readonly share: number;
}

export interface ClusterRow {
    /** The name as shown: `M1`… when anonymised, `undefined` when no mailbox could be named. */
    readonly mailbox: string | undefined;
    readonly year?: number;
    readonly messages: number;
    readonly bodyAltered: number;
    readonly headersAltered: number;
    /** (body + headers altered) / messages. */
    readonly alteredShare: number;
    readonly flagged: boolean;
}

export interface KeyProvenance {
    readonly keys: number;
    readonly dns: number;
    readonly archiveProveEmail: number;
    readonly archive: number;
    readonly operator: number;
    /** Messages waiting on a key that is not in the store. */
    readonly messagesWithoutKey: number;
    /** Distinct (domain, selector) pairs that are missing. */
    readonly pairsWithoutKey: number;
    /** Messages whose key was found but had expired. */
    readonly messagesExpired: number;
    /** Messages whose key was found but provably cannot have made the signature. */
    readonly messagesKeyMismatch: number;
    /** Messages altered by a body hash that no key vouches for. */
    readonly messagesUnauthenticatedHash: number;
    /** Newest time a key was obtained (ISO), if any. */
    readonly lastFetched?: string;
}

export interface PdfReportModel {
    readonly caseName: string;
    readonly checkedAt: string;
    readonly version: string;
    readonly digest: RawSetDigest;
    readonly messages: number;
    readonly earliest?: string;
    readonly latest?: string;
    readonly verdicts: readonly VerdictShare[];
    readonly caseAlteredShare: number;
    readonly unsigned?: UnsignedBreakdown;
    readonly bodyAltered?: BodyExplanationTotals;
    readonly clusters: readonly ClusterRow[];
    readonly anonymized: boolean;
    readonly domains: readonly VerdictDomains[];
    readonly provenance: KeyProvenance;
}

/** A share as the report prints it: whole percent from 10, one decimal below, in the active language. */
export function percent(share: number): string {
    const pct = share * 100;
    return formatPercent(share, pct >= 10 || pct === 0 ? 0 : 1);
}

/**
 * A verdict's legend line: the same label the table uses, then the explanation. The sentence from
 * `describeVerdict` opens with its own wording of the name, which would be a second label.
 */
export function verdictLegend(verdict: Verdict): string {
    const sentence = describeVerdict(verdict);
    const at = sentence.indexOf(': ');
    return `${verdictLabel(verdict)}: ${at < 0 || at > 40 ? sentence : sentence.slice(at + 2)}`;
}

/** Zero-width spaces after `@` and `.`, so a long address wraps there and not in the middle of a word. */
export function breakableMailbox(name: string): string {
    return name.replace(/([@.])/g, '$1\u200b');
}

/** An epoch millisecond as a plain UTC date. */
function day(at: number | undefined): string | undefined {
    return at === undefined ? undefined : new Date(at).toISOString().slice(0, 10);
}

/**
 * The share of altered mail in the whole case. Both alterations count: the clusters are about
 * a shared technical cause, and an export tool can break a body or a header.
 */
function alteredShareOf(report: CaseReport): number {
    if (report.messages === 0) return 0;
    const altered = report.verdicts
        .filter((count) => count.verdict === 'body-altered' || count.verdict === 'headers-altered')
        .reduce((sum, count) => sum + count.messages, 0);
    return altered / report.messages;
}

/**
 * Mailbox-years with the flag.
 *
 * Flagged: at least {@link CLUSTER_MIN_MESSAGES} messages AND an altered share of at least
 * {@link CLUSTER_FACTOR} times the case's. A case with no altered mail flags nothing, and so does
 * a row with none: three times zero would otherwise flag everything.
 */
export function clusterRows(
    periods: readonly PeriodRow[],
    caseShare: number,
    anonymize: boolean,
): ClusterRow[] {
    // M1.. follow the mailboxes' size so the numbering is stable for one case, whatever the log order.
    const totals = new Map<string, number>();
    for (const row of periods) totals.set(row.mailbox, (totals.get(row.mailbox) ?? 0) + row.messages);
    const order = [...totals.keys()].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || (a < b ? -1 : 1));
    const alias = new Map(order.map((name, index) => [name, `M${index + 1}`]));

    const rows = periods.map((row): ClusterRow => {
        const altered = row.bodyAltered + row.headersAltered;
        const alteredShare = row.messages === 0 ? 0 : altered / row.messages;
        return {
            mailbox: anonymize ? alias.get(row.mailbox) : row.mailbox === '' ? undefined : row.mailbox,
            ...(row.year === undefined ? {} : { year: row.year }),
            messages: row.messages,
            bodyAltered: row.bodyAltered,
            headersAltered: row.headersAltered,
            alteredShare,
            flagged:
                row.messages >= CLUSTER_MIN_MESSAGES &&
                alteredShare > 0 &&
                alteredShare >= CLUSTER_FACTOR * caseShare,
        };
    });
    return rows.sort(
        (a, b) =>
            (a.mailbox ?? '').localeCompare(b.mailbox ?? '', 'en', { numeric: true }) ||
            (a.year ?? Infinity) - (b.year ?? Infinity),
    );
}

/** Where the keys came from, and how many are missing or expired. */
export function keyProvenance(keys: readonly VaultEntry[], report: CaseReport): KeyProvenance {
    const count = (origin: VaultEntry['origin']) => keys.filter((key) => key.origin === origin).length;
    const fetched = keys.map((key) => key.fetchedAt).sort();
    const last = fetched[fetched.length - 1];
    return {
        keys: keys.length,
        dns: count('dns'),
        archiveProveEmail: count('archive.prove.email'),
        archive: count('archive'),
        operator: count('operator'),
        messagesWithoutKey: report.reasons.find((r) => r.reason === 'no-key')?.messages ?? 0,
        pairsWithoutKey: report.missing.length,
        messagesExpired: report.reasons.find((r) => r.reason === 'expired')?.messages ?? 0,
        messagesKeyMismatch: report.reasons.find((r) => r.reason === 'key-mismatch')?.messages ?? 0,
        messagesUnauthenticatedHash:
            report.caveats.find((c) => c.caveat === 'body-hash-unauthenticated')?.messages ?? 0,
        ...(last === undefined ? {} : { lastFetched: last }),
    };
}

export function buildPdfModel(input: PdfReportInput): PdfReportModel {
    const { report } = input;
    const caseShare = alteredShareOf(report);
    const byVerdict = new Map(report.verdicts.map((count) => [count.verdict, count.messages]));
    return {
        caseName: input.caseName,
        checkedAt: input.checkedAt.toISOString().slice(0, 10),
        version: input.version,
        digest: input.digest,
        messages: report.messages,
        ...(day(report.earliest) === undefined ? {} : { earliest: day(report.earliest) }),
        ...(day(report.latest) === undefined ? {} : { latest: day(report.latest) }),
        verdicts: VERDICTS.map((verdict) => {
            const messages = byVerdict.get(verdict) ?? 0;
            return { verdict, messages, share: report.messages === 0 ? 0 : messages / report.messages };
        }),
        caseAlteredShare: caseShare,
        ...(input.unsigned === undefined ? {} : { unsigned: input.unsigned }),
        ...(input.bodyAltered === undefined ? {} : { bodyAltered: input.bodyAltered }),
        clusters: clusterRows(input.periods, caseShare, input.anonymizeMailboxes === true),
        anonymized: input.anonymizeMailboxes === true,
        domains: input.domains.map((entry) => ({
            verdict: entry.verdict,
            domains: entry.domains.slice(0, TOP_DOMAINS),
        })),
        provenance: keyProvenance(input.keys, report),
    };
}
