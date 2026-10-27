import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAnswers } from './copier.ts';
import { parseMarker } from './marker.ts';
import { kindOf, shortRemote } from './model.ts';

test('parseMarker reads the frontmatter and keeps the prose', () => {
  const d = parseMarker('---\nplexus: 0.62.0\nmodules: [PLX-Repo, PLX-JS]\n---\n\n- Free-form prose.\n');
  assert.deepEqual(d, { plexus: '0.62.0', modules: ['PLX-Repo', 'PLX-JS'], body: '\n- Free-form prose.\n' });
  assert.equal(parseMarker('---\nplexus: 0.62.0\nmodules: []\n---').body, '');
});

test('parseMarker rejects what is not a marker', () => {
  assert.throws(() => parseMarker('# just prose'), /no frontmatter/);
  assert.throws(() => parseMarker('---\nmodules: [PLX-Repo]\n---\n'), /`plexus`/);
  assert.throws(() => parseMarker('---\nplexus: 0.62.0\nmodules: PLX-Repo\n---\n'), /`modules`/);
});

test('parseAnswers separates copier bookkeeping from the answers', () => {
  const a = parseAnswers(
    '# Maintained by Copier\n_commit: 0.62.0\n_src_path: gh:plexus-ms/preset-app-nextjs\nname: web\nprofile: stateless-app\n',
  );
  assert.deepEqual(a, {
    commit: '0.62.0',
    src: 'gh:plexus-ms/preset-app-nextjs',
    answers: { name: 'web', profile: 'stateless-app' },
  });
});

test('kindOf derives what a declaration makes a directory', () => {
  const of = (...modules: string[]) => kindOf({ plexus: '0', modules, body: '' });
  assert.equal(of('PLX-App', 'PLX-AppStateless'), 'app');
  assert.equal(of('PLX-Repo', 'PLX-Platform'), 'platform');
  assert.equal(of('PLX-Repo', 'PLX-JS'), 'repo');
  assert.equal(of('PLX-Tenancy'), undefined);
});

test('shortRemote shortens GitHub remotes in every spelling', () => {
  for (const url of [
    'git@github.com:plexus-ms/packages.git',
    'ssh://git@github.com/plexus-ms/packages',
    'https://github.com/plexus-ms/packages/',
  ])
    assert.equal(shortRemote(url), 'gh:plexus-ms/packages');
  assert.equal(shortRemote('https://codeberg.org/x/y.git'), 'https://codeberg.org/x/y');
});
