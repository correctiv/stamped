/**
 * Binds the translation catalogue as a SIDE EFFECT OF BEING IMPORTED — `main.ts` imports this
 * module first, so it runs before any other module of the window is evaluated.
 *
 * A call in `main.ts`'s body would be too late. ES modules evaluate their whole import graph
 * before the importing body runs, so a module-level `_('…')` — a verdict label, a sidebar
 * heading — would be looked up under the C locale and stay English for the rest of the process.
 * The CLI has the same rule for the same reason (`src/index.ts`, ahead of yargs); the window is
 * worse off only in that a frozen label has no exit code to notice it by.
 */

import { dirname } from 'node:path';

import { initI18n } from '../lib/i18n.ts';

const loaded = initI18n();

/**
 * The directory the catalogue was read out of, or `undefined` when none matched.
 *
 * Exported for the GUI's second binding. Stamped resolves `_()` in process, from a `.mo` it reads
 * itself, but a blueprint template's `translatable="yes"` is resolved by GtkBuilder through the C
 * library's `gettext` — a different lookup entirely, which knows nothing about this catalogue and
 * will hand back the English msgid unless the same directory is bound there too. Recovered from
 * the loaded path rather than resolved a second time so the two bindings cannot disagree: the
 * window would then be translated in the half the code writes and English in the half the markup
 * does, which reads as a bug in the translation rather than in the binding.
 */
export const LOCALE_DIR: string | undefined =
    // <dir>/<language>/LC_MESSAGES/stamped.mo → <dir>
    loaded === undefined ? undefined : dirname(dirname(dirname(loaded)));
