/**
 * Is the machine running on its battery? The indexer's `shouldPause` for a laptop.
 *
 * Linux only, from sysfs, because that is where it costs nothing: no D-Bus, no dependency.
 * Anywhere else (no such directory) the answer is "no" — an unknown is not a reason to stop
 * working. macOS has no sysfs; see the TODO in the pull request.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const POWER_SUPPLY = '/sys/class/power_supply';

function read(path: string): string {
    try {
        return readFileSync(path, 'utf8').trim();
    } catch {
        return '';
    }
}

/** True when a battery is discharging and no mains supply is online. */
export function onBattery(root: string = POWER_SUPPLY): boolean {
    let names: string[];
    try {
        names = readdirSync(root);
    } catch {
        return false;
    }
    let discharging = false;
    for (const name of names) {
        const type = read(join(root, name, 'type'));
        if (type === 'Mains' && read(join(root, name, 'online')) === '1') return false;
        if (type === 'Battery' && read(join(root, name, 'status')) === 'Discharging') discharging = true;
    }
    return discharging;
}
