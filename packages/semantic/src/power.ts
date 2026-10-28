/**
 * Is the machine running on its battery? The indexer's `shouldPause` for a laptop.
 *
 * Linux from sysfs, because that is where it costs nothing: no D-Bus, no dependency. macOS has no
 * sysfs and answers through `pmset` (see {@link onBatteryMac}). Anywhere else the answer is "no" —
 * an unknown is not a reason to stop working.
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

/**
 * True when the MACHINE's battery is discharging and no mains supply is online.
 *
 * A supply with `scope` `Device` is a peripheral (a wireless mouse or keyboard, a headset), not
 * the machine: a desktop with a mouse running down would otherwise hold the indexer forever.
 */
export function onBattery(
    root: string = POWER_SUPPLY,
    platform: string = process.platform,
    pmset: () => string | undefined = runPmset,
): boolean {
    if (platform === 'darwin') return onBatteryMac(pmset());
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
        if (type === 'Battery' && read(join(root, name, 'scope')) === 'Device') continue;
        if (type === 'Battery' && read(join(root, name, 'status')) === 'Discharging') discharging = true;
    }
    return discharging;
}

/** `pmset -g batt` prints which source the machine draws from: "Battery Power", "AC Power" or "UPS Power". */
export function onBatteryMac(pmsetOutput: string | undefined): boolean {
    return pmsetOutput !== undefined && /drawing from 'Battery Power'/.test(pmsetOutput);
}

/**
 * The output of `pmset -g batt`, or `undefined` when it cannot be had.
 *
 * `process.getBuiltinModule`, not an import: this package is bundled for GJS too, whose
 * `child_process` is the polyfill (see `child-process.ts`), and only Node on macOS ever gets here.
 */
function runPmset(): string | undefined {
    try {
        const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
        const childProcess = proc?.getBuiltinModule?.('node:child_process') as
            | { execFileSync(file: string, args: string[], options: object): string }
            | undefined;
        return childProcess?.execFileSync('/usr/bin/pmset', ['-g', 'batt'], {
            encoding: 'utf8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch {
        return undefined;
    }
}
