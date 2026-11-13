/**
 * The progress lines of `stamped case pack|unpack --progress=jsonl` and how the window reads them.
 */

import { describe, expect, it } from '@gjsify/unit';

import {
    caseFileFraction,
    caseFileProgressLine,
    parseCaseFileLine,
    throttledProgress,
    type CaseFileProgressLine,
} from '../../src/lib/case-file-progress.ts';

export default async () => {
    await describe('case file progress', async () => {
        await it('reads back the lines it writes', async () => {
            const line = caseFileProgressLine(5, 10);
            expect(parseCaseFileLine(JSON.stringify(line))).toStrictEqual(line);
            const done = { phase: 'done', path: '/cases/a', members: 3, bytes: 99 };
            expect(parseCaseFileLine(JSON.stringify(done))).toStrictEqual(done);
        });

        await it('ignores what is not ours: prose, other JSON, half a line', async () => {
            for (const text of [
                '',
                'Unpacking: 50 %',
                '[]',
                'null',
                '{"phase":"digest","step":1,"steps":2,"done":1,"total":2}',
                '{"phase":"working","done":"5","total":10}',
                '{"phase":"done","path":1,"members":1,"bytes":1}',
                '{"phase":"work',
            ]) {
                expect(parseCaseFileLine(text)).toBe(undefined);
            }
        });

        await it('turns a line into a fraction, clamped, and 0 when the total is unknown', async () => {
            expect(caseFileFraction(caseFileProgressLine(5, 10))).toBe(0.5);
            expect(caseFileFraction(caseFileProgressLine(15, 10))).toBe(1);
            expect(caseFileFraction(caseFileProgressLine(-1, 10))).toBe(0);
            expect(caseFileFraction(caseFileProgressLine(5, 0))).toBe(0);
            expect(caseFileFraction({ phase: 'done', path: 'x', members: 1, bytes: 1 })).toBe(1);
        });

        await it('speaks at most once per interval, and always for the last chunk', async () => {
            const lines: CaseFileProgressLine[] = [];
            let clock = 0;
            const report = throttledProgress(
                (line) => lines.push(line),
                200,
                () => clock,
            );
            report(1, 100);
            clock = 50;
            report(2, 100);
            clock = 150;
            report(3, 100);
            clock = 250;
            report(4, 100);
            clock = 260;
            report(100, 100);
            expect(lines.map((line) => line.done)).toStrictEqual([1, 4, 100]);
        });
    });
};
