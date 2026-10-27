import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseModule, readCatalog } from './catalog.ts';
import { Context } from './context.ts';
import { compareTrains, diagnose } from './doctor.ts';
import { overview } from './overview.ts';
import { fakeIo, type Tree } from './testing/fakeIo.ts';

// The toolbox's offline harness, as a tree: a four-module compendium and one
// tenant whose markers exercise every finding and every way a dependency is
// satisfied (self, enclosing, contained, consumed).
const page = (code: string, binds: string, changed?: string, depends = '', consumes = '') =>
  `---\ncode: ${code}\nmaturity: standard\nbinds: ${binds}\n${changed ? `changed: ${changed}\n` : ''}${consumes ? `consumes: [${consumes}]\n` : ''}depends: [${depends}]\n---\n\nProse.\n`;
const marker = (plexus: string, modules: string) => `---\nplexus: ${plexus}\nmodules: [${modules}]\n---\n`;

const compendium: Tree = {
  contracts: {
    'index.md': '---\ntitle: x\n---\n',
    'repo.md': page('PLX-Repo', 'repo', '0.2.0'),
    'app.md': page('PLX-App', 'app', '0.1.0', 'PLX-Repo'),
    'tenancy.md': page('PLX-Tenancy', 'organisation'),
    'host.md': page('PLX-Host', 'host'),
  },
  approaches: {
    'platform.md': page('PLX-Platform', 'host', '0.1.0', 'PLX-Tenancy', 'PLX-Host, PLX-App'),
    'ci.md': page('PLX-CI', 'repo', undefined, 'PLX-Repo, PLX-Deploy'),
    'deploy.md': page('PLX-Deploy', 'app', undefined, '', 'PLX-App, PLX-Host'),
    'note.md': '---\ntitle: a note\nmaturity: note\nbinds: host\ndepends: []\n---\n',
  },
};

const tenant: Tree = {
  platform: {
    'PLEXUS.md': marker('0.1.0', 'PLX-Repo, PLX-Tenancy, PLX-Platform'), // Repo changed in 0.2.0 → stale; Platform's deps: Tenancy (self), consumes ignored
    apps: { third: { 'PLEXUS.md': marker('0.2.0', 'PLX-App, PLX-Deploy') } }, // App depends on Repo → the platform repo encloses it
  },
  web: {
    'PLEXUS.md': marker('0.2.0', 'PLX-Repo, PLX-CI'), // CI depends on Deploy → contained in apps/x
    apps: {
      x: { 'PLEXUS.md': marker('0.2.0', 'PLX-App, PLX-Deploy') },
      y: { 'PLEXUS.md': marker('0.2.0', 'PLX-App, PLX-Nope') }, // unknown module
    },
  },
  legacy: { 'PLEXUS.md': '# no frontmatter\n' }, // unreadable
};

async function run(tree: Tree) {
  const ctx = new Context({}, fakeIo({ ws: tree }));
  const catalog = await readCatalog(ctx, '/ws/plexus-ms/compendium');
  return diagnose(await overview(ctx, '/ws', { git: false }), catalog);
}

test('doctor reports every finding of the harness and nothing else', async () => {
  const report = await run({ 'plexus-ms': { compendium }, t: tenant });
  const by = Object.fromEntries(report.declarations.map((d) => [d.path, d]));
  assert.deepEqual(Object.keys(by).sort(), [
    't/legacy',
    't/platform',
    't/platform/apps/third',
    't/web',
    't/web/apps/x',
    't/web/apps/y',
  ]);
  assert.deepEqual(by['t/platform']?.findings, ['PLX-Repo changed in 0.2.0, declared at 0.1.0']);
  assert.deepEqual(by['t/web/apps/y']?.findings, ['declares PLX-Nope, which no module carries']);
  assert.deepEqual(by['t/legacy']?.findings, ['no frontmatter: expected a `---` block at the top']);
  assert.deepEqual(by['t/platform/apps/third']?.findings, [], 'an enclosing declaration satisfies an app');
  assert.deepEqual(by['t/web']?.findings, [], 'a contained declaration satisfies a repo');
  assert.deepEqual(by['t/web/apps/x']?.findings, []);
  assert.equal(report.stale, 3);
});

test('doctor is clean once every declaration is current and complete', async () => {
  const fixed: Tree = structuredClone(tenant);
  (fixed.platform as Tree)['PLEXUS.md'] = marker('0.2.0', 'PLX-Repo, PLX-Tenancy, PLX-Platform');
  ((fixed.web as Tree).apps as Tree).y = { 'PLEXUS.md': marker('0.2.0', 'PLX-App, PLX-Deploy') };
  delete fixed.legacy;
  const report = await run({ 'plexus-ms': { compendium }, t: fixed });
  assert.equal(report.stale, 0);
  assert.equal(report.declarations.length, 5);
});

test('the tenant declaration satisfies its repos, and its repos satisfy it', async () => {
  const report = await run({
    'plexus-ms': { compendium },
    t: {
      platform: { 'PLEXUS.md': marker('0.2.0', 'PLX-Tenancy, PLX-CI') }, // CI depends on Repo and Deploy, declared by the sibling repo and its app
      web: {
        'PLEXUS.md': marker('0.2.0', 'PLX-Repo'),
        apps: { x: { 'PLEXUS.md': marker('0.2.0', 'PLX-App, PLX-Deploy') } },
      },
    },
  });
  const platform = report.declarations.find((d) => d.path === 't/platform');
  assert.deepEqual(platform?.findings, [
    'PLX-CI depends on PLX-Deploy, declared neither here nor by an enclosing or contained declaration',
  ]);
});

test('parseModule skips notes and reads every field', () => {
  assert.equal(parseModule('---\ntitle: n\nmaturity: note\n---\n', 'approach'), undefined);
  assert.deepEqual(parseModule(page('PLX-Platform', 'host', '0.1.0', 'PLX-Tenancy', 'PLX-Host, PLX-App'), 'approach'), {
    code: 'PLX-Platform',
    kind: 'approach',
    maturity: 'standard',
    binds: 'host',
    changed: '0.1.0',
    depends: ['PLX-Tenancy'],
    consumes: ['PLX-Host', 'PLX-App'],
  });
});

test('compareTrains compares numerically and ignores suffixes', () => {
  assert.equal(compareTrains('0.10.0', '0.9.0'), 1);
  assert.equal(compareTrains('0.62.0', '0.62.0'), 0);
  assert.equal(compareTrains('0.62.0-rc1', '0.62.1'), -1);
});
