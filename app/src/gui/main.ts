/**
 * The `stamped` entry point — ONE binary, two frontends.
 *
 * A packaged app is a single executable: the desktop file launches `stamped` with no arguments
 * and a terminal runs `stamped verify mail.eml`. Both have to work, so this module dispatches
 * instead of choosing — a known subcommand (or a bare `--help`/`--version`) hands off to the
 * yargs CLI, anything else opens the window.
 *
 * Both halves are DYNAMIC imports, which is the point of this file being so small: a static
 * import of either one would evaluate it on every launch, so `stamped verify` would pull GTK and
 * libadwaita into a process that prints one report, and the window would build the yargs parser
 * it never parses with. Only the i18n side effect below is static, and it has to be.
 *
 * Exit codes are the CLI's (see `../index.ts`); the window's is the GApplication run status, and
 * a window closed normally is 0 like any other success.
 */

// FIRST, before the dispatch and before either frontend is imported: binds the catalogue as a
// side effect, so a module-level `_('…')` in the window or in a yargs `describe` is already
// translated. ES modules evaluate their whole graph before this body runs, which is why this is
// a module with a side effect and not a call down below.
import { LOCALE_DIR } from './i18n-init.ts';
// Safe to import statically: `i18n-init.ts` already pulls `@stamped/core` in to install the
// catalogue, so the CLI path pays nothing extra for it.
import { _, _p, TEXT_DOMAIN } from '@stamped/core';

/**
 * The CLI's commands, as `stamped --help` lists them.
 *
 * Kept here rather than asked of yargs because asking means building the parser, and building the
 * parser means loading the CLI — the thing this list exists to decide against. The cost of the
 * duplication is a command added to `../index.ts` and not to this array: it would open a window
 * instead of running, which the CLI smoke test in CI catches for the commands it covers.
 */
const COMMANDS = [
    'verify',
    'keys',
    'import',
    'search',
    'report',
    'reverify',
    'people',
    'timeline',
    'status',
    'semantic',
];

/** `stamped --help` and `stamped --version` are the CLI's; `stamped --foo` is not a window either. */
const CLI_FLAGS = ['--help', '-h', '--version'];

const first = process.argv[2];
const wantsCli =
    first !== undefined && (COMMANDS.includes(first) || first.startsWith('-') || CLI_FLAGS.includes(first));

if (wantsCli) {
    const { runCli } = await import('../index.ts');
    // Awaited, not fired and forgotten: the `await` is what keeps the command alive. GJS pumps
    // the main context until THIS module's promise settles, and that pump is what a yargs
    // handler's `await` needs — without it the process ends at the first one and `verify` prints
    // nothing while exiting 0, which is exactly what it did before the loop existed.
    process.exit(await runCli());
} else {
    const { AdwaitaApp, initLocale, runApplication } = await import('@gjsify/adwaita-app');
    const { StampedWindow } = await import('./window.ts');

    // The window's SECOND binding, and only the window needs it: `GtkBuilder` translates a
    // template's `translatable="yes"` through the C library, so the blueprint labels — the whole
    // welcome page, the sidebar headings, every button in the header bar — are looked up outside
    // the catalogue `i18n-init.ts` installed. Binding the same directory under the same domain
    // makes the two lookups answer alike. It also runs `setlocale`, which GTK needs for anything
    // it formats itself. Left out of the CLI path deliberately: nothing there is rendered by GTK.
    initLocale(TEXT_DOMAIN, { localeDir: LOCALE_DIR });

    const app = new AdwaitaApp({
        applicationId: 'org.correctiv.Stamped',
        // The pill shape only — every verdict colour is a libadwaita style class, so this stays
        // one rule and the badges follow the system accent (see `badge()` in window.ts).
        css: `.verdict-badge {
    padding: 2px 10px;
    border-radius: 9999px;
    font-size: 0.8em;
    font-weight: bold;
    background-color: alpha(currentColor, 0.12);
}`,
        // Literal fields rather than `aboutAppdata`: the metainfo is staged by `gjsify ship` at a
        // prefix-relative `share/metainfo`, and nothing exports that prefix to a running bundle —
        // only `GJSIFY_LOCALE_DIR` is exported, and deriving a sibling directory from it would be
        // a guess that breaks silently. These eight lines are the second copy of the metainfo's
        // header; the release notes it would add are on the website instead.
        about: {
            // Translated because the app has a German NAME, not just a German interface:
            // `<name xml:lang="de">Poststempel</name>` in the metainfo, and an About dialog
            // calling it "Stamped" would be the one place the two disagree.
            applicationName: _p('application name', 'Stamped'),
            applicationIcon: 'org.correctiv.Stamped',
            developerName: 'CORRECTIV',
            version: '0.2.1',
            website: 'https://correctiv.github.io/stamped/',
            issueUrl: 'https://github.com/correctiv/stamped/issues',
            copyright: '© 2026 CORRECTIV',
            license: 'AGPL-3.0-or-later',
            comments: _(
                'Verifies the DKIM signatures of an email archive and says what each signature ' +
                    'actually covers. It works offline: public keys come from a store you fill, so ' +
                    'examining a message sends no lookup to the signing domain.',
            ),
        },
        createWindow: (application) => new StampedWindow(application, first),
    });
    // `runApplication` rather than `runAdwaitaApp`, with the arguments STRIPPED: `runAdwaitaApp`
    // hands GApplication the real argv, and a GApplication without `HANDLES_OPEN` or
    // `HANDLES_COMMAND_LINE` rejects any argument it is given — so `stamped ~/leak/case` would
    // exit 1 instead of opening the case. The path is passed to the window directly above, which
    // is also the only consumer of it; GApplication has no part to play in that.
    const status = await runApplication(app, [process.argv[0] ?? 'stamped']);
    // Always through `process.exit()`: gjsify idle-schedules the GLib teardown with it, while a
    // bare exit from an async continuation leaves the loop running and hangs.
    process.exit(status);
}
