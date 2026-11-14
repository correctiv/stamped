/**
 * The two GObjects behind the virtualized message list.
 *
 * `MessageItem` is what the `Gio.ListStore` holds: the view model of one row, built once when its
 * page arrives. `MessageRowView` is what the `Gtk.ListView` shows: a handful of them exist, one
 * per visible row, and `bind` repoints each at whatever item scrolled under it. Nothing here
 * computes a sentence — `view/message.ts` already did, and escaped it.
 */

import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';
import Pango from '@girs/pango-1.0';
import type { Mark } from '@stamped/store';

import { DEFAULT_DENSITY, rowMetrics, type Density } from '../lib/density.ts';
import { MAX_CHIPS, tagChips } from './view/marks.ts';
import { noHyphens } from './view/markup.ts';
import type { MessageRow } from './view/message.ts';

/** Nothing marked — the answer for every message the marks file does not name. */
const UNMARKED: Mark = { tags: [], bookmark: false };

export class MessageItem extends GObject.Object {
    static {
        GObject.registerClass({ GTypeName: 'StampedMessageItem' }, this);
    }

    readonly row: MessageRow;
    /** The escaped "found by meaning" badge text, when the hit did not come from the words. */
    readonly found: string | undefined;
    /**
     * What the person marked on this message; {@link UNMARKED} when they marked nothing.
     *
     * Mutable, where the rest of the item is not: a mark is the one thing about a row that
     * changes while the row is on screen, and the window replaces it and re-binds that one row
     * rather than refilling the list under the person's selection (`refreshRowMarks`).
     */
    mark: Mark;

    constructor(row: MessageRow, found?: string, mark: Mark | undefined = UNMARKED) {
        super();
        this.row = row;
        this.found = found;
        this.mark = mark;
    }
}

/**
 * The width the bookmark column always takes, marked or not.
 *
 * A star shown with `visible` takes its allocation away when it is hidden, and then every
 * unmarked row's text starts 14 px further left than its marked neighbour's: scrolling a list in
 * which some messages are bookmarked made the whole column of senders jitter sideways. So the
 * slot is always there and the star is drawn at opacity 0 — see {@link MessageRowView.bind}.
 */
const STAR_WIDTH = 14;

export class MessageRowView extends Gtk.Box {
    static {
        GObject.registerClass({ GTypeName: 'StampedMessageRowView' }, this);
    }

    private readonly star: Gtk.Image;
    private readonly title: Gtk.Label;
    private readonly subtitle: Gtk.Label;
    private readonly chipBox: Gtk.Box;
    /** {@link MAX_CHIPS} chips plus the `+N` counter, made once and re-labelled on every bind. */
    private readonly chips: Gtk.Label[];
    private readonly more: Gtk.Label;
    private readonly found: Gtk.Label;
    private readonly verdict: Gtk.Label;
    private verdictClass = '';

    /**
     * `density` decides the row's height and nothing else: a compact row shows every part a
     * comfortable one does. It is given at SETUP time, which is why changing the setting hands
     * the list a new factory rather than reaching into the rows that exist (see `applyDensity` in
     * window.ts) — a `Gtk.ListView` owns its rows and recycles them.
     */
    constructor(density: Density = DEFAULT_DENSITY) {
        const { marginVertical, spacing, chipGap } = rowMetrics(density);
        super({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing,
            marginTop: marginVertical,
            marginBottom: marginVertical,
            marginStart: 6,
            marginEnd: 6,
        });
        this.star = new Gtk.Image({
            iconName: 'starred-symbolic',
            pixelSize: STAR_WIDTH,
            valign: Gtk.Align.START,
            marginTop: 2,
        });
        this.star.set_size_request(STAR_WIDTH, -1);
        const text = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        this.title = new Gtk.Label({ useMarkup: true, xalign: 0, ellipsize: Pango.EllipsizeMode.END });
        this.subtitle = new Gtk.Label({ useMarkup: true, xalign: 0, ellipsize: Pango.EllipsizeMode.END });
        this.subtitle.add_css_class('dimmed');
        this.subtitle.add_css_class('caption');
        // A LINE OF ITS OWN, under the contact line rather than beside it: a chip next to the
        // sender competes with it for the same width, and the sender is what the row is read for.
        this.chipBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            marginTop: chipGap,
        });
        this.chips = [];
        for (let index = 0; index < MAX_CHIPS; index++) {
            const chip = this.chip();
            this.chips.push(chip);
            this.chipBox.append(chip);
        }
        this.more = this.chip();
        this.more.add_css_class('dimmed');
        this.chipBox.append(this.more);
        text.append(this.title);
        text.append(this.subtitle);
        text.append(this.chipBox);
        this.found = this.badge();
        this.found.add_css_class('dimmed');
        this.verdict = this.badge();
        this.append(this.star);
        this.append(text);
        this.append(this.found);
        this.append(this.verdict);
    }

    /** The verdict pill; colour is a libadwaita style class, see `badge` in window.ts. */
    private badge(): Gtk.Label {
        const label = new Gtk.Label({ useMarkup: true, valign: Gtk.Align.CENTER });
        label.add_css_class('verdict-badge');
        return label;
    }

    /**
     * One tag chip. NO MARKUP: the label is the person's own tag, shortened by `tagChips`, and a
     * tag holding an `&` would be dropped by the Pango parser the other labels here go through.
     */
    private chip(): Gtk.Label {
        const label = new Gtk.Label({ valign: Gtk.Align.CENTER });
        label.add_css_class('tag-chip');
        return label;
    }

    bind(item: MessageItem): void {
        const { row, mark } = item;
        this.title.set_label(row.title);
        this.subtitle.set_label(noHyphens(row.subtitle));
        this.set_tooltip_markup(row.tooltip);
        // Opacity, not `visible`: see STAR_WIDTH.
        this.star.set_opacity(mark.bookmark ? 1 : 0);
        const { labels, hidden } = tagChips(mark.tags);
        this.chipBox.set_visible(labels.length > 0);
        for (const [index, chip] of this.chips.entries()) {
            const label = labels[index];
            chip.set_visible(label !== undefined);
            if (label === undefined) continue;
            chip.set_label(label);
            // The chip shows what fits; the tooltip is where the tag stands whole.
            chip.set_tooltip_text(mark.tags[index] ?? label);
        }
        this.more.set_visible(hidden > 0);
        if (hidden > 0) this.more.set_label(`+${hidden}`);
        this.found.set_visible(item.found !== undefined);
        if (item.found !== undefined) this.found.set_label(item.found);
        this.verdict.set_label(row.badge);
        if (this.verdictClass !== '') this.verdict.remove_css_class(this.verdictClass);
        this.verdictClass = row.cssClass;
        this.verdict.add_css_class(row.cssClass);
    }

    unbind(): void {
        this.set_tooltip_markup(null);
        for (const chip of this.chips) chip.set_tooltip_text(null);
    }
}
