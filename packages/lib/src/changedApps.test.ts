import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ChangedAppsInput, readChangedApps, selectChangedApps } from './changedApps.ts';
import { Context } from './context.ts';
import { fakeIo, type Tree } from './testing/fakeIo.ts';

const ws = (changed: string[] | undefined, dependents: string[] = []): ChangedAppsInput => ({
  workspace: true,
  all: ['website', 'app'],
  changed,
  dependents: async () => dependents,
});

test('no usable base ref: every app, sorted', async () => {
  assert.deepEqual(await selectChangedApps(ws(undefined)), {
    apps: ['app', 'website'],
    reason: 'no base ref: every app counts as changed',
  });
});

test('bookkeeping alone deploys nothing, in both repo shapes', async () => {
  const files = ['PLEXUS.md', 'apps/website/PLEXUS.md', 'apps/website/.copier-answers.yml'];
  assert.deepEqual((await selectChangedApps(ws(files, ['website']))).apps, []);
  assert.deepEqual((await selectChangedApps({ workspace: false, all: ['website'], changed: files })).apps, []);
});

test('a workspace-global input deploys every app without asking pnpm', async () => {
  const input = { ...ws(['pnpm-lock.yaml']), dependents: async (): Promise<string[]> => assert.fail('asked') };
  assert.deepEqual((await selectChangedApps(input)).apps, ['app', 'website']);
  assert.deepEqual((await selectChangedApps(ws(['apps/website/package.json', '.node-version']))).apps, [
    'app',
    'website',
  ]);
});

test('pnpm lists the dependents; an app it lists is kept for its own changes or a change outside apps/', async () => {
  // Only bookkeeping changed under `app`, but pnpm lists it: dropped.
  const own = await selectChangedApps(ws(['apps/website/src/x.ts', 'apps/app/PLEXUS.md'], ['website', 'app']));
  assert.deepEqual(own.apps, ['website']);
  // A shared package changed: whatever pnpm says depends on it is kept.
  const shared = await selectChangedApps(ws(['packages/ui/src/x.ts'], ['app']));
  assert.deepEqual(shared.apps, ['app']);
  // pnpm lists something that is not a deployable app: ignored.
  assert.deepEqual((await selectChangedApps(ws(['packages/ui/x.ts'], ['ui', 'website']))).apps, ['website']);
});

test('a platform repo is a path diff intersected with the apps that carry a compose file', async () => {
  const input: ChangedAppsInput = {
    workspace: false,
    all: ['beszel', 'pocket-id'],
    changed: ['apps/beszel/docker/compose.yaml', 'apps/stray', 'apps/other/compose.yaml', 'inventory/x.yml'],
  };
  assert.deepEqual(await selectChangedApps(input), { apps: ['beszel'], reason: 'files under the apps changed' });
});

const appRepo: Tree = {
  'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
  apps: { website: { 'package.json': '{}' }, app: { 'package.json': '{}' }, bare: {} },
};
const platformRepo: Tree = {
  apps: { beszel: { docker: { 'compose.yaml': '' } }, 'pocket-id': { 'compose.yaml': '' }, notes: { 'README.md': '' } },
};

test('readChangedApps reads git, the workspace marker and pnpm from the checkout', async () => {
  const asked: string[] = [];
  const io = fakeIo(
    { repo: appRepo },
    (cwd, args) => {
      asked.push(args.join(' '));
      assert.equal(cwd, '/repo');
      if (args[0] === 'rev-parse') return args[3] === 'abc^{commit}' ? 'abc\n' : undefined;
      if (args[0] === 'diff') return 'apps/website/src/page.tsx\npackages/ui/src/button.tsx\n';
      return undefined;
    },
    {
      pnpm: (_cwd, args) => {
        asked.push(`pnpm ${args.join(' ')}`);
        return '/real/repo/apps/website\n/real/repo/apps/app\n/real/repo/packages/ui\n';
      },
    },
  );
  const result = await readChangedApps(new Context({}, io), '/repo', 'abc');
  assert.deepEqual(result.apps, ['app', 'website']);
  assert.ok(asked.includes('diff --name-only abc HEAD'));
  assert.ok(asked.includes('pnpm --filter ...[abc...HEAD] ls --depth -1 --parseable'));
});

test('readChangedApps: an unknown or empty base ref lists every deployable app, bare dirs excluded', async () => {
  const io = fakeIo({ repo: appRepo }, () => undefined);
  const ctx = new Context({}, io);
  assert.deepEqual((await readChangedApps(ctx, '/repo', 'deadbeef')).apps, ['app', 'website']);
  assert.deepEqual((await readChangedApps(ctx, '/repo', '')).apps, ['app', 'website']);
  assert.deepEqual((await readChangedApps(ctx, '/repo', '0'.repeat(40))).apps, ['app', 'website']);
});

test('readChangedApps on a platform repo diffs paths and never calls pnpm', async () => {
  const io = fakeIo({ repo: platformRepo }, (_cwd, args) => {
    if (args[0] === 'rev-parse') return 'abc\n';
    if (args[0] === 'diff') return 'apps/beszel/docker/compose.yaml\napps/notes/README.md\n';
    return undefined;
  });
  assert.deepEqual((await readChangedApps(new Context({}, io), '/repo', 'abc', 'def')).apps, ['beszel']);
});
