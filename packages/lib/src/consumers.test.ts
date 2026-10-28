import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedBranch, findConsumers } from './consumers.ts';
import { Context } from './context.ts';
import type { Directory } from './model.ts';
import { fakeIo } from './testing/fakeIo.ts';

const dir = (path: string, facets: Partial<Directory> = {}, children: Directory[] = []): Directory => ({
  name: path.split('/').pop() ?? path,
  path,
  children,
  ...facets,
});
const copier = (preset: string) => ({ copier: { src: `gh:plexus-ms/${preset}`, answers: {} } });
const marker = (...modules: string[]) => ({ declaration: { plexus: '0.1.0', modules, body: '' } });

test('expectedBranch follows the marker and only the marker', () => {
  assert.equal(expectedBranch({ plexus: '0', modules: ['PLX-Repo', 'PLX-Tenancy', 'PLX-Platform'], body: '' }), 'main');
  assert.equal(expectedBranch({ plexus: '0', modules: ['PLX-Repo', 'PLX-JS'], body: '' }), 'develop');
  assert.equal(expectedBranch({ plexus: '0', modules: ['PLX-App'], body: '' }), undefined);
  assert.equal(expectedBranch(undefined), undefined);
});

test('findConsumers groups sites by repo, skips the protected ones and the presets', async () => {
  const tree = dir('/ws', {}, [
    dir('/ws/plexus-ms', {}, [
      dir('/ws/plexus-ms/preset-repo-web', { git: { branch: 'main', dirty: false }, template: {} }, [
        dir('/ws/plexus-ms/preset-repo-web/template', copier('preset-app-nextjs')),
      ]),
    ]),
    dir('/ws/acme', {}, [
      dir(
        '/ws/acme/web',
        { git: { branch: 'develop', dirty: true }, ...copier('preset-repo-web'), ...marker('PLX-Repo') },
        [dir('/ws/acme/web/apps', {}, [dir('/ws/acme/web/apps/site', copier('preset-app-nextjs'))])],
      ),
      dir('/ws/acme/platform', {
        git: { branch: 'feature', dirty: false },
        ...copier('preset-repo-platform'),
        ...marker('PLX-Platform'),
      }),
      dir('/ws/acme/other', { git: { branch: 'main', dirty: false }, ...copier('preset-repo-platform') }),
    ]),
    dir('/ws/loose', copier('preset-repo-web')),
  ]);
  const ctx = new Context(
    {},
    fakeIo({}, (cwd) => (cwd === '/ws/acme/other' ? ' M x\n' : '')),
  );
  const consumers = await findConsumers(ctx, tree, ['preset-repo-web', 'preset-app-nextjs', 'preset-repo-platform']);
  assert.deepEqual(
    consumers.map((c) => [c.rel, c.branch, c.expected, c.skipped, c.sites.map((s) => `${s.rel}:${s.preset}`)]),
    [
      [
        'acme/web',
        'develop',
        'develop',
        undefined,
        ['acme/web:preset-repo-web', 'acme/web/apps/site:preset-app-nextjs'],
      ],
      ['acme/platform', 'feature', 'main', "on 'feature', expected 'main'", ['acme/platform:preset-repo-platform']],
      ['acme/other', 'main', undefined, 'has uncommitted changes', ['acme/other:preset-repo-platform']],
    ],
  );
});
