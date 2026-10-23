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

import { noHyphens } from './view/markup.ts';
import type { MessageRow } from './view/message.ts';

export class MessageItem extends GObject.Object {
    static {
        GObject.registerClass({ GTypeName: 'StampedMessageItem' }, this);
    }

    readonly row: MessageRow;
    /** The escaped "found by meaning" badge text, when the hit did not come from the words. */
    readonly found: string | undefined;

    constructor(row: MessageRow, found?: string) {
        super();
        this.row = row;
        this.found = found;
    }
}

export class MessageRowView extends Gtk.Box {
    static {
        GObject.registerClass({ GTypeName: 'StampedMessageRowView' }, this);
    }

    private readonly title: Gtk.Label;
    private readonly subtitle: Gtk.Label;
    private readonly found: Gtk.Label;
    private readonly verdict: Gtk.Label;
    private verdictClass = '';

    constructor() {
        super({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            marginTop: 8,
            marginBottom: 8,
            marginStart: 6,
            marginEnd: 6,
        });
        const text = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        this.title = new Gtk.Label({ useMarkup: true, xalign: 0, ellipsize: Pango.EllipsizeMode.END });
        this.subtitle = new Gtk.Label({ useMarkup: true, xalign: 0, ellipsize: Pango.EllipsizeMode.END });
        this.subtitle.add_css_class('dimmed');
        this.subtitle.add_css_class('caption');
        text.append(this.title);
        text.append(this.subtitle);
        this.found = this.badge();
        this.found.add_css_class('dimmed');
        this.verdict = this.badge();
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

    bind(item: MessageItem): void {
        const { row } = item;
        this.title.set_label(row.title);
        this.subtitle.set_label(noHyphens(row.subtitle));
        this.set_tooltip_markup(row.tooltip);
        this.found.set_visible(item.found !== undefined);
        if (item.found !== undefined) this.found.set_label(item.found);
        this.verdict.set_label(row.badge);
        if (this.verdictClass !== '') this.verdict.remove_css_class(this.verdictClass);
        this.verdictClass = row.cssClass;
        this.verdict.add_css_class(row.cssClass);
    }

    unbind(): void {
        this.set_tooltip_markup(null);
    }
}
