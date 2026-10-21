/**
 * `@stamped/import` — turning an archive into single messages.
 *
 * Two halves, and the split is the point. The parsing (`mbox`, `headers`, `codec`, `mime`,
 * `message`) is pure: bytes in, data out, no filesystem, so every mbox quirk and every decoder
 * is testable from a literal on both runtimes. `source.ts` and `folder.ts` are the parts that
 * open a file, and between them they decide what a path holds: `source.ts` for a source as it
 * is, `folder.ts` for a tree of mailboxes — the shape a leaked archive is handed over in.
 *
 * NOTHING HERE PRODUCES A VERDICT, and nothing here may change one. The raw octets go to the
 * store untouched and `@stamped/verify` reads those; everything this package decodes exists so a
 * journalist can FIND the message. The one exception that would be a bug is mbox `From `
 * quoting, which is undone precisely because leaving it in alters the bytes the sender signed.
 */

export { concat, decodeLatin1, encodeLatin1, splitMessage } from './bytes.ts';
export { decodeBase64, decodeCharset, decodeEncodedWords, decodeQuotedPrintable } from './codec.ts';
export {
    addressDomain,
    type HeaderField,
    headerValue,
    headerValues,
    joinedHeader,
    parseHeaderFields,
} from './headers.ts';
export {
    compareNames,
    type FolderPlan,
    type Mailbox,
    type MailPart,
    type PartKind,
    planFolder,
    type SkipReason,
    type SkippedFile,
} from './folder.ts';
export {
    looksLikeMbox,
    looksLikeSeparator,
    type MboxFlavour,
    MboxSplitter,
    type RawMessage,
    unquote,
} from './mbox.ts';
export { type MessageSummary, parseDate, summarise } from './message.ts';
export { messageText, stripHtml } from './mime.ts';
export { readMboxFile, readSource, type ReadOptions, type SourceKind, type SourceMessage } from './source.ts';
