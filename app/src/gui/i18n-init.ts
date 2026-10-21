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

import { initI18n } from '../lib/i18n.ts';

initI18n();
