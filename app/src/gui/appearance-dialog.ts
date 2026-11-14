/**
 * The appearance settings: how tall the rows of the message list are.
 *
 * One choice, applied as it is made rather than on an OK button — the list behind the dialog
 * redraws, which is the only honest preview of what "compact" means. What it is worth in pixels
 * belongs to `lib/density.ts`; this file is the widget and the words.
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';
import { _ } from '@stamped/core';

import { DENSITIES, type Density } from '../lib/density.ts';

/** What the dialog calls each density. */
function densityLabel(density: Density): string {
    switch (density) {
        case 'comfortable':
            return _('Comfortable');
        case 'compact':
            return _('Compact');
    }
}

export function presentAppearanceSettings(
    parent: Gtk.Widget,
    current: Density,
    choose: (density: Density) => void,
): void {
    const dialog = new Adw.PreferencesDialog({ title: _('Appearance') });
    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({
        description: GLib.markup_escape_text(
            _('A compact list shows more messages at once. Every row shows the same things either way.'),
            -1,
        ),
    });
    const row = new Adw.ComboRow({
        title: _('Row height'),
        model: Gtk.StringList.new(DENSITIES.map(densityLabel)),
        selected: Math.max(0, DENSITIES.indexOf(current)),
    });
    group.add(row);
    page.add(group);
    dialog.add(page);

    row.connect('notify::selected', () => {
        const density = DENSITIES[row.get_selected()];
        if (density !== undefined) choose(density);
    });
    dialog.present(parent);
}
