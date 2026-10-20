import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Template from './main-window.blp';

const FOLDERS = ['Inbox', 'Archive', 'Sent', 'People', 'Timeline', 'Authenticity', 'Keys'];
const MESSAGES = Array.from({ length: 12 }, (_, i) => ({
    from: `Sender ${i + 1} · person${i + 1}@example.org`,
    subject: `Dummy conversation ${i + 1}`,
    body: `Dummy body of message ${i + 1}.\n\nNo real data.`,
}));

export class MainWindow extends Adw.ApplicationWindow {
    declare private _outerSplit: Adw.OverlaySplitView;
    declare private _innerSplit: Adw.NavigationSplitView;
    declare private _folderList: Gtk.ListBox;
    declare private _messageList: Gtk.ListBox;
    declare private _reader: Gtk.Label;
    declare private _sidebarToggle: Gtk.ToggleButton;

    static {
        GObject.registerClass(
            {
                GTypeName: 'MainWindow',
                Template,
                InternalChildren: ['outerSplit', 'innerSplit', 'folderList', 'messageList', 'reader', 'sidebarToggle'],
            },
            this,
        );
    }

    constructor(application: Adw.Application) {
        super({ application });

        const w = Number(process.env.SPIKE_WIDTH);
        if (w > 0) this.set_default_size(w, 700);

        for (const name of FOLDERS) this._folderList.append(new Adw.ActionRow({ title: name }));
        for (const m of MESSAGES) this._messageList.append(new Adw.ActionRow({ title: m.subject, subtitle: m.from }));

        this._messageList.connect('row-activated', (_l: Gtk.ListBox, row: Gtk.ListBoxRow) => {
            const m = MESSAGES[row.get_index()];
            this._reader.set_label(`${m.subject}\n${m.from}\n\n${m.body}`);
            this._innerSplit.set_show_content(true);
        });

        this._sidebarToggle.connect('toggled', () => {
            this._outerSplit.set_show_sidebar(this._sidebarToggle.get_active());
        });
    }
}
