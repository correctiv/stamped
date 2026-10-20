/**
 * `stamped keys list|add|fetch|template` — which public keys the case needs, and getting them.
 *
 * Thin by design: the model, the validation, the lookups and the consent text are in
 * `@stamped/core`. This file maps arguments onto them and prints.
 */

import { existsSync, readFileSync } from 'node:fs';

import {
    describeConsent,
    fmt,
    keyNameFor,
    lookupArchive,
    lookupDns,
    missingPairs,
    pairName,
    parseKeyMaterial,
    parsePairList,
    requestTemplate,
    type KeyPair,
    type LookupChannel,
    type LookupResult,
    _,
    _n,
} from '@stamped/core';
import type { CommandModule } from 'yargs';

import { fetchMissingAndReverify, reverifyApplicable } from '../lib/autofetch.ts';
import { caseOrThrow } from '../lib/case.ts';
import { askConsent } from '../lib/consent.ts';
import { resolveTxt } from '../lib/dns.ts';
import { loadVault, saveVault } from '../lib/vault.ts';

interface CaseArgs {
    case: string;
}

const WHY = () =>
    _(
        'Every DKIM signature names a domain and a selector; the matching public key is what proves the signature. Without that key a message is “unverifiable”. Keys are public, but fetching them can reveal your interest, so Stamped asks first.',
    );

function explain(): string {
    return [
        WHY(),
        '',
        _('Ways to get a missing key, safest first:'),
        _('  1. Ask the provider for the old record: stamped keys template <domain> <selector>'),
        _('  2. Paste it yourself:                   stamped keys add <selector>._domainkey.<domain> <key>'),
        _('  3. archive.prove.email (third party):   stamped keys fetch --archive'),
        _('  4. Live DNS (tells the domain):         stamped keys fetch --dns'),
    ].join('\n');
}

function splitName(name: string): KeyPair {
    const at = name.toLowerCase().indexOf('._domainkey.');
    if (at <= 0 || at + 12 >= name.length) {
        throw new Error(fmt(_('Expected <selector>._domainkey.<domain>, got: {name}'), { name }));
    }
    return { selector: name.slice(0, at), domain: name.slice(at + 12) };
}

function readText(value: string): string {
    return existsSync(value) ? readFileSync(value, 'utf8') : value;
}

function printResult(result: LookupResult, added: string[]): void {
    for (const line of added) console.log(line);
    for (const miss of result.misses) {
        console.log(fmt(_('  no key  {name}: {reason}'), { name: pairName(miss.pair), reason: miss.reason }));
    }
}

export function keysCommand(): CommandModule<unknown, CaseArgs> {
    return {
        command: 'keys',
        describe: _('See which DKIM keys are needed and store them'),
        builder: (yargs) =>
            yargs
                .option('case', {
                    describe: _('The case folder holding keys.json'),
                    type: 'string',
                    default: '.stamped',
                })
                .command(listCommand())
                .command(addCommand())
                .command(fetchCommand())
                .command(templateCommand())
                .demandCommand(1, _('Pick a subcommand — try `stamped keys --help`.'))
                .epilog(explain()),
        handler: () => undefined,
    };
}

interface ListArgs extends CaseArgs {
    pairs?: string;
    json: boolean;
}

