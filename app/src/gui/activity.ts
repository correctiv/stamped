/**
 * The status button in the header bar and the popover behind it.
 *
 * Widgets only: every sentence comes out of [`view/activity.ts`](view/activity.ts) and every
 * number out of the registry in [`lib/activity.ts`](../lib/activity.ts), which the background
 * jobs write into. The controller subscribes, and redraws at most {@link RENDER_INTERVAL_MS}
 * apart — a key lookup reports per pair, an import per second, and a popover rebuilt at that
 * rate would be a popover nobody can click.
 *
 * Rows persist between redraws and are updated in place, so an open expander stays open while
 * the numbers under it move.
 */

import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';
import type cairo from 'cairo';
import { _ } from '@stamped/core';

import { ActivityRegistry, type ActivityKind } from '../lib/activity.ts';
import { buttonView, rowView, type ButtonView, type RowView } from './view/activity.ts';

/** About four redraws a second at most. */
const RENDER_INTERVAL_MS = 250;
const ICON_SIZE = 16;

/** One row of the popover: title, subtitle, bar, stats, details, and its buttons. */
class TaskRow {
    readonly widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
    private readonly title = new Gtk.Label({ xalign: 0, hexpand: true });
    private readonly subtitle = new Gtk.Label({ xalign: 0, wrap: true, hexpand: true });
    private readonly bar = new Gtk.ProgressBar();
    private readonly stats = new Gtk.Label({ xalign: 0, wrap: true });
    private readonly expander = new Gtk.Expander({ label: _('Details') });
    private readonly details = new Gtk.Label({ xalign: 0, wrap: true, selectable: true });
    private readonly cancel = new Gtk.Button({ label: _('Cancel'), valign: Gtk.Align.CENTER });
    private readonly dismiss = new Gtk.Button({
        iconName: 'window-close-symbolic',
        tooltipText: _('Dismiss'),
        valign: Gtk.Align.CENTER,
    });

    constructor(kind: ActivityKind, onCancel: () => void, onDismiss: (kind: ActivityKind) => void) {
        this.title.add_css_class('heading');
        this.subtitle.add_css_class('caption');
        this.subtitle.add_css_class('dimmed');
        this.stats.add_css_class('caption');
        this.stats.add_css_class('dimmed');
        this.stats.add_css_class('numeric');
        this.details.add_css_class('caption');
        this.cancel.add_css_class('flat');
        this.dismiss.add_css_class('flat');
        this.dismiss.add_css_class('circular');
        this.cancel.connect('clicked', onCancel);
        this.dismiss.connect('clicked', () => onDismiss(kind));
        this.expander.set_child(this.details);

        const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
        text.append(this.title);
        text.append(this.subtitle);
        const head = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
        head.append(text);
        head.append(this.cancel);
        head.append(this.dismiss);
        this.widget.append(head);
        this.widget.append(this.bar);
        this.widget.append(this.stats);
        this.widget.append(this.expander);
    }

    update(view: RowView): void {
        this.title.set_label(view.title);
        this.subtitle.set_label(view.subtitle);
        this.bar.set_visible(view.fraction !== undefined);
        if (view.fraction !== undefined) this.bar.set_fraction(view.fraction);
        this.stats.set_label(view.stats);
        this.stats.set_visible(view.stats !== '');
        this.expander.set_visible(view.details.length > 0);
        this.details.set_label(view.details.join('\n'));
        this.cancel.set_visible(view.cancellable);
        // Only a finished row can be dismissed: a running job is not the list's to hide.
        this.dismiss.set_visible(view.state !== 'running');
        if (view.state === 'failed') this.title.add_css_class('error');
        else this.title.remove_css_class('error');
    }
}

export class ActivityController {
    readonly registry = new ActivityRegistry();

