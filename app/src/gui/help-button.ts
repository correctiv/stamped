/**
 * `<StampedHelpButton>` — a small "?" beside a label that explains the term behind it.
 *
 * This app is full of words a journalist has every right not to know: selector, alignment, body
 * hash, `l=`. The badge cannot carry that explanation and a tooltip is not readable at length, so
 * every such label gets one of these, with the paragraph `explainVerdict` / `explainKey` already
 * wrote. The widget holds no text of its own — it must not become a second place where the
 * product's vocabulary is defined.
 */

import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import Template, { GTypeName, InternalChildren, type Children } from './help-button.blp';
import { plainText } from './view/markup.ts';

// oxlint-disable-next-line no-unsafe-declaration-merging -- intentional: GJS installs the internal children (ADR 0088)
export interface StampedHelpButton extends Children {}
export class StampedHelpButton extends Gtk.MenuButton {
    static {
        GObject.registerClass({ GTypeName, Template, InternalChildren }, this);
    }

    /** @param markup an already-escaped explanation, as the view models return them. */
    constructor(markup = '') {
        super();
        this.setMarkup(markup);
    }

    setMarkup(markup: string): void {
        this._text.set_label(markup);
        // A tooltip parses no markup, so the entities have to come back out — `plainText` owns
        // that reversal, rather than this widget growing its own divergent copy of it.
        this.set_tooltip_text(markup === '' ? null : plainText(markup));
    }
}
