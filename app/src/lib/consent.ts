/** Ask the operator before anything leaves the machine. Anything but an explicit yes is a no. */

import { createInterface } from 'node:readline';

import { type ConsentText, _ } from '@stamped/core';

export function consentLines(text: ConsentText): string[] {
    return [text.title, '', text.warning, '', ...text.items.map((item) => `  ${item}`), ''];
}

export async function askConsent(text: ConsentText, yes: boolean): Promise<boolean> {
    for (const line of consentLines(text)) console.log(line);
    if (yes) return true;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await new Promise<string>((done) => rl.question(_('Send these lookups? [y/N] '), done));
        return /^(y|yes|j|ja)$/i.test(answer.trim());
    } finally {
        rl.close();
    }
}