    private readonly button: Gtk.MenuButton;
    private readonly stack = new Gtk.Stack();
    private readonly progress = new Gtk.DrawingArea();
    private readonly dot = new Gtk.DrawingArea();
    private readonly list = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 14,
        widthRequest: 400,
    });
    private readonly empty: Gtk.Label;
    private readonly rows = new Map<ActivityKind, TaskRow>();
    private order: ActivityKind[] = [];
    private fraction = 0;
    private timer = 0;
    private lastRender = 0;
    private readonly unsubscribe: () => void;
    private readonly onCancelImport: () => void;

    /**
     * @param onCancelImport Called by the import row's Cancel; the window decides what dies,
     *   and shows the button only for a subprocess it started itself.
     */
    constructor(button: Gtk.MenuButton, onCancelImport: () => void) {
        this.button = button;
        this.onCancelImport = onCancelImport;

        this.stack.add_named(new Gtk.Image({ iconName: 'document-open-recent-symbolic' }), 'idle');
        this.stack.add_named(new Gtk.Spinner({ spinning: true }), 'busy');
        this.progress.set_content_width(ICON_SIZE);
        this.progress.set_content_height(ICON_SIZE);
        this.progress.set_draw_func(this.drawProgress.bind(this) as Gtk.DrawingAreaDrawFunc);
        this.stack.add_named(this.progress, 'progress');

        this.dot.set_content_width(8);
        this.dot.set_content_height(8);
        this.dot.set_halign(Gtk.Align.END);
        this.dot.set_valign(Gtk.Align.START);
        this.dot.set_can_target(false);
        this.dot.add_css_class('error');
        this.dot.set_draw_func(this.drawDot.bind(this) as Gtk.DrawingAreaDrawFunc);
        this.dot.set_visible(false);

        const overlay = new Gtk.Overlay({ child: this.stack });
        overlay.add_overlay(this.dot);
        button.set_child(overlay);

        this.empty = new Gtk.Label({ label: _('Nothing is running in the background.'), xalign: 0 });
        this.empty.add_css_class('dimmed');
        this.list.append(this.empty);
        const scroller = new Gtk.ScrolledWindow({
            child: this.list,
            hscrollbarPolicy: Gtk.PolicyType.NEVER,
            propagateNaturalHeight: true,
            maxContentHeight: 440,
        });
        const body = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            marginTop: 12,
            marginBottom: 12,
            marginStart: 12,
            marginEnd: 12,
        });
        body.append(scroller);
        button.set_popover(new Gtk.Popover({ child: body }));

        this.unsubscribe = this.registry.subscribe(() => this.schedule());
        this.render();
    }

    dispose(): void {
        this.unsubscribe();
        if (this.timer !== 0) GLib.source_remove(this.timer);
        this.timer = 0;
    }

    /** Leading edge now, trailing edge once per interval: the first change is never delayed. */
    private schedule(): void {
        if (this.timer !== 0) return;
        const wait = RENDER_INTERVAL_MS - (GLib.get_monotonic_time() / 1000 - this.lastRender);
        if (wait <= 0) {
            this.render();
            return;
        }
        this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(wait), () => {
            this.timer = 0;
            this.render();
            return GLib.SOURCE_REMOVE;
        });
    }

    private render(): void {
        this.lastRender = GLib.get_monotonic_time() / 1000;
        const tasks = this.registry.list();
        this.paintButton(buttonView(tasks));

        const kinds = tasks.map((task) => task.kind);
        for (const [kind, row] of this.rows) {
            if (!kinds.includes(kind)) {
                this.list.remove(row.widget);
                this.rows.delete(kind);
            }
        }
        for (const task of tasks) {
            let row = this.rows.get(task.kind);
            if (row === undefined) {
                row = new TaskRow(
                    task.kind,
                    () => this.onCancelImport(),
                    (kind) => this.registry.dismiss(kind),
                );
                this.rows.set(task.kind, row);
            }
            row.update(rowView(task));
        }
        if (kinds.join() !== this.order.join()) {
            for (const row of this.rows.values()) {
                if (row.widget.get_parent() !== null) this.list.remove(row.widget);
            }
            for (const kind of kinds) this.list.append(this.rows.get(kind)!.widget);
            this.order = kinds;
        }
        this.empty.set_visible(tasks.length === 0);
    }

    private paintButton(view: ButtonView): void {
        this.stack.set_visible_child_name(view.mode);
        this.fraction = view.fraction;
        this.progress.queue_draw();
        this.dot.set_visible(view.error);
        this.button.set_tooltip_text(view.tooltip);
        this.button.update_property([Gtk.AccessibleProperty.LABEL], [view.tooltip.split('\n')[0]!]);
    }

    /** A ring in the foreground colour, filled clockwise from twelve o'clock. */
    private drawProgress(area: Gtk.DrawingArea, cr: cairo.Context, width: number, height: number): void {
        const color = area.get_color();
        const radius = Math.min(width, height) / 2 - 1.5;
        const x = width / 2;
        const y = height / 2;
        cr.setLineWidth(3);
        cr.setSourceRGBA(color.red, color.green, color.blue, 0.25);
        cr.arc(x, y, radius, 0, 2 * Math.PI);
        cr.stroke();
        cr.setSourceRGBA(color.red, color.green, color.blue, color.alpha);
        const start = -Math.PI / 2;
        cr.arc(x, y, radius, start, start + 2 * Math.PI * this.fraction);
        cr.stroke();
    }

    /** A solid dot in the error colour (the `error` style class). */
    private drawDot(area: Gtk.DrawingArea, cr: cairo.Context, width: number, height: number): void {
        const color = area.get_color();
        cr.setSourceRGBA(color.red, color.green, color.blue, color.alpha);
        cr.arc(width / 2, height / 2, Math.min(width, height) / 2, 0, 2 * Math.PI);
        cr.fill();
    }
}
