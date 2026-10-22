/** How the window starts the import subprocess: `-m` for GJS, never for Node. */

import { describe, expect, it } from '@gjsify/unit';

import { selfArgv } from '../../src/lib/self-argv.ts';

const bundle = '/app/Contents/Resources/lib/stamped.node.mjs';

export default async () => {
    await describe('selfArgv', async () => {
        await it('runs the bundle under Node without -m', async () => {
            const argv = selfArgv({
                execPath: '/app/node',
                execArgv: [],
                argv: ['/app/node', bundle],
                versions: { node: '24.0.0' },
            });
            expect(argv).toStrictEqual(['/app/node', bundle]);
        });

        await it('keeps Node flags the parent was started with', async () => {
            const argv = selfArgv({
                execPath: '/app/node',
                execArgv: ['--no-warnings'],
                argv: ['/app/node', bundle],
                versions: { node: '24.0.0' },
            });
            expect(argv).toStrictEqual(['/app/node', '--no-warnings', bundle]);
        });

        await it('loads the bundle as a module under GJS', async () => {
            const argv = selfArgv({
                execPath: '/usr/bin/gjs',
                execArgv: [],
                argv: ['gjs', bundle],
                versions: { node: '20.0.0', gjs: '1.86.0' },
            });
            expect(argv).toStrictEqual(['/usr/bin/gjs', '-m', bundle]);
        });

        await it('does not add a second -m once GJS reports it', async () => {
            const argv = selfArgv({
                execPath: '/usr/bin/gjs',
                execArgv: ['-m'],
                argv: ['gjs', bundle],
                versions: { gjs: '1.86.0' },
            });
            expect(argv).toStrictEqual(['/usr/bin/gjs', '-m', bundle]);
        });

        await it('gives up when the entry is not a script', async () => {
            expect(
                selfArgv({
                    execPath: '/usr/bin/stamped',
                    execArgv: [],
                    argv: ['/usr/bin/stamped'],
                    versions: { node: '24.0.0' },
                }),
            ).toBe(null);
            expect(
                selfArgv({ execPath: '', execArgv: [], argv: ['x', bundle], versions: { node: '24.0.0' } }),
            ).toBe(null);
        });
    });
};
