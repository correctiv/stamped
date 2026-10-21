/**
 * `<StampedWindow>` — the three panes, and the wiring between them.
 *
 * WHAT THIS FILE IS ALLOWED TO DO. Build widgets, connect signals, and call
 * [`session.ts`](session.ts). It computes no sentence of its own: every string that depends on
 * the data comes out of [`view/`](view), already Pango-escaped, because an unescaped
 * `<ada@example.com>` makes the markup parser drop the rest of the row and a message then reads
 * as having no sender. Static section headings are written here, as they are in `window.blp` —
 * what the view models own is anything derived from a message, a verdict or a count.
 *
 * The one asymmetry worth knowing before reading on: the list rows carry the verdict the INDEX
 * recorded at import time, and the reader re-verifies from the raw bytes every time it opens a
 * message (`verifyStored`). A key collected five minutes ago changes the second and not the
 * first, which is why the reader is the pane a reader argues with and the list is only a way in.
 */

import Adw from '@girs/adw-1';
import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';
import { confirmDialog, errorDialog, registerToastOverlay, showToast } from '@gjsify/adwaita-app';
import {
    fmt,
    requestTemplate,
    _,
    type KeyPair,
    type LookupChannel,
    type MessageFinding,
    type Verdict,
} from '@stamped/core';
import type { CaseReport, IndexedMessage, ReverifyResult, SearchHit } from '@stamped/store';

import { StampedHelpButton } from './help-button.ts';
import {
    addKey,
    applyKeys,
    closeSession,
    createSession,
    importInto,
    isCaseFolder,
    knownKeyNames,
    filteredCount,
    messageOf,
    openSession,
    PAGE_SIZE,
    pageOf,
    rawTextOf,
    reportOf,
    runLookup,
    sourcesOf,
    verifyStored,
    type CaseSession,
    type Query,
} from './session.ts';
import { LOOKUP_CHANNELS, channelLabel, consentDialog } from './view/consent.ts';
import {
    caveatsHeading,
    signatureCards,
    verdictCard,
    type SignatureCard,
    type VerdictCard,
} from './view/evidence.ts';
import { groupDigits } from './view/format.ts';
// importSummary is no longer used here; subprocess prints its own summary.
import {
    explainKey,
    keyRows,
    keySummary,
    lookupPairs,
    lookupSummary,
    reverifySummary,
    type KeyRow,
} from './view/keys.ts';
import { escapeLine, noHyphens, plainText } from './view/markup.ts';
import { emptyList, headerFields, messageRows, rawHeaders, type HeaderField } from './view/message.ts';
import { overviewHeadline, overviewNextStep, overviewStats, verdictShares } from './view/overview.ts';
import { allSources, baseName, shortPath, sourceRows } from './view/sources.ts';
import { explainVerdict, filterSummary, verdictFilters } from './view/verdict.ts';

import Template, { GTypeName, InternalChildren, type Children } from './window.blp';

/*
 * Every GI async method this window awaits without a callback. The `@girs` typings declare the
 * promise overloads, so `tsc` accepts the call either way — but at runtime GJS only returns a
 * promise once the method is registered here; unregistered, it throws "At least 3 arguments
 * required" (measured on GJS 1.88.1 / GTK 4.22). `read_line_async` fails worse: the read loop
 * catches the throw as end of stream, and the import progress never moves.
 */
Gio._promisify(Adw.AlertDialog.prototype, 'choose', 'choose_finish');
Gio._promisify(Gtk.FileDialog.prototype, 'select_folder', 'select_folder_finish');
Gio._promisify(Gtk.FileDialog.prototype, 'open_multiple', 'open_multiple_finish');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish');
Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async', 'wait_check_finish');

/**
 * How long the search entry waits before it queries.
 *
 * FTS5 over a six-figure archive is fast but not free, and a query per keystroke would run five
 * of them for a word nobody has finished typing. Short enough that a pause before the next key
 * already shows results.
 */
const SEARCH_DELAY_MS = 180;

/** Children of a `Gtk.Box`, removed. Every pane rebuilds from scratch rather than diffing. */
function clearBox(box: Gtk.Box): void {
    let child = box.get_first_child();
    while (child !== null) {
        const next = child.get_next_sibling();
        box.remove(child);
        child = next;
    }
}

/** The same for a list. `remove_all` would do, but it needs GTK 4.12 and this needs none. */
function clearList(list: Gtk.ListBox): void {
    let row = list.get_row_at_index(0);
    while (row !== null) {
        list.remove(row);
        row = list.get_row_at_index(0);
    }
}

/**
 * The verdict pill.
 *
 * The colour is a libadwaita style class — `success`, `warning`, `error`, `accent`, `dimmed` —
 * and `verdict-badge` adds only the pill shape, tinting itself from `currentColor`. So the badge
 * follows the system accent and the high-contrast themes without this file knowing a single
 * colour value, and a libadwaita that renames its palette cannot silently turn a red badge grey.
 */
function badge(markup: string, cssClass: string): Gtk.Label {
    const label = new Gtk.Label({ label: markup, useMarkup: true, valign: Gtk.Align.CENTER });
    label.add_css_class('verdict-badge');
    label.add_css_class(cssClass);
    return label;
}

/** A paragraph that wraps and is left-aligned — the shape every explanation in here has. */
function wrapLabel(markup: string, ...classes: string[]): Gtk.Label {
    const label = new Gtk.Label({ label: markup, useMarkup: true, wrap: true, xalign: 0 });
    for (const name of classes) label.add_css_class(name);
    return label;
}

/** A count at the end of a sidebar row, in tabular figures so the column lines up. */
function countLabel(count: number): Gtk.Label {
    const label = new Gtk.Label({ label: groupDigits(count) });
    label.add_css_class('dimmed');
    label.add_css_class('numeric');
    return label;
}

