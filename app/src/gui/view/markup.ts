/**
 * Pango escaping, for every string that reaches a widget which parses markup.
 *
 * `Adw.ActionRow`'s title and subtitle, `Adw.StatusPage`'s description and every `Gtk.Label` with
 * `use-markup` go through the Pango parser. That is not a styling detail here: mail is full of
 * `<name@example.com>` and `Re: <draft>`, and an unescaped angle bracket makes the parser drop
 * the rest of the string or refuse it entirely. A From line vanishing from a message row is a
 * message that reads as having no sender — in a tool about what a message really says, the one
 * failure mode that must not exist. The spike measured it (`docs/spikes/macos-window.md`).
 *
 * Escaped here rather than by the widgets, so a row builder cannot forget: every function in this
 * directory returns text that is already safe to hand to a markup-parsing widget.
 */

/** `&`, `<`, `>` as Pango entities. `&` first, or the entities get escaped twice. */
export function escapeMarkup(text: string): string {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * One line, escaped: newlines and tabs collapsed to spaces.
 *
 * A subtitle is a single line of a fixed height, and a header field that arrived folded would
 * otherwise push the row's text out of its own row.
 */
export function escapeLine(text: string): string {
    return escapeMarkup(text.replace(/\s+/g, ' ').trim());
}
