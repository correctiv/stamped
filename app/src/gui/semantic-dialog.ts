/**
 * The semantic search settings: one switch, the state, and the estimate.
 *
 * A preferences dialog the person opens on purpose. A missing runtime or model is a row of
 * explanation and a dead switch, never an error dialog: text search works either way.
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import type Gtk from '@girs/gtk-4.0';
import { _ } from '@stamped/core';

import { embedderAvailability } from '../lib/semantic-embedder.ts';
import type { SemanticController } from '../lib/semantic.ts';
import { semanticSettingsView } from './view/semantic.ts';

function textRow(text: string): Adw.ActionRow {
    const row = new Adw.ActionRow({ title: GLib.markup_escape_text(text, -1), titleLines: 0 });
    row.add_css_class('property');
    return row;
}

export function presentSemanticSettings(
    parent: Gtk.Widget,
    controller: SemanticController,
    total: number,
): void {
    const dialog = new Adw.PreferencesDialog({ title: _('Semantic search') });
    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({
        description: GLib.markup_escape_text(
            _('Find messages by meaning as well as by word. The index is built on this machine.'),
            -1,
        ),
    });
    const toggle = new Adw.SwitchRow({ title: _('Search by meaning') });
    group.add(toggle);
    const info = new Adw.PreferencesGroup();
    page.add(group);
    page.add(info);
    dialog.add(page);

    let rows: Adw.ActionRow[] = [];
    let settingUp = false;
    const render = (): void => {
        const view = semanticSettingsView(
            embedderAvailability(),
            controller.state(),
            controller.setting(),
            total,
        );
        settingUp = true;
        toggle.set_active(view.active);
        toggle.set_sensitive(view.sensitive);
        settingUp = false;
        for (const row of rows) info.remove(row);
        const texts = [...(view.note === undefined ? [] : [view.note]), ...view.lines];
        if (view.estimate !== undefined) texts.push(view.estimate);
        rows = texts.map(textRow);
        for (const row of rows) info.add(row);
    };

    toggle.connect('notify::active', () => {
        if (settingUp) return;
        const run = toggle.get_active() ? controller.enable() : controller.disable();
        void run.then(render, render);
        render();
    });

    // The estimate has to be there before the person decides, and measuring takes seconds.
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
        render();
        return true;
    });
    dialog.connect('closed', () => GLib.source_remove(timer));
    render();
    if (embedderAvailability() === 'ready' && controller.setting()?.probe === undefined) {
        void controller.probeOnly().then(render, render);
    }
    dialog.present(parent);
}
