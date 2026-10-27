/**
 * The semantic search settings: one switch, the state, and the estimate.
 *
 * A preferences dialog the person opens on purpose. A missing runtime or model is a row of
 * explanation and a dead switch, never an error dialog: text search works either way.
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';
import { _ } from '@stamped/core';
import { gpuGuard } from '@stamped/semantic/gpu-guard';
import { gpuSetting } from '@stamped/semantic/prebuilt-bins';
import { readSemanticRunStatus, type CasePaths } from '@stamped/store';

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
    paths?: CasePaths,
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
    let liftRow: Adw.ActionRow | undefined;
    let settingUp = false;
    const render = (): void => {
        const run = paths === undefined ? undefined : readSemanticRunStatus(paths);
        const pin = gpuGuard().pin();
        const view = semanticSettingsView(
            embedderAvailability(),
            controller.state(),
            controller.setting(),
            total,
            {
                ...(run?.backend === undefined ? {} : { backend: run.backend }),
                ...(pin === undefined ? {} : { pin }),
                gpu: gpuSetting(),
            },
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
        // Rebuilt only when it changes: the dialog renders every second, and a button replaced
        // under the pointer loses the click.
        if (liftRow !== undefined && liftRow.get_title() !== view.pinNote) {
            info.remove(liftRow);
            liftRow = undefined;
        }
        if (view.pinNote !== undefined && liftRow === undefined) {
            liftRow = new Adw.ActionRow({ title: view.pinNote, title_lines: 0 });
            const button = new Gtk.Button({
                label: _('Use the graphics card again'),
                valign: Gtk.Align.CENTER,
            });
            button.connect('clicked', () => {
                gpuGuard().clear();
                // A run going on the processor keeps it until it ends; a new process asks the
                // guard again. Restarted only when the search is on — the button lifts the pin,
                // it does not switch anything on.
                if (controller.setting()?.enabled === true) {
                    void controller
                        .stop()
                        .then(() => controller.start())
                        .then(render, render);
                }
                render();
            });
            liftRow.add_suffix(button);
            info.add(liftRow);
        }
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
