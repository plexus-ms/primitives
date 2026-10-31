import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Directory } from '@plexus-ms/lib';
import { style } from '../style.ts';
import { renderTree } from './overview.ts';

test('renderTree draws the tree with one annotation per facet', () => {
  const web: Directory = {
    name: 'web',
    path: '/ws/web',
    git: { branch: 'develop', dirty: true, remote: 'gh:t/web' },
    copier: { commit: '0.62.0', src: 'https://github.com/plexus-ms/preset-repo-web.git', answers: {} },
    declaration: { plexus: '0.62.0', modules: ['PLX-Repo', 'PLX-JS'], body: '' },
    children: [
      {
        name: 'apps',
        path: '/ws/web/apps',
        children: [{ name: 'site', path: '/ws/web/apps/site', problems: ['PLEXUS.md: no frontmatter'], children: [] }],
      },
    ],
  };
  const root: Directory = {
    name: 'ws',
    path: '/ws',
    children: [web, { name: 'tpl', path: '/ws/tpl', template: {}, children: [] }],
  };
  assert.equal(
    renderTree(root, style(false), true),
    [
      'ws/',
      '├─ web/ [develop* → gh:t/web] [copier 0.62.0 ← gh:plexus-ms/preset-repo-web] [repo 0.62.0 Repo, JS]',
      '│  └─ apps/',
      '│     └─ site/ [! PLEXUS.md: no frontmatter]',
      '└─ tpl/ [template untagged]',
    ].join('\n'),
  );
});

test('a dirty star does not end the colour of the git facet', () => {
  const dir: Directory = { name: 'r', path: '/r', git: { branch: 'main', dirty: true, tag: '1.0.0' }, children: [] };
  const line = renderTree(dir, style(true), false);
  const esc = (code: number, text: string) => `\u001b[${code}m${text}\u001b[0m`;
  assert.ok(line.includes(`${esc(32, '[main')}${esc(33, '*')}${esc(32, ' 1.0.0]')}`));
});

test('a synced git facet shows the commits behind and ahead of its upstream', () => {
  const dir = (ahead: number, behind: number): Directory => ({
    name: 'r',
    path: '/r',
    git: { branch: 'main', dirty: true, remote: 'gh:t/r', ahead, behind },
    children: [],
  });
  assert.equal(renderTree(dir(1, 3), style(false), false), 'r/ [main* ↓3 ↑1 → gh:t/r]');
  assert.equal(renderTree(dir(0, 0), style(false), false), 'r/ [main* → gh:t/r]');
});
