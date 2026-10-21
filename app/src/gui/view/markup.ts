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

/**
 * The same text, with Pango's automatic hyphenation switched off.
 *
 * A screenshot caught it: a key row wrapped `example.com` as `example.c-om`, and a reader has no
 * way to tell a hyphen Pango inserted from one that is part of the domain. For a tool whose whole
 * subject is which domain signed a message, a domain that cannot be read off the screen correctly
 * is a wrong answer — the same for an address, a selector and a Message-ID.
 *
 * Applied at the WIDGET, never inside a view model: the view models' strings are also fed to
 * plain-text widgets through {@link plainText}, which would render the span tag literally. Pango
 * 1.44 and newer honour `insert_hyphens`; an older one ignores the attribute rather than failing.
 */
export function noHyphens(markup: string): string {
    return `<span insert_hyphens="false">${markup}</span>`;
}

/**
 * The exact inverse of {@link escapeMarkup}, for the widgets that take NO markup.
 *
 * Not every label parses markup, and the ones that do not are not interchangeable with the ones
 * that do: `Adw.WindowTitle` and a tooltip render `&amp;` literally, so a case folder named
 * `Mail & Co` would appear as `Mail &amp;amp; Co` in the header bar. The view models all return
 * escaped text by design, so this is how a plain-text widget is fed from them — never by building
 * a second, unescaped version of the same string somewhere else.
 *
 * Only the three entities `escapeMarkup` produces, `&amp;` last so a literal `&amp;lt;` in the
 * source text survives the round trip. A general unescaper would be a different function with
 * different bugs.
 */
export function plainText(markup: string): string {
    return markup.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}
