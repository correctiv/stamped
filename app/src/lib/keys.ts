/**
 * The host half of the key store: turning `--key <name>=<value>` into records on disk.
 *
 * `@stamped/core` owns the store and the record FORMAT and touches no filesystem, so that the
 * rules stay runnable anywhere. This module is the part that reads files, which is also the part
 * that has to guess what the operator meant by the right-hand side of the `=`.
 */

import { readFileSync } from 'node:fs';

import {
    fmt,
    KeyStore,
    looksLikeKeyRecord,
    looksLikePem,
    parseKeyArgument,
    recordFromPem,
    _,
} from '@stamped/core';

/** Build a store from the `--key` arguments, in order: a later one overrides an earlier one. */
export function keyStoreFrom(args: readonly string[]): KeyStore {
    const keys = new KeyStore();
    for (const arg of args) {
        const { name, value } = parseKeyArgument(arg);
        // 'operator' and not 'archive': a key the operator typed is one they vouch for, which is
        // the difference the `archive-key` caveat reports. A key taken out of the archive under
        // examination gets added as 'archive' by whatever reads the archive — never here.
        keys.add(name, recordFor(value), 'operator');
    }
    return keys;
}

/**
 * One `--key` value as a DKIM TXT record.
 *
 * Three forms are accepted because all three are what an operator actually has: the record
 * pasted from a `dig` output, a path to a file holding that record, and a path to the PEM public
 * key. They are distinguished by CONTENT, not by extension — a `.txt` holding a PEM block and a
 * `.pem` holding a TXT record both do the obvious thing.
 */
function recordFor(value: string): string {
    if (looksLikeKeyRecord(value)) return normaliseRecord(value);
    if (looksLikePem(value)) return recordFromPem(value);

    const text = read(value);
    if (looksLikePem(text)) return recordFromPem(text);
    if (looksLikeKeyRecord(text)) return normaliseRecord(text);
    throw new Error(
        fmt(_('{path} is neither a DKIM TXT record nor a PEM public key.'), { path: value }),
    );
}

/** Read a key file, reporting the path rather than the errno — the path is what was mistyped. */
function read(path: string): string {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        throw new Error(fmt(_('Cannot read the key file {path}.'), { path }));
    }
}

/**
 * Collapse a record onto one line.
 *
 * A TXT record over 255 characters arrives from `dig` as several quoted strings on several lines,
 * and an RSA `p=` is always longer than that. Joining them is what the resolver would do, so the
 * store holds what a lookup would have returned — and a base64 blob with a newline in the middle
 * fails as "invalid public key", which points at the key rather than at the copy-and-paste.
 */
function normaliseRecord(text: string): string {
    return text
        .replace(/"/g, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .join('')
        .trim();
}
