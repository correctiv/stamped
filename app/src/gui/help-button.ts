/**
 * `<StampedHelpButton>` — a small ⓘ beside a label that explains the term behind it.
 *
 * This app is full of words a journalist has every right not to know: selector, alignment, body
 * hash, `l=`. The badge cannot carry that explanation and a tooltip is not readable at length, so
 * every such label gets one of these, with the paragraph `explainVerdict` / `explainKey` already
 * wrote. The widget holds no text of its own. It must not become a second place where the
 * product's vocabulary is defined.
 *
 * The icon is ⓘ and not "?", because "?" is the icon this app gives the `unverifiable` verdict.
 * A help button carrying it would read as a claim about the message beside it.
 *
 * WHICH WAY IT OPENS IS THE CALLER'S, and it has to be. A GTK4 popover is its own surface, so GTK
 * keeps it inside the MONITOR and knows nothing about the window — a button sitting at the right
 * end of a wide row opened a popover that ran out past the window edge. Nothing here can guess
 * that: the same widget sits in a row suffix, in a sidebar and under a left-aligned note. So the
 * direction is a parameter, and a caller near an edge names the side pointing inwards.
 */

import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import Template, { GTypeName, InternalChildren, type Children } from './help-button.blp';
import { noHyphens, plainText } from './view/markup.ts';

// oxlint-disable-next-line no-unsafe-declaration-merging -- intentional: GJS installs the internal children (ADR 0088)
export interface StampedHelpButton extends Children {}
export class StampedHelpButton extends Gtk.MenuButton {
    static {
        GObject.registerClass({ GTypeName, Template, InternalChildren }, this);
    }

    /**
     * @param markup an already-escaped explanation, as the view models return them.
     * @param direction which side the popover opens towards. See the note above.
     */
    constructor(markup = '', direction: Gtk.ArrowType = Gtk.ArrowType.DOWN) {
        super();
        this.set_direction(direction);
        this.setMarkup(markup);
    }

    setMarkup(markup: string): void {
        // `noHyphens` on the label, not on the stored markup: `explainKey`'s paragraph names the
        // DNS record (`t2048._domainkey.example.com`), and this label is the widest wrapping text
        // in the app — the one place Pango was caught hyphenating a domain.
        this._text.set_label(noHyphens(markup));
        // A tooltip parses no markup, so the entities have to come back out — `plainText` owns
        // that reversal, rather than this widget growing its own divergent copy of it.
        this.set_tooltip_text(markup === '' ? null : plainText(markup));
    }
}
