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
import {
    orphanedImport,
    type CaseReport,
    type IndexedMessage,
    type ReverifyResult,
    type SearchHit,
} from '@stamped/store';
import type { ReadableBody } from '@stamped/import';

import { openCopy } from '../lib/open-copy.ts';
import { StampedHelpButton } from './help-button.ts';
import {
    addKey,
    applyKeys,
    closeSession,
    createSession,
    dropFilterCaches,
    importInto,
    importStatusOf,
    isCaseFolder,
    knownKeyNames,
    markImportCancelled,
    filteredCount,
    messageOf,
    openSession,
    backfillStep,
    peopleComplete,
    peopleOf,
    timelineOf,
    PAGE_SIZE,
    pageOf,
    bodyOf,
    rawTextOf,
    reportOf,
    runLookup,
    sourcesOf,
    verifyStored,
    type CaseSession,
    type Query,
    type ScopeRef,
} from './session.ts';
import { LOOKUP_CHANNELS, channelLabel, consentDialog } from './view/consent.ts';
import {
    caveatsHeading,
    signatureCards,
    verdictCard,
    type SignatureCard,
    type VerdictCard,
} from './view/evidence.ts';
import { formatBytes, groupDigits } from './view/format.ts';
import { importBannerView, importOutcome } from './view/import.ts';
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
import {
    emptyList,
    headerFields,
    mailHead,
    messageRows,
    rawHeaders,
    type HeaderField,
    type MailHead,
} from './view/message.ts';
import {
    filterBannerText,
    overviewHeadline,
    overviewInsights,
    overviewNextStep,
    overviewStats,
    tappedFilter,
    verdictShares,
    type OverviewFilter,
    type OverviewStat,
} from './view/overview.ts';
import {
    peopleIncompleteNote,
    personRows,
    timelineNote,
    timelineRows,
    type BarSegment,
} from './view/people.ts';
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
Gio._promisify(Gtk.FileLauncher.prototype, 'launch', 'launch_finish');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish');
Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async', 'wait_check_finish');

