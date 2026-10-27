/**
 * Switching semantic search on by itself, once, for a case nobody has decided about.
 *
 * A case without `semantic.json` is "never decided". On a machine that indexes the whole archive
 * within the probe's limit there is nothing to decide: the window measures in the background and
 * switches the search on. Everywhere else it stays off, with the estimate kept for the dialog.
 * A setting that exists is a decision, and a decision is never overridden — nor is a switch the
 * person flipped while the probe was still running.
 */

import type { SemanticController } from './semantic.ts';

export interface AutoEnableOptions {
    /** Can this machine embed at all — runtime and model present? A cheap look, no load. */
    readonly ready: () => boolean;
    /** On the battery the probe waits for another open; loading a model is not free. */
    readonly onBattery?: () => boolean;
    /** Has the person switched the search on or off since the window opened the case? */
    readonly decided: () => boolean;
}

export type AutoEnableOutcome = 'enabled' | 'decided' | 'unavailable' | 'battery' | 'not-recommended';

type AutoController = Pick<SemanticController, 'setting' | 'probeOnly' | 'enable'>;

export async function autoEnableSemantic(
    controller: AutoController,
    options: AutoEnableOptions,
): Promise<AutoEnableOutcome> {
    if (controller.setting() !== undefined || options.decided()) return 'decided';
    if (!options.ready()) return 'unavailable';
    if (options.onBattery?.() === true) return 'battery';
    const measured = await controller.probeOnly();
    if (options.decided() || measured?.enabled === true) return 'decided';
    if (measured?.probe === undefined) return 'unavailable';
    if (measured.probe.recommendation !== 'on') return 'not-recommended';
    await controller.enable();
    return 'enabled';
}

/**
 * The controller as the settings dialog gets it: the same object, except that switching it on or
 * off counts as the person's decision.
 */
export function markingDecisions<C extends SemanticController>(controller: C, mark: () => void): C {
    return {
        ...controller,
        enable: () => {
            mark();
            return controller.enable();
        },
        disable: () => {
            mark();
            return controller.disable();
        },
    };
}