/** One row of either sidebar list. */
function navRow(title: string, subtitle: string | undefined, icon: string): Adw.ActionRow {
    const row = new Adw.ActionRow({ title, ...(subtitle !== undefined ? { subtitle } : {}) });
    row.add_prefix(new Gtk.Image({ iconName: icon }));
    return row;
}

/** A read-only monospace view of a block of text, in a scroller that grows only so far. */
function sourceView(text: string, minHeight: number): Gtk.ScrolledWindow {
    const view = new Gtk.TextView({
        editable: false,
        cursorVisible: false,
        monospace: true,
        wrapMode: Gtk.WrapMode.WORD_CHAR,
        leftMargin: 12,
        rightMargin: 12,
        topMargin: 8,
        bottomMargin: 8,
    });
    view.get_buffer().set_text(text, -1);
    return new Gtk.ScrolledWindow({
        child: view,
        hscrollbarPolicy: Gtk.PolicyType.NEVER,
        minContentHeight: minHeight,
        maxContentHeight: 420,
        propagateNaturalHeight: true,
    });
}

/**
 * The file chooser's filters, with "All files" as the DEFAULT.
 *
 * Deliberately not the suffix filter. A real mbox archive very often has no extension at all —
 * `cur`, `Sent`, `Takeout/Mail/All mail` — so a chooser that opens filtered to `*.mbox` shows an
 * empty directory and sends the person looking for a file they can see in a terminal. The suffix
 * filter stays available for the case where it does help.
 */
function archiveFilters(dialog: Gtk.FileDialog): Gio.ListStore<Gtk.FileFilter> {
    const all = new Gtk.FileFilter({ name: _('All files') });
    all.add_pattern('*');
    const archives = new Gtk.FileFilter({ name: _('Mail archives') });
    for (const suffix of ['mbox', 'eml', 'mbx']) archives.add_suffix(suffix);

    const store = new Gio.ListStore<Gtk.FileFilter>({ itemType: Gtk.FileFilter.$gtype });
    store.append(all);
    store.append(archives);
    dialog.set_default_filter(all);
    return store;
}

/**
 * The local paths behind a multi-selection, skipping anything that has none.
 *
 * A `Gio.File` without a path is a remote one — an `smb://` share the portal handed back. The
 * importer reads from the file system, so such a file is dropped here rather than failing deeper
 * in with an error about a path that was never a path.
 */
function pathsOf(files: Gio.ListModel | null): string[] {
    const paths: string[] = [];
    for (let index = 0; index < (files?.get_n_items() ?? 0); index++) {
        const path = (files?.get_item(index) as Gio.File | null)?.get_path();
        if (path) paths.push(path);
    }
    return paths;
}

/**
 * Did the person simply close the file chooser?
 *
 * Dismissal arrives as an exception, same as a real failure, and the two must not be shown the
 * same way: an error dialog for "I changed my mind" trains people to click dialogs away.
 */
function dismissed(error: unknown): boolean {
    const gerror = error as { matches?: (domain: unknown, code: number) => boolean };
    if (typeof gerror.matches !== 'function') return false;
    const quark = Gtk.DialogError.quark();
    return (
        gerror.matches(quark, Gtk.DialogError.DISMISSED) || gerror.matches(quark, Gtk.DialogError.CANCELLED)
    );
}

// oxlint-disable-next-line no-unsafe-declaration-merging -- intentional: GJS installs the internal children (ADR 0088)
export interface StampedWindow extends Children {}

export class StampedWindow extends Adw.ApplicationWindow {
    /** The open case. Undefined is the welcome page: a window with no case is not an error. */
    private session?: CaseSession;

    /** The three halves of the query, kept apart so each filter can be cleared on its own. */
    private text = '';
    private verdict?: Verdict;
    private source?: string;

    /** The hits behind the message rows, by row index. */
    private hits: SearchHit[] = [];
    /** Cancellable for an in-flight import subprocess. */
    private importCancellable?: Gio.Cancellable;
    /** How many of the filtered messages have actually been loaded into the list. */
    private listOffset = 0;
    /** Whether a further page is being fetched right now. */
    private loadingMore = false;
    /** Whether more pages remain. */
    private hasMore = true;
    /** How many messages the current filter admits, for the counter under the list. */
    private filteredTotal = 0;
    /** The archive behind each `sourceList` row; `undefined` at index 0 — the "all" row. */
    private sources: (string | undefined)[] = [];
    /** The verdict behind each `verdictList` row, with the same rule at index 0. */
    private filters: (Verdict | undefined)[] = [];
    /** How many messages the case holds, whatever is filtered — every count's denominator. */
    private total = 0;

    /** The message the reader is showing, so a verification that lands late can be dropped. */
    private reading?: string;
    /**
     * True while a list is being rebuilt.
     *
     * `select_row` emits `row-selected`, so restoring the selection after a rebuild would run
     * the handler that set the filter the rebuild exists to show — and reset it.
     */
    private rebuilding = false;
    /** The pending search debounce, or 0. */
    private searchTimer = 0;

    static {
        GObject.registerClass({ GTypeName, Template, InternalChildren }, this);
    }