function listCommand(): CommandModule<CaseArgs, ListArgs> {
    return {
        command: 'list',
        describe: _('List stored keys, and with --pairs the ones still missing'),
        builder: (yargs) =>
            yargs
                .option('pairs', {
                    describe: _(
                        'A pair list (domain, selector[, mail count] per line) to check for missing keys',
                    ),
                    type: 'string',
                })
                .option('json', { describe: _('Print JSON'), type: 'boolean', default: false }),
        handler: (args) => {
            const vault = loadVault(args.case);
            const missing = args.pairs ? missingPairs(parsePairList(readText(args.pairs)), vault) : [];
            if (args.json) {
                console.log(
                    JSON.stringify({ keys: vault.all(), missing, conflicts: vault.conflicts() }, null, 2),
                );
                return;
            }
            console.log(
                fmt(_n('{count} key stored', '{count} keys stored', vault.size), { count: vault.size }),
            );
            for (const e of vault.all()) {
                const range = e.seenFrom
                    ? `, ${e.seenFrom.slice(0, 10)} – ${(e.seenTo ?? '').slice(0, 10)}`
                    : '';
                console.log(
                    `  ${keyNameFor(e.domain, e.selector)}  ${e.algorithm} ${e.bits} bit  ${e.origin}  ${e.fetchedAt.slice(0, 10)}${range}`,
                );
            }
            for (const pair of vault.conflicts()) {
                console.log(
                    fmt(_('! {name} holds different keys — a key rotation, or a forgery. Compare them.'), {
                        name: pairName(pair),
                    }),
                );
            }
            if (args.pairs) {
                console.log('');
                console.log(
                    missing.length === 0
                        ? _('No key is missing.')
                        : fmt(
                              _n(
                                  '{count} key is missing; messages signed with it stay unverifiable:',
                                  '{count} keys are missing; messages signed with them stay unverifiable:',
                                  missing.length,
                              ),
                              { count: missing.length },
                          ),
                );
                for (const m of missing) {
                    console.log(`  ${pairName(m)}${m.mails !== undefined ? `  (${m.mails})` : ''}`);
                }
                if (missing.length > 0) {
                    console.log('');
                    console.log(explain());
                }
            }
        },
    };
}

interface AddArgs extends CaseArgs {
    name: string;
    key: string;
}

function addCommand(): CommandModule<CaseArgs, AddArgs> {
    return {
        command: 'add <name> <key>',
        describe: _('Store a key you have: a PEM, a bare p= value, or a pasted DNS TXT record'),
        builder: (yargs) =>
            yargs
                .positional('name', {
                    describe: _('<selector>._domainkey.<domain>'),
                    type: 'string',
                    demandOption: true,
                })
                .positional('key', {
                    describe: _('The key text, or a path to a file holding it'),
                    type: 'string',
                    demandOption: true,
                }),
        handler: (args) => {
            const pair = splitName(args.name);
            const key = parseKeyMaterial(readText(args.key));
            if (key.kind === 'revoked') {
                throw new Error(
                    _(
                        'That record has an empty p=: the domain withdrew this key, so there is nothing to store.',
                    ),
                );
            }
            const vault = loadVault(args.case);
            const outcome = vault.add({
                ...pair,
                key,
                origin: 'operator',
                fetchedAt: new Date().toISOString(),
            });
            saveVault(args.case, vault);
            console.log(
                fmt(_('Stored {name}: {algorithm} {bits} bit.'), {
                    name: args.name,
                    algorithm: key.algorithm,
                    bits: key.bits,
                }),
            );
            if (outcome.status === 'conflict') {
                console.log(
                    _(
                        '! The case already held a different key for this pair. Both are kept: this is either a key rotation or a forgery.',
                    ),
                );
            }
        },
    };
}

interface FetchArgs extends CaseArgs {
    pairs?: string;
    name: (string | number)[];
    archive: boolean;
    dns: boolean;
    yes: boolean;
}

