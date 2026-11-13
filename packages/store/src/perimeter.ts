/**
 * The PERIMETER of a case: the domains it examines, named by the person doing the examining.
 *
 * A message cannot say whose infrastructure signed it. A signature from `d=example.com` on a
 * mailbox taken from example.com's own server proves the message is unchanged, but the key sat
 * with the party under examination, so it does not exclude a compromise on their side. That is a
 * fact about the CASE, and Stamped reads it from the one who knows it: nothing is inferred from
 * the sender domains, because the commonest sender domain of a leak is not necessarily the one
 * it was taken from.
 *
 * ABSENT MEANS "NONE NAMED", and then no caveat is ever added. A small file beside the case's
 * other files, written atomically like the semantic setting. It holds domain names only.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fmt, _ } from '@stamped/core';

import { assertWritable, type CasePaths } from './case.ts';

/** Bumped when a build would misread a perimeter an older build wrote. */
export const PERIMETER_VERSION = 1;

/** The file's name inside the case folder. */
export const PERIMETER_NAME = 'perimeter.json';

interface PerimeterFile {
    readonly version: number;
    readonly domains: readonly string[];
    readonly updated: string;
}

/** The file's path inside a case folder. */
export function perimeterFile(paths: CasePaths): string {
    return join(paths.root, PERIMETER_NAME);
}

/**
 * One domain as the perimeter stores it: lower case, no `@`, no trailing dot.
 *
 * A malformed name throws: a perimeter entry that never matches would silently switch the caveat
 * off, which is the quiet way to be wrong here.
 */
export function normalisePerimeterDomain(input: string): string {
    const name = input.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name)) {
        throw new Error(fmt(_('{name} is not a domain name.'), { name: input }));
    }
    return name;
}

/** The domains of the perimeter, sorted; empty when none is named or the file cannot be trusted. */
export function readPerimeter(paths: CasePaths): string[] {
    let parsed: Partial<PerimeterFile>;
    try {
        parsed = JSON.parse(readFileSync(perimeterFile(paths), 'utf8')) as Partial<PerimeterFile>;
    } catch {
        return [];
    }
    if (typeof parsed.version !== 'number' || parsed.version > PERIMETER_VERSION) return [];
    if (!Array.isArray(parsed.domains)) return [];
    return parsed.domains.filter((d): d is string => typeof d === 'string');
}

/** Name the perimeter, replacing the one there. An empty list removes it. */
export function writePerimeter(paths: CasePaths, domains: readonly string[]): string[] {
    assertWritable(paths);
    const clean = [...new Set(domains.map(normalisePerimeterDomain))].sort();
    const file = perimeterFile(paths);
    const body: PerimeterFile = {
        version: PERIMETER_VERSION,
        domains: clean,
        updated: new Date().toISOString(),
    };
    const temp = `${file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(body, undefined, 2)}\n`);
    renameSync(temp, file);
    return clean;
}
