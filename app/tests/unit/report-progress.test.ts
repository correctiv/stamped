/**
 * The progress lines `stamped report --pdf --progress=jsonl` prints, and how the window reads
 * them. Synthetic numbers only.
 */

import { describe, expect, it } from '@gjsify/unit';

import {
    parseReportLine,
    reportFraction,
    reportPhases,
    reportProgressLine,
} from '../../src/lib/report-progress.ts';

export default async () => {
    await describe('report progress lines', async () => {
        await it('lists the unsigned step only when it was asked for', () => {
            expect(reportPhases(false)).toStrictEqual(['summary', 'digest', 'body', 'render']);
            expect(reportPhases(true)).toStrictEqual(['summary', 'digest', 'body', 'unsigned', 'render']);
        });

        await it('numbers the step within the phases of this run', () => {
            const phases = reportPhases(false);
            expect(reportProgressLine(phases, 'render', 0, 0)).toStrictEqual({
                phase: 'render',
                step: 4,
                steps: 4,
                done: 0,
                total: 0,
            });
        });

        await it('reads its own lines back', () => {
            const line = reportProgressLine(reportPhases(true), 'unsigned', 20, 100);
            expect(parseReportLine(JSON.stringify(line))).toStrictEqual(line);
            expect(parseReportLine('{"phase":"done","pages":7,"file":"/tmp/report.pdf"}')).toStrictEqual({
                phase: 'done',
                pages: 7,
                file: '/tmp/report.pdf',
            });
        });

        await it('ignores anything that is not one of its lines', () => {
            expect(parseReportLine('not json')).toBe(undefined);
            expect(parseReportLine('null')).toBe(undefined);
            expect(parseReportLine('[1,2]')).toBe(undefined);
            expect(parseReportLine('{"phase":"import","step":1,"steps":2,"done":0,"total":0}')).toBe(
                undefined,
            );
            expect(parseReportLine('{"phase":"body","step":"1","steps":2,"done":0,"total":0}')).toBe(
                undefined,
            );
            expect(parseReportLine('{"phase":"body","step":1,"steps":0,"done":0,"total":0}')).toBe(undefined);
            expect(parseReportLine('{"phase":"done","pages":"7","file":"x"}')).toBe(undefined);
        });

        await it('puts the finished steps and the share of the current one together', () => {
            const phases = reportPhases(false);
            expect(reportFraction(reportProgressLine(phases, 'summary', 0, 0))).toBe(0);
            // step 2 of 4, half way: (1 + 0.5) / 4
            expect(reportFraction(reportProgressLine(phases, 'digest', 50, 100))).toBe(0.375);
            expect(reportFraction(reportProgressLine(phases, 'render', 0, 0))).toBe(0.75);
        });

        await it('counts an unknown total as no progress inside the step, and clamps', () => {
            const phases = reportPhases(false);
            expect(reportFraction(reportProgressLine(phases, 'body', 500, 0))).toBe(0.5);
            expect(reportFraction(reportProgressLine(phases, 'body', 900, 100))).toBe(0.75);
        });

        await it('is complete on the closing line', () => {
            expect(reportFraction({ phase: 'done', pages: 3, file: 'x.pdf' })).toBe(1);
        });
    });
};