    /**
     * @param caseRoot A case folder to open at once, as `stamped <folder>` passes it. A path that
     *   is not a case leaves the welcome page up with a toast, rather than creating one: only
     *   {@link chooseCase} may create a case, and it asks first (see its doc comment).
     */
    constructor(application: Adw.Application, caseRoot?: string) {
        super({ application });
        registerToastOverlay(this._toasts);

        this.addAction('open-case', () => void this.chooseCase());
        this.addAction('import', () => void this.importFrom('files'));
        this.addAction('import-folder', () => void this.importFrom('folder'));

        this._searchEntry.connect('search-changed', () => this.onSearchChanged());

        this._messageList.connect('row-selected', (_list, row) => {
            if (this.rebuilding || row === null) return;
            const hit = this.hits[row.get_index()];
            if (hit) this.showMessage(hit.hash);
        });

        // Lazy loading: fetch the next page when the scroller nears the bottom, so a case of
        // hundreds of thousands of messages never loads more than one page at a time.
        const scroller = this._messageList.get_parent() as Gtk.ScrolledWindow | null;
        if (scroller !== null) {
            scroller.get_vadjustment().connect('value-changed', () => this.maybeLoadMore());
        }

        this._sourceList.connect('row-selected', (_list, row) => {
            if (this.rebuilding || row === null) return;
            this.source = this.sources[row.get_index()];
            this.fillList();
        });

        this._verdictList.connect('row-selected', (_list, row) => {
            if (this.rebuilding || row === null) return;
            this.verdict = this.filters[row.get_index()];
            this.fillList();
        });

        // The index handle is a connection held open on the case folder, and a folder with an
        // open connection cannot be unmounted — which is where a working copy of a leak lives.
        this.connect('close-request', () => {
            if (this.searchTimer !== 0) GLib.source_remove(this.searchTimer);
            this.searchTimer = 0;
            if (this.session) closeSession(this.session);
            this.session = undefined;
            return false;
        });

        if (caseRoot !== undefined) this.openAtStart(caseRoot);

        // The one screenshot hook. `dev/screenshots.sh` needs a named view to come up on its own:
        // the alternative is clicking the view switcher at hard-coded coordinates, which silently
        // produces a picture of the wrong page when the header bar shifts by a few pixels.
        const view = GLib.getenv('STAMPED_SHOT_VIEW');
        if (view !== null) this._contentStack.set_visible_child_name(view);
    }

    /**
     * Open the folder named on the command line, or say why not.
     *
     * A toast rather than an error dialog: the window has not been presented yet, and a dialog
     * presented on an unmapped window is a dialog nobody sees. The welcome page stays up, so the
     * mistyped path leaves the reader somewhere they can act.
     */
    private openAtStart(root: string): void {
        if (isCaseFolder(root)) {
            this.adopt(openSession(root));
            return;
        }
        showToast(escapeLine(fmt(_('{path} is not a Stamped case folder.'), { path: root })));
    }

    private addAction(name: string, activate: () => void): void {
        const action = new Gio.SimpleAction({ name });
        action.connect('activate', activate);
        this.add_action(action);
    }

    /** The query as the three filters currently stand. */
    private currentQuery(): Query {
        return {
            ...(this.text.trim() !== '' ? { text: this.text } : {}),
            ...(this.verdict !== undefined ? { verdict: this.verdict } : {}),
            ...(this.source !== undefined ? { source: this.source } : {}),
        };
    }

