/**
 * An address list as a header writes it: `"Ada L." <ada@example.com>, bob@example.org (Bob)`.
 *
 * NORMALISING, NOT MERGING. An address is lower-cased and its display name is kept beside it, as
 * written; two spellings of one name are two names of one address, and two addresses are two
 * people however alike their names look. Whether `ada@a.example` and `ada@b.example` are the same
 * human is a judgement for the journalist — a guess made here would be a guess nobody can see.
 *
 * Deliberately lenient, as {@link addressDomain} is: a leaked header is often broken, and an
 * entry that is not an address (a bare name, `undisclosed-recipients:;`) is dropped rather than
 * invented into one. Nothing here may influence a verdict; it only groups what the index lists.
 */

/** One entry of an address list. */
export interface ParsedAddress {
    /** Lower-cased, without angle brackets. Always contains an `@`. */
    readonly address: string;
    /** The display name as written, unquoted; empty when the entry had none. */
    readonly name: string;
}

/** Split on commas that are outside quotes, angle brackets and comments. */
function splitEntries(value: string): string[] {
    const entries: string[] = [];
    let current = '';
    let quoted = false;
    let angled = false;
    let comment = 0;
    for (let index = 0; index < value.length; index++) {
        const char = value[index] as string;
        if (quoted) {
            current += char;
            if (char === '\\' && index + 1 < value.length) {
                current += value[index + 1] as string;
                index++;
            } else if (char === '"') quoted = false;
            continue;
        }
        if (comment > 0) {
            current += char;
            if (char === '(') comment++;
            else if (char === ')') comment--;
            continue;
        }
        if (char === '"') quoted = true;
        else if (char === '(') comment = 1;
        else if (char === '<') angled = true;
        else if (char === '>') angled = false;
        if ((char === ',' || char === ';') && !angled) {
            entries.push(current);
            current = '';
        } else current += char;
    }
    entries.push(current);
    return entries;
}

/** Remove one level of quotes and the backslash escapes inside them. */
function unquote(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).replace(/\\(.)/g, '$1').trim();
    }
    return trimmed;
}

const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+$/;

/** The entries of an address list that hold an address, in order, duplicates kept. */
export function parseAddressList(value: string | undefined): ParsedAddress[] {
    if (!value) return [];
    const found: ParsedAddress[] = [];
    for (const entry of splitEntries(value)) {
        const angled = /<([^<>]*)>/.exec(entry);
        let address: string;
        let name: string;
        if (angled) {
            address = (angled[1] ?? '').trim();
            name = unquote(entry.slice(0, angled.index));
        } else {
            const comment = /\(([^()]*)\)/.exec(entry);
            address = entry.replace(/\([^()]*\)/g, '').trim();
            name = comment ? (comment[1] ?? '').trim() : '';
        }
        // a route (`<@relay:ada@example.com>`) keeps only the mailbox after the last colon
        const colon = address.lastIndexOf(':');
        if (colon >= 0) address = address.slice(colon + 1);
        address = address.replace(/^"|"$/g, '').toLowerCase();
        if (!ADDRESS.test(address)) continue;
        found.push({ address, name });
    }
    return found;
}
