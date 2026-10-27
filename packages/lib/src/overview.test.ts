import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from './context.ts';
import { overview } from './overview.ts';
import { fakeIo, type Tree } from './testing/fakeIo.ts';

const marker = (modules: string) => `---\nplexus: 0.62.0\nmodules: [${modules}]\n---\n\n- A repo.\n`;
const answers = (src: string) => `_commit: 0.62.0\n_src_path: ${src}\ntenant: plexus\n`;

const workspace: Tree = {
  tenant: {
    web: {
      '.git': {},
      'PLEXUS.md': marker('PLX-Repo, PLX-JS'),
      '.copier-answers.yml': answers('gh:plexus-ms/preset-repo-web'),
      node_modules: { junk: { '.git': {} } },
      apps: {
        website: {
          'PLEXUS.md': marker('PLX-App, PLX-AppStateless'),
          '.copier-answers.yml': answers('gh:plexus-ms/preset-app-nextjs'),
        },
      },
      docs: { 'readme.md': 'x' },
    },
  },
  preset: { '.git': {}, 'copier.yml': '' },
  broken: { 'PLEXUS.md': 'no frontmatter here' },
  empty: {},
};

const gitOf = (cwd: string, args: string[]): string | undefined => {
  const a = args.join(' ');
  if (cwd === '/ws/tenant/web') {
    if (a === 'symbolic-ref --short -q HEAD') return 'develop\n';
    if (a === 'status --porcelain') return ' M x\n';
    if (a === 'remote get-url origin') return 'git@github.com:plexus-ms-tenant/web.git\n';
    if (a === 'symbolic-ref --short -q refs/remotes/origin/HEAD') return 'origin/main\n';
    if (a === 'describe --tags --abbrev=0 origin/main') return undefined;
  }
  if (cwd === '/ws/preset') {
    if (a === 'symbolic-ref --short -q HEAD') return 'main\n';
    if (a === 'status --porcelain') return '';
    if (a === 'remote get-url origin') return 'https://github.com/plexus-ms/preset-repo-web\n';
    if (a === 'symbolic-ref --short -q refs/remotes/origin/HEAD') return 'origin/main\n';
    if (a === 'describe --tags --abbrev=0 origin/main') return '0.62.0\n';
    if (a === 'describe --tags --abbrev=0') return '0.62.0\n';
  }
  return undefined;
};

test('overview maps the facets of a workspace and prunes what carries none', async () => {
  const ctx = new Context({}, fakeIo({ ws: workspace }, gitOf));
  const tree = await overview(ctx, '/ws');
  assert.equal(tree.name, 'ws');
  assert.deepEqual(
    tree.children.map((c) => c.name),
    ['broken', 'preset', 'tenant'],
  );
  const [broken, preset, tenant] = tree.children;
  assert.match(broken?.problems?.[0] ?? '', /PLEXUS.md: no frontmatter/);
  assert.deepEqual(preset?.git, {
    branch: 'main',
    dirty: false,
    tag: '0.62.0',
    remote: 'gh:plexus-ms/preset-repo-web',
  });
  assert.deepEqual(preset?.template, { tag: '0.62.0' });

  const web = tenant?.children[0];
  assert.equal(web?.name, 'web');
  assert.deepEqual(web?.git, { branch: 'develop', dirty: true, remote: 'gh:plexus-ms-tenant/web' });
  assert.deepEqual(web?.declaration?.modules, ['PLX-Repo', 'PLX-JS']);
  assert.equal(web?.copier?.src, 'gh:plexus-ms/preset-repo-web');
  assert.deepEqual(web?.copier?.answers, { tenant: 'plexus' });
  assert.deepEqual(
    web?.children.map((c) => c.name),
    ['apps'],
  );
  assert.equal(web?.children[0]?.children[0]?.declaration?.plexus, '0.62.0');
});