    private onSearchChanged(): void {
        if (this.searchTimer !== 0) GLib.source_remove(this.searchTimer);
        this.searchTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY_MS, () => {
            this.searchTimer = 0;
            this.text = this._searchEntry.get_text();
            this.fillList();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Take over a case: the old one is closed, the filters are dropped, the panes rebuild. */
    private adopt(session: CaseSession): void {
        if (this.session) closeSession(this.session);
        this.session = session;
        this.text = '';
        this.verdict = undefined;
        this.source = undefined;
        this.reading = undefined;
        this._searchEntry.set_text('');
        this._readerStack.set_visible_child_name('empty');
        // `Adw.WindowTitle` parses no markup, so it takes the path as it is — not the escaped
        // form the view models hand the rows. A case folder called `Mail & Co` would otherwise
        // appear here as `Mail &amp; Co`.
        this._caseTitle.set_title(baseName(session.root));
        this._caseTitle.set_subtitle(shortPath(session.root, GLib.get_home_dir()));
        this._rootStack.set_visible_child_name('case');
        this.refresh();
    }

    /** Everything that depends on the case. One report query feeds all three panes. */
    private refresh(): void {
        const session = this.session;
        if (!session) return;
        const report = reportOf(session);
        this.total = report.messages;
        this.fillSidebar(session, report);
        this.fillList();
        this.fillKeys(session, report);
        this.fillOverview(report);
    }

    private fillSidebar(session: CaseSession, report: CaseReport): void {
        this.rebuilding = true;

        const sources = sourcesOf(session);
        clearList(this._sourceList);
        const all = allSources(sources);
        this._sourceList.append(navRow(all.title, all.subtitle, all.icon));
        this.sources = [undefined];
        for (const row of sourceRows(sources)) {
            const item = navRow(row.title, row.subtitle, row.icon);
            item.set_tooltip_markup(row.tooltip);
            item.add_suffix(countLabel(row.messages));
            this._sourceList.append(item);
            this.sources.push(row.source);
        }

        clearList(this._verdictList);
        this.filters = [];
        for (const filter of verdictFilters(report.verdicts)) {
            const item = navRow(filter.title, undefined, filter.icon);
            item.add_suffix(countLabel(filter.count));
            if (filter.explanation !== undefined) {
                item.add_suffix(new StampedHelpButton(filter.explanation));
            }
            this._verdictList.append(item);
            this.filters.push(filter.verdict);
        }

        // A rebuild must not silently widen the view: whatever was filtered stays filtered, and
        // a source that an import removed from the log falls back to "all" rather than to a row
        // that now means something else.
        this.selectRow(this._sourceList, this.sources.indexOf(this.source));
        this.selectRow(this._verdictList, this.filters.indexOf(this.verdict));

        this.rebuilding = false;
    }

    private selectRow(list: Gtk.ListBox, index: number): void {
        list.select_row(list.get_row_at_index(index < 0 ? 0 : index));
    }

    private fillList(): void {
        const session = this.session;
        if (!session) return;
        const query = this.currentQuery();
        this.hits = [];
        this.listOffset = 0;
        this.loadingMore = false;
        this.hasMore = true;
        this.filteredTotal = filteredCount(session, query);

        this.rebuilding = true;
        clearList(this._messageList);
        this.rebuilding = false;

        this.loadMore(query, true);

        // Plain text, not markup: see `adopt` on `Adw.WindowTitle`.
        if (this.hits.length === 0) {
            const empty = emptyList(this.total, query.text);
            this._emptyState.set_title(empty.title);
            this._emptyState.set_description(empty.description);
            this._emptyState.set_icon_name(empty.icon);
            this._listStack.set_visible_child_name('empty');
            this._readerStack.set_visible_child_name('empty');
            this.reading = undefined;
        } else {
            this._listStack.set_visible_child_name('list');
        }
    }

    /** Fetch one more page and append it, unless there is nothing left or a fetch is in flight. */
    private loadMore(query: Query = this.currentQuery(), replace = false): void {
        const session = this.session;
        if (!session || this.loadingMore || !this.hasMore) return;
        this.loadingMore = true;
        const page = pageOf(session, query, this.listOffset);
        this.rebuilding = true;
        if (replace) {
            this.hits = [];
            clearList(this._messageList);
        }
        for (const row of messageRows(page)) {
            const item = new Adw.ActionRow({ title: row.title, subtitle: noHyphens(row.subtitle) });
            item.set_subtitle_lines(1);
            item.set_title_lines(1);
            item.set_tooltip_markup(row.tooltip);
            item.add_suffix(badge(row.badge, row.cssClass));
            this._messageList.append(item);
        }
        this.rebuilding = false;
        this.hits = replace ? page : this.hits.concat(page);
        this.listOffset += page.length;
        this.hasMore = page.length === PAGE_SIZE && this.listOffset < this.filteredTotal;
        this.loadingMore = false;
        this._listTitle.set_subtitle(filterSummary(this.hits.length, this.filteredTotal));
    }

    /** Triggered by the scroller: pull the next page when the bottom comes into view. */
    private maybeLoadMore(): void {
        if (this.rebuilding || this.loadingMore || !this.hasMore) return;
        const scroller = this._messageList.get_parent() as Gtk.ScrolledWindow | null;
        if (scroller === null) return;
        const adj = scroller.get_vadjustment();
        if (adj.get_value() + adj.get_page_size() >= adj.get_upper() - 200) {
            this.loadMore();
        }
    }

    /**
     * Open one message in the reader.
     *
     * The verdict is computed again here instead of read off the row: the row carries what the
     * index cached at import time, and a key collected since then changes the answer. So a click
     * costs a verification, and the pane that shows the evidence chain is never stale.
     */
    private showMessage(hash: string): void {
        const session = this.session;
        if (!session) return;
        const message = messageOf(session, hash);
        if (!message) return;

        this.reading = hash;
        verifyStored(session, hash).then(
            (finding) => {
                // Clicking down a list starts a verification per row and they can finish out of
                // order. Only the message still selected may paint — otherwise a slow one lands
                // on top of a faster later one and the pane shows another message's evidence.
                if (this.reading !== hash) return;
                if (finding === undefined) {
                    void this.fail(
                        new Error(
                            _('The stored copy of this message is missing from the case’s blob store.'),
                        ),
                    );
                    return;
                }
                this.renderMessage(message, finding, rawTextOf(session, hash) ?? '');
            },
            (error: unknown) => void this.fail(error),
        );
    }

    /** The reader, top to bottom: what Stamped claims, the headers, the evidence, the bytes. */
    private renderMessage(message: IndexedMessage, finding: MessageFinding, raw: string): void {
        clearBox(this._readerBody);
        this._readerBody.append(this.verdictCardWidget(verdictCard(finding)));
        this._readerBody.append(this.headerGroup(headerFields(message)));
        for (const card of signatureCards(finding)) {
            this._readerBody.append(this.signatureGroup(card));
        }
        if (raw !== '') this._readerBody.append(this.sourceGroup(raw));
        this._readerStack.set_visible_child_name('message');
    }

    /**
     * The verdict card.
     *
     * Badge, then the sentence, then how many signatures it rests on — and the `?` holds the
     * paragraph that answers "so can I use it?". The caveat note sits HERE rather than only in
     * the signature block below, because `signer-not-author` is what decides whether a mail that
     * looks like the CEO's reads as the CEO's.
     */
    private verdictCardWidget(card: VerdictCard): Gtk.Widget {
        const frame = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        frame.add_css_class('card');
        const body = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            marginTop: 16,
            marginBottom: 16,
            marginStart: 16,
            marginEnd: 16,
        });
        frame.append(body);

        const head = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 });
        const icon = new Gtk.Image({ iconName: card.icon, pixelSize: 24 });
        icon.add_css_class(card.cssClass);
        head.append(icon);
        head.append(badge(card.badge, card.cssClass));
        head.append(new Gtk.Box({ hexpand: true }));
        head.append(new StampedHelpButton(explainVerdict(card.verdict)));
        body.append(head);

        body.append(wrapLabel(card.sentence));
        if (card.note !== undefined) body.append(wrapLabel(card.note, 'warning'));
        body.append(wrapLabel(card.summary, 'dimmed', 'caption'));
        return frame;
    }

    /**
     * The header block, with a copy button on the fields a reader quotes elsewhere.
     *
     * Every value goes through `noHyphens`: From, To, Cc and the Message-ID are addresses, and an
     * address Pango broke with a hyphen is one a reader cannot tell from an address that has one.
     */
    private headerGroup(fields: readonly HeaderField[]): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({ title: _('Message') });
        for (const field of fields) {
            const row = new Adw.ActionRow({ title: field.label, subtitle: noHyphens(field.value) });
            row.add_css_class('property');
            row.set_subtitle_selectable(true);
            if (field.monospace) row.add_css_class('monospace');
            if (field.copy !== undefined) row.add_suffix(this.copyButton(field.copy));
            group.add(row);
        }
        return group;
    }

    /**
     * A copy button.
     *
     * Fed from {@link HeaderField.copy}, never from the displayed value: a clipboard takes text,
     * so copying the escaped form would paste `&lt;ada@example.com&gt;` into the colleague's
     * message. The same reason the hash shows twelve digits and copies all sixty-four.
     */
    private copyButton(text: string, tooltip = _('Copy')): Gtk.Button {
        const button = new Gtk.Button({
            iconName: 'edit-copy-symbolic',
            valign: Gtk.Align.CENTER,
            tooltipText: tooltip,
        });
        button.add_css_class('flat');
        button.connect('clicked', () => {
            this.get_clipboard().set(text);
            showToast(escapeLine(_('Copied.')));
        });
        return button;
    }

    /**
     * One signature's block: its own verdict in the header suffix, its facts, its caveats.
     *
     * The facts are behind an expander and the verdict is not, which is the one bit of hierarchy
     * the pane imposes. The caveats get their own expander so a collapsed block still says how
     * many there are — a caveat nobody can see is a caveat that did not happen.
     */
    private signatureGroup(card: SignatureCard): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({ title: card.heading, description: card.sentence });
        group.set_header_suffix(badge(card.badge, card.cssClass));

        const facts = new Adw.ExpanderRow({ title: _('Evidence') });
        facts.add_prefix(new Gtk.Image({ iconName: 'view-list-bullet-symbolic' }));
        for (const fact of card.facts) {
            // A fact's value is a domain, a selector, an algorithm or a base64 hash — none of them
            // text a hyphen may be inserted into. See `noHyphens`.
            const row = new Adw.ActionRow({ title: fact.label, subtitle: noHyphens(fact.value) });
            row.add_css_class('property');
            // A body hash is two base64 strings long and must be readable in full: it is the one
            // fact a reader can check by hand against the message.
            row.set_subtitle_lines(0);
            row.set_subtitle_selectable(true);
            facts.add_row(row);
        }
        group.add(facts);

        if (card.caveats.length > 0) {
            const caveats = new Adw.ExpanderRow({ title: caveatsHeading(card.caveats.length) });
            const icon = new Gtk.Image({ iconName: 'dialog-warning-symbolic' });
            icon.add_css_class('warning');
            caveats.add_prefix(icon);
            caveats.set_expanded(true);
            for (const caveat of card.caveats) {
                const row = new Adw.ActionRow({ title: caveat.text });
                row.set_title_lines(0);
                caveats.add_row(row);
            }
            group.add(caveats);
        }
        return group;
    }

    /**
     * The raw message.
     *
     * The HEADER block is shown and the body is not, because the headers are what the signature
     * covers and what the evidence chain refers to by name — `h=from:to:subject` means nothing
     * without them. The whole source, body included, goes to the clipboard, which is where
     * somebody takes it to verify it with another tool.
     */
    private sourceGroup(raw: string): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({ title: _('Raw message') });
        group.set_header_suffix(
            this.copyButton(raw, _('Copy the whole message, headers and body, as stored')),
        );
        const headers = new Adw.ExpanderRow({ title: _('Header block, as stored') });
        headers.add_prefix(new Gtk.Image({ iconName: 'format-justify-left-symbolic' }));
        // A plain `Gtk.ListBoxRow`, not an `Adw.ActionRow`: `set_child` on an action row would
        // replace the box that holds its own title and suffixes.
        const row = new Gtk.ListBoxRow({ activatable: false, selectable: false });
        row.set_child(sourceView(rawHeaders(raw), 180));
        headers.add_row(row);
        group.add(headers);
        return group;
    }

    /** The key pane: the work list, and the two ways to do the work. */
    private fillKeys(session: CaseSession, report: CaseReport): void {
        const rows = keyRows(report.keys, knownKeyNames(session.vault));
        const wanted = rows.filter((row) => row.wanted);

        clearBox(this._keysBody);
        // The badge is on the view switcher, so the number of keys still wanted is visible from
        // the message pane — the pane where the `unverifiable` verdicts that want them are read.
        this._keysPage.set_badge_number(wanted.length);
        this._keysPage.set_needs_attention(wanted.length > 0);

        this._keysBody.append(wrapLabel(keySummary(rows), 'title-4'));
        // Gated on the pairs a lookup would actually carry, not on the work list: a case whose
        // remaining `unverifiable` messages all have a key in the store has nothing to ask for,
        // and a button that would send an empty request is a prompt to disclose for nothing.
        const pairs = lookupPairs(rows);
        if (pairs.length > 0) {
            this._keysBody.append(
                wrapLabel(
                    escapeLine(
                        _(
                            'Stamped stays offline until you say otherwise, and will show you exactly what it would send.',
                        ),
                    ),
                    'dimmed',
                ),
            );
            const actions = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 });
            actions.append(this.lookupButton(pairs));
            this._keysBody.append(actions);
        }

        if (rows.length > 0) {
            const group = new Adw.PreferencesGroup({ title: _('Signing keys this case needs') });
            for (const row of rows) group.add(this.keyRowWidget(row));
            this._keysBody.append(group);
        }
    }

    /**
     * One `(domain, selector)` pair: the name, where it stands, and the ways to get the key.
     *
     * AN EXPANDER, not one row carrying everything. What this pane is for is the ranking — which
     * key, fetched once, answers the most mail — and a screenshot showed seven rows each with a
     * two-line sentence and two buttons on it, in which the order could no longer be read. So the
     * row itself holds the name, a three-word status and the `?`; the full sentence and the two
     * actions are one click down, for the pair the reader has decided to work on.
     *
     * The name goes through `noHyphens`. In that same screenshot Pango had hyphenated
     * `example.com` into `example.c-om`, and a domain that cannot be read off the screen is a
     * wrong answer in a tool whose subject is which domain signed a message.
     */
    private keyRowWidget(row: KeyRow): Adw.ExpanderRow {
        const item = new Adw.ExpanderRow({ title: noHyphens(row.name), subtitle: row.status });
        const icon = new Gtk.Image({ iconName: row.icon });
        icon.add_css_class(row.cssClass);
        item.add_prefix(icon);
        item.add_suffix(new StampedHelpButton(explainKey(row)));

        const body = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            marginTop: 12,
            marginBottom: 12,
            marginStart: 12,
            marginEnd: 12,
        });
        body.append(wrapLabel(row.subtitle, 'dimmed'));

        if (row.wanted) {
            const actions = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 });
            const paste = new Gtk.Button({ label: _('Paste Key…') });
            paste.add_css_class('suggested-action');
            paste.connect('clicked', () => void this.askPaste(row));
            actions.append(paste);

            // Offered beside the lookup, not under it: a request to the operator is the channel
            // that discloses nothing to a resolver and is the only one that still works for a
            // selector retired years ago.
            const ask = new Gtk.Button({
                label: _('Copy Request…'),
                tooltipText: _('Copy a request to send to the signing domain’s operator'),
            });
            ask.connect('clicked', () => {
                this.get_clipboard().set(requestTemplate({ domain: row.domain, selectors: [row.selector] }));
                showToast(escapeLine(_('Request copied. Paste it into a mail to the operator.')));
            });
            actions.append(ask);
            body.append(actions);
        }

        // A plain `Gtk.ListBoxRow`, not an `Adw.ActionRow`: `set_child` on an action row would
        // replace the box that holds its own title and suffixes.
        const holder = new Gtk.ListBoxRow({ activatable: false, selectable: false });
        holder.set_child(body);
        item.add_row(holder);
        return item;
    }

    /**
     * The lookup button, one entry per channel.
     *
     * A menu rather than one button, because the two channels disclose to different parties and
     * the choice is the person's. Nothing goes out from here: every entry opens the consent
     * dialog, which is the only place a lookup can be agreed to.
     */
    private lookupButton(pairs: readonly KeyPair[]): Gtk.MenuButton {
        const popover = new Gtk.Popover();
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            marginTop: 6,
            marginBottom: 6,
            marginStart: 6,
            marginEnd: 6,
        });
        for (const channel of LOOKUP_CHANNELS) {
            const entry = new Gtk.Button();
            entry.add_css_class('flat');
            // A label child rather than the button's own `label`, so two entries of different
            // lengths both start at the same edge of the popover.
            entry.set_child(new Gtk.Label({ label: channelLabel(channel), xalign: 0 }));
            entry.connect('clicked', () => {
                popover.popdown();
                void this.askLookup(channel, pairs);
            });
            box.append(entry);
        }
        popover.set_child(box);

        const button = new Gtk.MenuButton({ label: _('Look Up Missing Keys…') });
        button.add_css_class('pill');
        button.add_css_class('suggested-action');
        button.set_popover(popover);
        return button;
    }

    /**
     * Paste a key by hand.
     *
     * One field and no format picker: `parseKeyMaterial` takes a PEM block, a TXT record as `dig`
     * prints it, and a bare `p=`, which are the three forms an operator's answer actually arrives
     * in. Asking which one it is would be asking the person to classify something they were just
     * sent.
     */
    private async askPaste(row: KeyRow): Promise<void> {
        const session = this.session;
        if (!session) return;

        const dialog = new Adw.AlertDialog({
            // An `Adw.AlertDialog` heading parses no markup unless told to, so the escaped name
            // has to come back out — `plainText` is that reversal and the only one.
            heading: fmt(_('Paste the key for {name}'), { name: plainText(row.name) }),
            body: _(
                'A PEM block, a DNS TXT record as dig prints it, or just the p= value. Stamped works out which it is. An empty p= is a withdrawal, not a key, and will be refused.',
            ),
        });
        const view = new Gtk.TextView({
            monospace: true,
            wrapMode: Gtk.WrapMode.CHAR,
            topMargin: 8,
            bottomMargin: 8,
            leftMargin: 8,
            rightMargin: 8,
        });
        dialog.set_extra_child(
            new Gtk.ScrolledWindow({
                child: view,
                minContentHeight: 160,
                minContentWidth: 360,
                hasFrame: true,
            }),
        );
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('store', _('Store Key'));
        dialog.set_response_appearance('store', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('store');
        dialog.set_close_response('cancel');

        if ((await dialog.choose(this, null)) !== 'store') return;
        const buffer = view.get_buffer();
        const text = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
        if (text.trim() === '') return;

        try {
            const pair = { domain: row.domain, selector: row.selector };
            const outcome = addKey(session, pair, text);
            const applied = await applyKeys(session, [pair]);
            // A conflict means the case held a DIFFERENT key for this selector, so its toast is
            // sticky: that is a finding to read, not a confirmation to watch go by.
            showToast(escapeLine(outcome.message) + this.appliedSentence(applied), outcome.conflict ? 0 : 5);
            this.refresh();
        } catch (error) {
            await this.fail(error);
        }
    }

    /**
     * The re-verification sentence, ready to append to a toast — with its leading space, or ``.
     *
     * A space joined onto a sentence that may be empty is exactly the kind of detail that leaves
     * a stray gap in a translated string, so the two cases are decided here rather than at each
     * call site.
     */
    private appliedSentence(applied: ReverifyResult | undefined): string {
        if (!applied) return '';
        const sentence = reverifySummary(applied.checked, applied.changed.length);
        return sentence === '' ? '' : ` ${sentence}`;
    }

    /**
     * Ask before anything leaves the machine.
     *
     * EVERY PAIR IS LISTED, in full. The dialog scrolls when the list is long; it does not
     * summarise, because consent to a request nobody saw is not consent. The default response is
     * cancel, so the reflex of pressing Enter on a dialog stays offline.
     */
    private async askLookup(channel: LookupChannel, pairs: readonly KeyPair[]): Promise<void> {
        const session = this.session;
        if (!session || pairs.length === 0) return;
        const text = consentDialog(channel, pairs);

        const dialog = new Adw.AlertDialog({
            heading: text.heading,
            headingUseMarkup: true,
            body: text.body,
            bodyUseMarkup: true,
        });
        const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
        for (const item of text.items) {
            // Each item is a DNS name the request would carry. It is what consent is being given
            // to, so it is shown exactly as it would go out — `noHyphens`, never Pango's break.
            const label = new Gtk.Label({
                label: noHyphens(item),
                useMarkup: true,
                xalign: 0,
                selectable: true,
            });
            label.add_css_class('monospace');
            list.append(label);
        }
        dialog.set_extra_child(
            new Gtk.ScrolledWindow({
                child: list,
                hscrollbarPolicy: Gtk.PolicyType.AUTOMATIC,
                maxContentHeight: 220,
                minContentWidth: 320,
                propagateNaturalHeight: true,
                hasFrame: true,
            }),
        );
        // Response labels are plain text, like the heading.
        dialog.add_response('cancel', plainText(text.cancel));
        dialog.add_response('go', plainText(text.accept));
        dialog.set_response_appearance('go', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');

        if ((await dialog.choose(this, null)) !== 'go') return;
        try {
            const outcome = await runLookup(session, text.channel, text.pairs);
            const applied = await applyKeys(session, outcome.pairs);
            showToast(
                lookupSummary(outcome.stored, outcome.missed, outcome.conflicts) +
                    this.appliedSentence(applied),
                outcome.conflicts > 0 ? 0 : 5,
            );
            this.refresh();
        } catch (error) {
            await this.fail(error);
        }
    }

    /** The overview: the case in a sentence, then the numbers behind it. */
    private fillOverview(report: CaseReport): void {
        clearBox(this._overviewBody);
        this._overviewBody.append(wrapLabel(overviewHeadline(report), 'title-3'));

        const next = overviewNextStep(report);
        if (next !== undefined) {
            const frame = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 });
            frame.add_css_class('card');
            const icon = new Gtk.Image({
                iconName: 'dialog-question-symbolic',
                marginStart: 14,
                marginTop: 14,
                marginBottom: 14,
                valign: Gtk.Align.START,
            });
            icon.add_css_class('accent');
            frame.append(icon);
            const label = wrapLabel(next);
            label.set_margin_top(14);
            label.set_margin_bottom(14);
            label.set_margin_end(14);
            label.set_hexpand(true);
            frame.append(label);
            this._overviewBody.append(frame);
        }

        const stats = new Adw.PreferencesGroup({ title: _('The case') });
        for (const stat of overviewStats(report)) {
            const row = new Adw.ActionRow({ title: stat.label, subtitle: stat.value });
            row.add_css_class('property');
            row.set_subtitle_selectable(true);
            stats.add(row);
        }
        this._overviewBody.append(stats);

        const verdicts = new Adw.PreferencesGroup({
            title: _('Verdicts'),
            description: _(
                'All six are listed, including the ones at zero: a measured zero is a result, and the line most often at zero is the one that says no tampering was found.',
            ),
        });
        for (const share of verdictShares(report.verdicts)) {
            const row = new Adw.ActionRow({ title: share.label });
            const icon = new Gtk.Image({ iconName: share.icon });
            icon.add_css_class(share.cssClass);
            row.add_prefix(icon);
            const bar = new Gtk.ProgressBar({
                fraction: share.share,
                valign: Gtk.Align.CENTER,
                widthRequest: 120,
            });
            bar.add_css_class(share.cssClass);
            row.add_suffix(bar);
            const count = new Gtk.Label({ label: share.count, useMarkup: true });
            count.add_css_class('numeric');
            row.add_suffix(count);
            row.add_suffix(new StampedHelpButton(explainVerdict(share.verdict)));
            verdicts.add(row);
        }
        this._overviewBody.append(verdicts);
    }

    /**
     * Pick a case folder, and offer to create one if it is not a case yet.
     *
     * The creation needs the extra click. `caseOrThrow` refuses a folder without a `case.json`
     * and only `openCase` makes one, and that asymmetry matters more behind a file chooser than
     * on a command line: a chooser makes it easy to land one directory above the case and would
     * otherwise silently start a second, empty one there.
     */
    private async chooseCase(): Promise<void> {
        const dialog = new Gtk.FileDialog({ title: _('Open Case Folder') });
        let path: string | null;
        try {
            path = (await dialog.select_folder(this, null))?.get_path() ?? null;
        } catch (error) {
            if (!dismissed(error)) await this.fail(error);
            return;
        }
        if (path === null) return;

        try {
            if (isCaseFolder(path)) {
                this.adopt(openSession(path));
                return;
            }
            const create = await confirmDialog(this, {
                heading: _('Create a new case here?'),
                body: fmt(
                    _(
                        '{path} is not a Stamped case yet. Creating one writes a case file, a store for the raw messages and a search index into it. Nothing is sent anywhere.',
                    ),
                    { path },
                ),
                confirmLabel: _('Create Case'),
                cancelLabel: _('Cancel'),
            });
            if (create) this.adopt(createSession(path));
        } catch (error) {
            await this.fail(error);
        }
    }

    /** How the import subprocess is launched, or null when no binary can be found. */
    private importArgv(root: string, paths: readonly string[]): string[] | null {
        const gjs = process.argv[0];
        const bundle = process.argv.find((arg) => typeof arg === 'string' && arg.endsWith('.mjs'));
        if (bundle !== undefined)
            return [gjs, '-m', bundle, 'import', '--case', root, '--progress=jsonl', ...paths];
        const stamped = GLib.find_program_in_path('stamped');
        if (stamped !== null) return [stamped, 'import', '--case', root, '--progress=jsonl', ...paths];
        return null;
    }

    /** Run the import as a separate process, streaming `--progress=jsonl` into a progress bar. */
    private async runImportSubprocess(session: CaseSession, paths: readonly string[]): Promise<void> {
        const argv = this.importArgv(session.root, paths);
        if (argv === null) {
            await importInto(session, paths);
            showToast(_('Imported.'), 5);
            this.refresh();
            return;
        }

        const dialog = new Adw.AlertDialog({
            heading: _('Importing…'),
            body: _('Reading the archive. This can be cancelled; running it again resumes where it stopped.'),
        });
        const progress = new Gtk.ProgressBar({ showText: true, text: _('Starting…') });
        dialog.set_extra_child(progress);
        dialog.add_response('cancel', _('Cancel'));
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');

        this.importCancellable = new Gio.Cancellable();
        const cancellable = this.importCancellable;
        const proc = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );

        const stdout = new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe() as Gio.InputStream });

        const readPromise = (async () => {
            while (true) {
                let bytes: Uint8Array | null;
                try {
                    const result = await stdout.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
                    bytes = result[0];
                } catch {
                    bytes = null;
                }
                if (bytes === null) break;
                const text = new TextDecoder().decode(bytes).trim();
                if (text === '') continue;
                try {
                    const obj = JSON.parse(text) as {
                        done?: number;
                        total?: number;
                        rate?: number;
                        eta?: number;
                        final?: boolean;
                    };
                    const total = typeof obj.total === 'number' ? obj.total : 0;
                    const done = typeof obj.done === 'number' ? obj.done : 0;
                    if (total > 0) progress.set_fraction(Math.min(1, done / total));
                    if (typeof obj.rate === 'number') {
                        progress.set_text(
                            fmt(_(' {done} of {total} · {rate}/s'), {
                                done: String(done),
                                total: String(total),
                                rate: String(obj.rate),
                            }),
                        );
                    }
                } catch {
                    // A non-JSON line is a subprocess message, not progress.
                }
            }
        })();

        const waitPromise = proc.wait_check_async(cancellable).then(
            () => undefined,
            (error: unknown) => {
                if (!cancellable.is_cancelled()) throw error;
            },
        );

        const responsePromise = dialog.choose(this, null);
        // Start the process read loop and the dialog concurrently.
        void readPromise;
        void waitPromise;

        let cancelled = false;
        let finished = false;
        responsePromise.then((response) => {
            // Closing the dialog below answers with its close response, `cancel`, too.
            if (response === 'cancel' && !finished) {
                cancelled = true;
                cancellable.cancel();
                try {
                    proc.force_exit();
                } catch {
                    // already gone
                }
            }
        });

        try {
            await Promise.all([readPromise, waitPromise]);
        } catch (error) {
            if (!cancelled) throw error;
        } finally {
            // Nothing else closes it: a finished import would sit at 100 % until Cancel, and a
            // failed one would open its error dialog underneath.
            finished = true;
            dialog.force_close();
        }

        this.importCancellable = undefined;
        // The subprocess wrote its own index; drop our cached source filter and reload.
        session.sourceScope?.scope.close();
        session.sourceScope = undefined;
        this.refresh();
        if (cancelled) showToast(_('Import cancelled. Run it again to resume.'), 5);
    }

    /**
     * Import archives into the open case, asking for a case first if there is none.
     *
     * Two entry points because the chooser cannot do both: an mbox is a FILE and a Maildir is a
     * DIRECTORY, and a chooser that accepts files will not return a folder.
     *
     * KNOWN LIMITATION: the import runs to completion before the window repaints, so a large
     * archive freezes it for as long as it takes. `importSources` reports progress and nothing
     * here consumes it yet — a progress bar needs the import off the main loop, which is its own
     * change.
     */
    private async importFrom(kind: 'files' | 'folder'): Promise<void> {
        if (!this.session) {
            await this.chooseCase();
            if (!this.session) return;
        }
        const session = this.session;

        const dialog = new Gtk.FileDialog({
            title: kind === 'folder' ? _('Import a Mail Folder') : _('Import Mail Archives'),
        });
        if (kind === 'files') dialog.set_filters(archiveFilters(dialog));

        let paths: string[];
        try {
            if (kind === 'folder') {
                const folder = (await dialog.select_folder(this, null))?.get_path();
                paths = folder ? [folder] : [];
            } else {
                paths = pathsOf(await dialog.open_multiple(this, null));
            }
        } catch (error) {
            if (!dismissed(error)) await this.fail(error);
            return;
        }
        if (paths.length === 0) return;

        try {
            await this.runImportSubprocess(session, paths);
        } catch (error) {
            await this.fail(error);
        }
    }

    /**
     * Report a failure that is not a dismissal.
     *
     * One dialog, never a toast: these are "the case could not be opened" and "that record has an
     * empty p=", which are answers to something the person just asked for and must not slide off
     * the screen in three seconds.
     */
    private async fail(error: unknown): Promise<void> {
        const message = error instanceof Error ? error.message : String(error);
        await errorDialog(this, _('That did not work'), message, _('Close'));
    }
}