/** Settles on the next idle turn: lets the window repaint inside a long async loop. */
function nextTurn(): Promise<void> {
    return new Promise((resolve) => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

/** A live run, as the banner counts it: `running` and not orphaned. */
function isRunning(status: ReturnType<typeof importStatusOf>): boolean {
    return status?.state === 'running' && importBannerView(status)?.cancellable === true;
}

/**
 * How long the search entry waits before it queries.
 *
 * FTS5 over a six-figure archive is fast but not free, and a query per keystroke would run five
 * of them for a word nobody has finished typing. Short enough that a pause before the next key
 * already shows results.
 */
const SEARCH_DELAY_MS = 180;

/** True when the person closed a portal or chooser dialog rather than it failing. */
function isDismissed(error: unknown): boolean {
    const gerror = error as { matches?: (domain: number, code: number) => boolean };
    return gerror.matches?.(Gtk.dialog_error_quark(), Gtk.DialogError.DISMISSED) === true;
}

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

    /** The filters of the query, kept apart so each can be cleared on its own. */
    private text = '';
    private verdict?: Verdict;
    private source?: string;
    /** The scope an overview tap set: the same "where from" axis as `source`, never both. */
    private scope?: ScopeRef;

    /** The hits behind the message rows, by row index. */
    private hits: SearchHit[] = [];
    /** Cancellable for an in-flight import subprocess. */
    private importCancellable?: Gio.Cancellable;
    /** The import subprocess this window started, if any; only its Cancel button may kill it. */
    private importProc?: Gio.Subprocess;
    /** The poll source reading the status file, and whether the last tick saw a live run. */
    private importPoll = 0;
    private importWasRunning = false;
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
    /** The remote-content warning has been shown in this window; once is enough. */
    private openWarned = false;
    /**
     * True while a list is being rebuilt.
     *
     * `select_row` emits `row-selected`, so restoring the selection after a rebuild would run
     * the handler that set the filter the rebuild exists to show — and reset it.
     */
    private rebuilding = false;
    /** The pending search debounce, or 0. */
    private searchTimer = 0;
    /** The pending people-search debounce, and the idle source filling the address table. */
    private peopleTimer = 0;
    private backfillSource = 0;
    /** The idle source stepping through {@link refresh}, and whether a key lookup is running. */
    private refreshSource = 0;
    private lookupBusy = false;

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
        this._peopleSearch.connect('search-changed', () => {
            if (this.peopleTimer !== 0) GLib.source_remove(this.peopleTimer);
            this.peopleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY_MS, () => {
                this.peopleTimer = 0;
                this.fillPeople();
                return false;
            });
        });

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
            // An archive and a scope are the same question — "where did these messages come
            // from" — and a list narrowed by both would be a set nobody picked a number for.
            this.scope = undefined;
            this.fillList();
        });

        this._verdictList.connect('row-selected', (_list, row) => {
            if (this.rebuilding || row === null) return;
            this.verdict = this.filters[row.get_index()];
            this.fillList();
        });

        // The banner is the only place a scope is visible: the sidebar knows archives and
        // verdicts, and a mailbox, a signer or one key is neither. Its button clears exactly
        // what the banner says, so a verdict chosen afterwards stays chosen.
        this._filterBanner.connect('button-clicked', () => this.clearScope());
        this._importBanner.connect('button-clicked', () => this.cancelImport());

        // The index handle is a connection held open on the case folder, and a folder with an
        // open connection cannot be unmounted — which is where a working copy of a leak lives.
        this.connect('close-request', () => {
            if (this.searchTimer !== 0) GLib.source_remove(this.searchTimer);
            this.searchTimer = 0;
            if (this.peopleTimer !== 0) GLib.source_remove(this.peopleTimer);
            this.peopleTimer = 0;
            if (this.backfillSource !== 0) GLib.source_remove(this.backfillSource);
            this.backfillSource = 0;
            if (this.refreshSource !== 0) GLib.source_remove(this.refreshSource);
            this.refreshSource = 0;
            this.stopImportPoll();
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

    /** The query as the filters currently stand. */
    private currentQuery(): Query {
        return {
            ...(this.text.trim() !== '' ? { text: this.text } : {}),
            ...(this.verdict !== undefined ? { verdict: this.verdict } : {}),
            ...(this.source !== undefined ? { source: this.source } : {}),
            ...(this.scope !== undefined ? { scope: this.scope } : {}),
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

    /** Say what the list is narrowed to — or nothing: a banner without a scope is noise. */
    private updateFilterBanner(): void {
        const scope = this.scope;
        this._filterBanner.set_revealed(scope !== undefined);
        if (scope !== undefined) this._filterBanner.set_title(filterBannerText(scope));
    }

    /** The banner's button: back to the whole case, with the verdict and archive untouched. */
    private clearScope(): void {
        if (this.scope === undefined) return;
        this.scope = undefined;
        this.fillList();
    }

    /**
     * Tap an overview number: the list shows the messages that number counted.
     *
     * The rule itself lives in `tappedFilter`, where it is data and therefore tested; what is
     * left here is the window's half of the tap — turn to the list, put the sidebar back where
     * the filters say, and fill the list from the new query.
     */
    private applyFilter(filter: OverviewFilter): void {
        const next = tappedFilter(
            {
                ...(this.verdict !== undefined ? { verdict: this.verdict } : {}),
                ...(this.source !== undefined ? { source: this.source } : {}),
                ...(this.scope !== undefined ? { scope: this.scope } : {}),
            },
            filter,
        );
        this.verdict = next.verdict;
        this.source = next.source;
        this.scope = next.scope;
        this.syncSidebarSelection();
        // The tap came from the overview pane, and what it asked for is a list of messages —
        // so the window turns to it instead of leaving the person on the page they tapped.
        this._contentStack.set_visible_child_name('message');
        this.fillList();
    }

    /** The overview as rows: a tap applies its filter, children make it an expander. */
    private overviewRow(stat: OverviewStat): Adw.PreferencesRow {
        if (stat.rows !== undefined && stat.rows.length > 0) {
            const expander = new Adw.ExpanderRow({ title: stat.label });
            if (stat.value !== '') expander.set_subtitle(stat.value);
            for (const child of stat.rows) expander.add_row(this.overviewRow(child));
            return expander;
        }
        const row = new Adw.ActionRow({ title: stat.label });
        if (stat.value !== '') row.set_subtitle(noHyphens(stat.value));
        row.add_css_class('property');
        row.set_subtitle_selectable(true);
        const filter = stat.filter;
        if (filter !== undefined) {
            // `activatable-row` stays on, which is what `activated` needs: a row that filters
            // must not look inert, and its filter is the whole reason the row was tappable.
            row.connect('activated', () => this.applyFilter(filter));
        } else {
            row.set_activatable(false);
        }
        return row;
    }

    private stopImportPoll(): void {
        if (this.importPoll !== 0) GLib.source_remove(this.importPoll);
        this.importPoll = 0;
    }

    /** Take over a case: the old one is closed, the filters are dropped, the panes rebuild. */
    private adopt(session: CaseSession): void {
        if (this.session) closeSession(this.session);
        this.stopImportPoll();
        this.session = session;
        this.importWasRunning = false;
        this.importPoll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => this.pollImport());
        this.text = '';
        this.verdict = undefined;
        this.source = undefined;
        this.scope = undefined;
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

    /**
     * Everything that depends on the case. One report query feeds all three panes.
     *
     * One step per idle turn, so the main loop repaints and handles input between the queries:
     * on a slow disk each is a synchronous round trip to the database thread, and all of them in
     * one turn is what the shell reports as "not responding".
     */
    private refresh(): void {
        const session = this.session;
        if (!session) return;
        if (this.refreshSource !== 0) GLib.source_remove(this.refreshSource);
        let report: CaseReport | undefined;
        const steps: (() => void)[] = [
            () => {
                report = reportOf(session);
                this.total = report.messages;
            },
            () => this.fillSidebar(session, report!),
            () => this.fillList(),
            () => this.fillKeys(session, report!),
            () => this.fillOverview(report!),
            () => this.fillPeople(),
            () => this.fillTimeline(),
            () => this.startBackfill(session),
        ];
        let next = 0;
        this.refreshSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this.session !== session) {
                this.refreshSource = 0;
                return GLib.SOURCE_REMOVE;
            }
            try {
                steps[next++]!();
            } catch (error) {
                this.refreshSource = 0;
                void this.fail(error);
                return GLib.SOURCE_REMOVE;
            }
            if (next < steps.length) return GLib.SOURCE_CONTINUE;
            this.refreshSource = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Fill the address table of a case that predates it, a batch per idle turn.
     *
     * Short transactions between frames: the window stays usable and an import subprocess can
     * write in between. A busy database just stops the run; the next open resumes from the cursor.
     */
    private startBackfill(session: CaseSession): void {
        if (this.backfillSource !== 0) GLib.source_remove(this.backfillSource);
        this.backfillSource = 0;
        // An import writes this case: stepping the backfill beside it only makes both slower.
        // The run's end refreshes the window, and the refresh starts the backfill again.
        if (isRunning(importStatusOf(session))) return;
        if (peopleComplete(session)) return;
        this.backfillSource = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            if (this.importWasRunning) {
                this.backfillSource = 0;
                return false;
            }
            let done = true;
            try {
                done = backfillStep(session);
            } catch {
                done = true;
            }
            if (this.session !== session) {
                this.backfillSource = 0;
                return false;
            }
            if (done) {
                this.backfillSource = 0;
                this.fillPeople();
                return false;
            }
            return true;
        });
    }

    /** The people list: one row per address, a tap filters the messages to that address. */
    private fillPeople(): void {
        const session = this.session;
        clearBox(this._peopleBody);
        if (!session) return;
        if (!peopleComplete(session)) {
            this._peopleBody.append(wrapLabel(peopleIncompleteNote(), 'dimmed'));
        }
        const group = new Adw.PreferencesGroup();
        for (const person of personRows(peopleOf(session, this._peopleSearch.get_text()))) {
            const row = new Adw.ActionRow({ title: person.title, subtitle: person.subtitle });
            row.set_activatable(true);
            row.add_suffix(this.segmentBar(person.segments));
            const count = new Gtk.Label({ label: person.count });
            count.add_css_class('numeric');
            row.add_suffix(count);
            row.connect('activated', () => this.applyFilter(person.filter));
            group.add(row);
        }
        this._peopleBody.append(group);
    }

    /** The timeline: one bar per month (or day), a tap filters the messages to that period. */
    private fillTimeline(): void {
        const session = this.session;
        clearBox(this._timelineBody);
        if (!session) return;
        const data = timelineOf(session);
        this._timelineBody.append(wrapLabel(timelineNote(data), 'dimmed'));
        const group = new Adw.PreferencesGroup();
        for (const bucket of timelineRows(data)) {
            const row = new Adw.ActionRow({ title: bucket.label });
            row.set_activatable(true);
            const bar = this.segmentBar(bucket.segments, Math.max(0.02, bucket.share), 220);
            row.add_suffix(bar);
            const count = new Gtk.Label({ label: bucket.count });
            count.add_css_class('numeric');
            row.add_suffix(count);
            row.connect('activated', () => this.applyFilter(bucket.filter));
            group.add(row);
        }
        this._timelineBody.append(group);
    }

    /** Verdict-coloured slices side by side; `fraction` of `width` is filled. */
    private segmentBar(segments: readonly BarSegment[], fraction = 1, width = 120): Gtk.Widget {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, valign: Gtk.Align.CENTER });
        box.set_size_request(width, -1);
        const filled = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, hexpand: false });
        filled.set_size_request(Math.round(width * fraction), 8);
        for (const segment of segments) {
            const slice = new Gtk.LevelBar({ minValue: 0, maxValue: 1, value: 1, hexpand: true });
            slice.add_css_class(segment.cssClass);
            slice.set_size_request(Math.max(2, Math.round(width * fraction * segment.share)), 8);
            slice.set_hexpand(false);
            filled.append(slice);
        }
        box.append(filled);
        return box;
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
        this.rebuilding = false;
        this.syncSidebarSelection();
    }

    /** Put the sidebar's selection back where the filters say, without re-running its handlers. */
    private syncSidebarSelection(): void {
        this.rebuilding = true;
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
        this.updateFilterBanner();
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
                this.renderMessage(message, finding, rawTextOf(session, hash) ?? '', bodyOf(session, hash));
            },
            (error: unknown) => void this.fail(error),
        );
    }

    /** The reader, top to bottom: what Stamped claims, the headers, the evidence, the bytes. */
    private renderMessage(
        message: IndexedMessage,
        finding: MessageFinding,
        raw: string,
        body: ReadableBody | undefined,
    ): void {
        clearBox(this._readerBody);
        const card = verdictCard(finding);
        this._readerBody.append(
            this.mailSheet(mailHead(message, { locale: this.readerLocale() }), card, body, message.hash),
        );
        this._readerBody.append(this.verdictCardWidget(verdictCard(finding)));
        this._readerBody.append(this.headerGroup(headerFields(message)));
        for (const card of signatureCards(finding)) {
            this._readerBody.append(this.signatureGroup(card));
        }
        if (raw !== '') this._readerBody.append(this.sourceGroup(raw));
        this._readerStack.set_visible_child_name('message');
    }

    /** The reader's locale as a BCP 47 tag, or nothing for `Intl`'s own default. */
    private readerLocale(): string | undefined {
        const name = GLib.get_language_names()[0] ?? '';
        const tag = name.split('.')[0]?.split('@')[0]?.replace('_', '-') ?? '';
        return tag === '' || tag === 'C' ? undefined : tag;
    }

    /**
     * The mail "sheet": what a mail program shows above the body, with the verdict as its stamp.
     *
     * Everything shown here is decoded for reading and nothing in it is evidence — the verdict
     * card, the header group and the raw block below still quote the message as it stands.
     * HTML is never rendered, so opening a message here fetches nothing.
     */
    private mailSheet(
        head: MailHead,
        card: VerdictCard,
        body: ReadableBody | undefined,
        hash: string,
    ): Gtk.Widget {
        const sheet = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 });
        sheet.add_css_class('card');
        const inner = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            marginTop: 18,
            marginBottom: 14,
            marginStart: 18,
            marginEnd: 18,
        });
        sheet.append(inner);

        const top = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 });
        const title = wrapLabel(noHyphens(head.subject), 'title-2');
        title.set_hexpand(true);
        title.set_selectable(true);
        top.append(title);
        const stamp = badge(card.badge, card.cssClass);
        stamp.set_valign(Gtk.Align.START);
        top.append(stamp);
        inner.append(top);

        const lines = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
        const sender = head.fromName !== '' ? `<b>${head.fromName}</b>` : '';
        const address = head.fromAddress !== '' ? `<span alpha="65%">${head.fromAddress}</span>` : '';
        const from = wrapLabel(noHyphens([sender, address].filter((part) => part !== '').join('  ')));
        from.set_selectable(true);
        lines.append(from);
        const field = (label: string, value: string): void => {
            if (value === '') return;
            const row = wrapLabel(
                `<span alpha="65%">${escapeLine(label)}</span>  ${noHyphens(value)}`,
                'caption',
            );
            row.set_selectable(true);
            lines.append(row);
        };
        field(_('To'), head.to);
        field(_('Cc'), head.cc);
        lines.append(wrapLabel(head.date, 'caption', 'dimmed'));
        inner.append(lines);
        inner.append(new Gtk.Separator());

        if (body === undefined) {
            inner.append(wrapLabel(escapeLine(_('The stored copy could not be read.')), 'dimmed'));
        } else {
            const view = new Gtk.TextView({
                editable: false,
                cursorVisible: false,
                wrapMode: Gtk.WrapMode.WORD_CHAR,
                topMargin: 2,
                bottomMargin: 2,
                leftMargin: 0,
                rightMargin: 0,
            });
            view.get_buffer().set_text(body.text === '' ? _('(no text)') : body.text, -1);
            inner.append(view);
            if (body.attachments.length > 0) {
                inner.append(new Gtk.Separator());
                const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
                for (const attachment of body.attachments) {
                    const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
                    row.append(new Gtk.Image({ iconName: 'mail-attachment-symbolic' }));
                    const name = wrapLabel(escapeLine(attachment.name || _('(unnamed)')));
                    name.set_hexpand(true);
                    name.set_selectable(true);
                    row.append(name);
                    row.append(wrapLabel(escapeLine(formatBytes(attachment.bytes)), 'caption', 'dimmed'));
                    list.append(row);
                }
                inner.append(list);
            }
        }

        const actions = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            halign: Gtk.Align.END,
        });
        const open = new Gtk.Button({
            label: _('Open in Mail Program'),
            iconName: 'mail-send-symbolic',
            tooltipText: _('Open a read-only copy in your mail program'),
        });
        open.add_css_class('flat');
        open.connect('clicked', () => void this.openInMailProgram(hash, false));
        const openWith = new Gtk.Button({ label: _('Open With…') });
        openWith.add_css_class('flat');
        openWith.connect('clicked', () => void this.openInMailProgram(hash, true));
        const notes: string[] = [];
        if (body?.fromHtml) notes.push(_('Shown as text; the HTML was not rendered.'));
        if (body?.truncated) notes.push(_('The text is cut here; the stored message is longer.'));
        if (notes.length > 0) {
            const about = new StampedHelpButton(escapeLine(notes.join(' ')));
            about.set_halign(Gtk.Align.START);
            actions.append(about);
            actions.append(new Gtk.Box({ hexpand: true }));
        }
        actions.append(open);
        actions.append(openWith);
        actions.append(
            new StampedHelpButton(
                escapeLine(
                    _(
                        'A mail program that loads remote content tells the sender’s server that someone is reading this message right now. How a program displays a message proves nothing about it; the DKIM verdict does. The program gets a read-only copy outside the case.',
                    ),
                ),
            ),
        );
        sheet.append(actions);
        return sheet;
    }

    /**
     * Hand a READ-ONLY COPY of the message to another program.
     *
     * Never the stored file: a mail program may rewrite, move or flag what it is given, and the
     * stored bytes are what every verdict is computed from. The warning comes once per window
     * and before the first launch, because the damage of a remote image is done at the moment
     * of opening and cannot be taken back.
     */
    private async openInMailProgram(hash: string, ask: boolean): Promise<void> {
        const session = this.session;
        if (!session) return;
        try {
            if (!this.openWarned) {
                const dialog = new Adw.AlertDialog({
                    heading: _('Open in a mail program?'),
                    body: _(
                        'A mail program may load remote content. Only the verdict proves a message genuine.',
                    ),
                });
                dialog.add_response('cancel', _('Cancel'));
                dialog.add_response('open', _('Open'));
                dialog.set_response_appearance('open', Adw.ResponseAppearance.SUGGESTED);
                dialog.set_default_response('cancel');
                dialog.set_close_response('cancel');
                if ((await dialog.choose(this, null)) !== 'open') return;
                this.openWarned = true;
            }
            const copy = openCopy(session.paths, hash);
            if (copy === undefined) {
                showToast(escapeLine(_('The stored copy of this message is missing.')));
                return;
            }
            const launcher = new Gtk.FileLauncher({ file: Gio.File.new_for_path(copy), alwaysAsk: ask });
            await launcher.launch(this, null);
        } catch (error) {
            if (isDismissed(error)) return;
            const reason = error instanceof Error ? error.message : String(error);
            showToast(escapeLine(fmt(_('Could not open the message: {reason}'), { reason })));
        }
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
        if (card.why !== undefined) {
            body.append(wrapLabel(card.why));
            const details = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
            for (const fact of card.whyDetails) {
                details.append(wrapLabel(`${fact.label}: ${fact.value}`, 'caption', 'monospace'));
            }
            const expander = new Gtk.Expander({ label: _('Details') });
            expander.set_child(details);
            body.append(expander);
        }
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
            const applied = await applyKeys(session, [pair], nextTurn);
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
        if (this.lookupBusy) return;
        this.lookupBusy = true;
        this._keysBody.set_sensitive(false);
        showToast(_('Looking up keys…'), 3);
        try {
            const outcome = await runLookup(session, text.channel, text.pairs);
            const applied = await applyKeys(session, outcome.pairs, nextTurn);
            showToast(
                lookupSummary(outcome.stored, outcome.missed, outcome.conflicts) +
                    this.appliedSentence(applied),
                outcome.conflicts > 0 ? 0 : 5,
            );
            this.refresh();
        } catch (error) {
            await this.fail(error);
        } finally {
            this.lookupBusy = false;
            this._keysBody.set_sensitive(true);
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
            stats.add(this.overviewRow(stat));
        }
        this._overviewBody.append(stats);

        const verdicts = new Adw.PreferencesGroup({
            title: _('Verdicts'),
            description: _(
                'All six are listed, including the ones at zero: a measured zero is a result, and the line most often at zero is the one that says no tampering was found.',
            ),
        });
        for (const share of verdictShares(report.verdicts)) {
            // Subtitle AND `?`: the sentence says what the line means, the popover says what to do
            // with it. Escaped like everything else — `describeVerdict` is translated text.
            const row = new Adw.ActionRow({ title: share.label, subtitle: share.sentence });
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
            // The bar and the count are decoration on one filterable row: tapping it shows the
            // messages behind the number, which is the whole reason the count is there.
            row.connect('activated', () => this.applyFilter({ verdict: share.verdict }));
            verdicts.add(row);
        }
        this._overviewBody.append(verdicts);

        for (const insight of overviewInsights(report)) {
            const group = new Adw.PreferencesGroup({
                title: insight.title,
                ...(insight.description !== undefined ? { description: insight.description } : {}),
            });
            for (const stat of insight.rows) {
                group.add(this.overviewRow(stat));
            }
            this._overviewBody.append(group);
        }
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

        // No modal dialog: the banner shows the run from the status file, a CLI-started one too.
        this.importCancellable = new Gio.Cancellable();
        const cancellable = this.importCancellable;
        const proc = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
        );
        this.importProc = proc;
        this.pollImport();
        try {
            await proc.wait_check_async(cancellable);
        } catch (error) {
            if (!cancellable.is_cancelled()) throw error;
        } finally {
            this.importProc = undefined;
            this.importCancellable = undefined;
        }
        this.pollImport();
    }

    /** Cancel the import this window started; a run it did not start is never touched. */
    private cancelImport(): void {
        const proc = this.importProc;
        const session = this.session;
        if (proc === undefined || session === undefined) return;
        this.importCancellable?.cancel();
        try {
            proc.force_exit();
        } catch {
            // already gone
        }
        markImportCancelled(session);
        this.pollImport();
    }

    /** One tick of the import banner: read the status file, show it, reload when a run ends. */
    private pollImport(): boolean {
        const session = this.session;
        if (!session) return GLib.SOURCE_CONTINUE;
        const status = importStatusOf(session);
        const view = importBannerView(status);
        const own = this.importProc !== undefined;
        this._importBanner.set_revealed(view?.revealed === true);
        if (view?.revealed === true) {
            this._importBanner.set_title(view.title);
            this._importBanner.set_button_label(view.cancellable && own ? _('Cancel') : '');
        }
        const running = isRunning(status);
        if (this.importWasRunning && !running && status !== undefined) {
            dropFilterCaches(session);
            this.refresh();
            showToast(importOutcome(status, orphanedImport(status)), 5);
        }
        this.importWasRunning = running;
        return GLib.SOURCE_CONTINUE;
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