function fetchCommand(): CommandModule<CaseArgs, FetchArgs> {
    return {
        command: 'fetch',
        describe: _('Look up missing keys over the network, after you confirm exactly what is sent'),
        builder: (yargs) =>
            yargs
                .option('pairs', { describe: _('A pair list (domain, selector per line)'), type: 'string' })
                .option('name', {
                    describe: _('One <selector>._domainkey.<domain>. Repeatable.'),
                    type: 'array',
                    default: [] as string[],
                })
                .option('archive', {
                    describe: _('Ask archive.prove.email (a third party; its keys are unsigned)'),
                    type: 'boolean',
                    default: false,
                })
                .option('dns', {
                    describe: _('Query the public DNS (the domain’s operator can see it)'),
                    type: 'boolean',
                    default: false,
                })
                .option('yes', {
                    describe: _('Skip the confirmation prompt'),
                    type: 'boolean',
                    default: false,
                })
                .epilog(explain()),
        handler: async (args) => {
            const wantedNothing = !args.pairs && args.name.length === 0;
            if (wantedNothing) {
                // No pairs given: every key the case is missing, on one consent.
                const channels: LookupChannel[] = [
                    ...(args.archive ? (['archive.prove.email'] as const) : []),
                    ...(args.dns ? (['dns'] as const) : []),
                ];
                await fetchMissingAndReverify(caseOrThrow(args.case), {
                    yes: args.yes,
                    ...(channels.length > 0 ? { channels } : {}),
                });
                return;
            }
            if (!args.archive && !args.dns) {
                throw new Error(
                    _('Choose where to look: --archive and/or --dns. Stamped never goes online unasked.'),
                );
            }
            const wanted: KeyPair[] = [
                ...(args.pairs ? parsePairList(readText(args.pairs)) : []),
                ...args.name.map((n) => splitName(String(n))),
            ];

            const vault = loadVault(args.case);
            let todo: KeyPair[] = missingPairs(wanted, vault);
            if (todo.length === 0) {
                console.log(_('Every listed key is already stored.'));
                return;
            }
            const channels: LookupChannel[] = [
                ...(args.archive ? (['archive.prove.email'] as const) : []),
                ...(args.dns ? (['dns'] as const) : []),
            ];
            for (const channel of channels) {
                if (todo.length === 0) break;
                const consent = { channel, pairs: todo };
                if (!(await askConsent(describeConsent(channel, todo), args.yes))) {
                    console.log(_('Skipped; nothing was sent.'));
                    continue;
                }
                const result =
                    channel === 'dns'
                        ? await lookupDns(consent, todo, resolveTxt)
                        : await lookupArchive(consent, todo, (url) => fetch(url));
                const now = new Date().toISOString();
                const added: string[] = [];
                for (const f of result.found) {
                    const outcome = vault.add({
                        ...f.pair,
                        key: f.key,
                        origin: f.origin,
                        fetchedAt: now,
                        ...(f.seenFrom ? { seenFrom: f.seenFrom } : {}),
                        ...(f.seenTo ? { seenTo: f.seenTo } : {}),
                    });
                    added.push(
                        fmt(_('  stored  {name}: {algorithm} {bits} bit, via {origin}{flag}'), {
                            name: pairName(f.pair),
                            algorithm: f.key.algorithm,
                            bits: f.key.bits,
                            origin: f.origin,
                            flag: outcome.status === 'conflict' ? _(' — DIFFERS from a stored key') : '',
                        }),
                    );
                }
                saveVault(args.case, vault);
                printResult(result, added);
                todo = missingPairs(todo, vault);
            }
            if (existsSync(args.case + '/case.json')) await reverifyApplicable(caseOrThrow(args.case));
        },
    };
}

interface TemplateArgs {
    domain: string;
    selector: (string | number)[];
    period?: string;
}

function templateCommand(): CommandModule<CaseArgs, TemplateArgs> {
    return {
        command: 'template <domain> <selector..>',
        describe: _('Print a request you can send to the provider for the historical key'),
        builder: (yargs) =>
            yargs
                .positional('domain', {
                    describe: _('The signing domain'),
                    type: 'string',
                    demandOption: true,
                })
                .positional('selector', {
                    describe: _('One or more selectors'),
                    type: 'string',
                    array: true,
                    demandOption: true,
                })
                .option('period', {
                    describe: _('When the messages were sent, e.g. "March 2019"'),
                    type: 'string',
                }),
        handler: (args) => {
            console.log(
                requestTemplate({
                    domain: args.domain,
                    selectors: args.selector.map(String),
                    ...(args.period ? { period: args.period } : {}),
                }),
            );
        },
    };
}
