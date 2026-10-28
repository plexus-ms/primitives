import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Catalogs,
  changesetPath,
  type Manifest,
  parseCatalogs,
  planChangeset,
  readChangeset,
  workspaceGlobs,
} from './changeset.ts';
import { Context } from './context.ts';
import { fakeIo, type Tree } from './testing/fakeIo.ts';

const none: Catalogs = { default: {}, named: {} };
const std = (deps: Record<string, string>, extra: Partial<Manifest> = {}): Manifest => ({
  name: '@x/std',
  dependencies: deps,
  ...extra,
});
const input = (packages: { path: string; before?: Manifest; after?: Manifest }[], exists = false) => ({
  branch: 'renovate/tailwind-merge-3.x',
  packages,
  catalogsBefore: none,
  catalogsAfter: none,
  ignore: [],
  exists,
});

test('changesetPath names one file per branch', () => {
  assert.equal(changesetPath('renovate/tailwind-merge-3.x'), '.changeset/bot-tailwind-merge-3-x.md');
  assert.equal(changesetPath('dependabot/npm_and_yarn/Foo-1.2'), '.changeset/bot-npm-and-yarn-foo-1-2.md');
  assert.equal(changesetPath('renovate/'), '.changeset/bot-branch.md');
});

test('a runtime dependency bump owes a patch, written deterministically', () => {
  const diff = {
    path: 'packages/std/package.json',
    before: std({ clsx: '^2.1.1', 'tailwind-merge': '^3.0.0' }),
    after: std({ clsx: '^2.1.1', 'tailwind-merge': '^3.7.0' }),
  };
  const cs = planChangeset(input([diff]));
  assert.deepEqual(cs.releases, { '@x/std': 'patch' });
  assert.equal(cs.content, "---\n'@x/std': patch\n---\n\nUpdate `tailwind-merge` from ^3.0.0 to ^3.7.0\n");
  assert.deepEqual(cs.plan, [{ kind: 'write', path: cs.path, content: cs.content }]);
  assert.deepEqual(planChangeset(input([diff])), cs);
});

test('devDependencies, private, nameless and ignored packages owe nothing; a stale file is removed', () => {
  const dev = {
    path: 'packages/a/package.json',
    before: { name: '@x/a', devDependencies: { typescript: '^5' } } as Manifest,
    after: { name: '@x/a', devDependencies: { typescript: '^6' } } as Manifest,
  };
  const priv = { path: 'p', before: std({ a: '1' }, { private: true }), after: std({ a: '2' }, { private: true }) };
  const anon = { path: 'n', before: { dependencies: { a: '1' } }, after: { dependencies: { a: '2' } } };
  const fresh = { path: 'f', after: std({ a: '2' }) };
  const ignored = { path: 'i', before: std({ a: '1' }), after: std({ a: '2' }) };
  const cs = planChangeset({ ...input([dev, priv, anon, fresh, ignored], true), ignore: ['@x/std'] });
  assert.deepEqual(cs.releases, {});
  assert.equal(cs.content, undefined);
  assert.deepEqual(cs.plan, [{ kind: 'run', command: 'rm', args: ['-f', cs.path] }]);
  assert.deepEqual(planChangeset(input([dev])).plan, []);
});

test('a peer range change is a major, and wins over a patch in the same package', () => {
  const cs = planChangeset(
    input([
      {
        path: 'p',
        before: std({ a: '^1' }, { peerDependencies: { react: '^18' } }),
        after: std({ a: '^2' }, { peerDependencies: { react: '^19' } }),
      },
      { path: 'q', before: { name: '@x/q', dependencies: {} }, after: { name: '@x/q', dependencies: { b: '^1' } } },
    ]),
  );
  assert.deepEqual(cs.releases, { '@x/q': 'patch', '@x/std': 'major' });
  assert.equal(
    cs.content,
    "---\n'@x/q': patch\n'@x/std': major\n---\n\nAdd `b` at ^1\nUpdate `a` from ^1 to ^2\nUpdate `react` (peer) from ^18 to ^19\n",
  );
});

test('a catalog entry bump reaches the packages that consume it', () => {
  const before = parseCatalogs(
    'packages:\n  - "packages/*"\ncatalog:\n  yaml: ^2.9.1\ncatalogs:\n  ui:\n    react: ^18\n',
  );
  const after = parseCatalogs(
    'packages:\n  - "packages/*"\ncatalog:\n  yaml: ^2.10.0\ncatalogs:\n  ui:\n    react: ^18\n',
  );
  const manifest = std({ yaml: 'catalog:', react: 'catalog:ui' });
  const cs = planChangeset({
    ...input([{ path: 'p', before: manifest, after: manifest }]),
    catalogsBefore: before,
    catalogsAfter: after,
  });
  assert.deepEqual(cs.changes, [
    { package: '@x/std', dependency: 'yaml', field: 'dependencies', from: '^2.9.1', to: '^2.10.0' },
  ]);
  assert.deepEqual(parseCatalogs(undefined), none);
  assert.deepEqual(workspaceGlobs('packages:\n  - "packages/*"\n  - "!**/test/**"\n'), ['packages/*']);
  assert.deepEqual(workspaceGlobs(undefined), []);
});

test('readChangeset reads the merge base through git and the branch through the tree', async () => {
  const beforeStd = JSON.stringify(std({ 'tailwind-merge': '^3.0.0' }));
  const afterStd = JSON.stringify(std({ 'tailwind-merge': '^3.7.0' }));
  const cli = JSON.stringify({ name: '@x/cli', devDependencies: { commander: '^15' } });
  const workspace = 'packages:\n  - "packages/*"\n';
  const tree: Tree = {
    repo: {
      'pnpm-workspace.yaml': workspace,
      '.changeset': { 'config.json': '{"ignore":[]}', 'bot-tailwind-merge-3-x.md': 'old' },
      packages: { std: { 'package.json': afterStd }, cli: { 'package.json': cli } },
    },
  };
  const io = fakeIo(tree, (cwd, args) => {
    assert.equal(cwd, '/repo');
    if (args[0] === 'rev-parse') return 'renovate/tailwind-merge-3.x\n';
    if (args[0] === 'merge-base') return 'abc123\n';
    if (args[0] === 'show' && args[1] === 'abc123:packages/std/package.json') return beforeStd;
    if (args[0] === 'show' && args[1] === 'abc123:packages/cli/package.json') return cli;
    if (args[0] === 'show' && args[1] === 'abc123:pnpm-workspace.yaml') return workspace;
    return undefined;
  });
  const cs = await readChangeset(new Context({}, io), '/repo', 'origin/main');
  assert.equal(cs.path, '.changeset/bot-tailwind-merge-3-x.md');
  assert.deepEqual(cs.releases, { '@x/std': 'patch' });
  assert.deepEqual(cs.plan, [{ kind: 'write', path: `/repo/${cs.path}`, content: cs.content }]);

  // The same branch with the bump gone: the stale file is removed.
  (tree.repo as Tree).packages = { std: { 'package.json': beforeStd }, cli: { 'package.json': cli } };
  const gone = await readChangeset(new Context({}, io), '/repo', 'origin/main');
  assert.deepEqual(gone.plan, [{ kind: 'run', command: 'rm', args: ['-f', cs.path], cwd: '/repo' }]);
});
