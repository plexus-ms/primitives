import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from './context.ts';
import { checkCompendium, extractRequirements, scanPage } from './requirements.ts';
import { fakeIo, type Tree } from './testing/fakeIo.ts';

const standard = [
  '---',
  'code: PLX-Alpha',
  'maturity: standard',
  'binds: repo',
  'depends: [PLX-Beta]',
  '---',
  '',
  'Prose with MUSTs, the plural, is fine.',
  '',
  '## § 1 One',
  '',
  '> - A repo MUST alpha.',
  '> - A repo SHOULD beta.',
  '',
  '```',
  '> - not a requirement, MUST not count',
  '```',
  '',
  '### § 1.1 Sub',
  '',
  '> - It MAY gamma.',
  '',
  '## Maintaining',
  '',
  'Maintainers ship it.',
  '',
].join('\n');

test('scanPage extracts requirements by section and skips fences', () => {
  const scan = scanPage(standard, 'contracts/alpha.md', 'module');
  assert.deepEqual(scan.defects, []);
  assert.deepEqual(scan.requirements, ['§ 1 A repo MUST alpha.', '§ 1 A repo SHOULD beta.', '§ 1.1 It MAY gamma.']);
  assert.deepEqual(
    [scan.code, scan.maturity, scan.binds, scan.depends],
    ['PLX-Alpha', 'standard', 'repo', ['PLX-Beta']],
  );
  assert.deepEqual(extractRequirements(standard), scan.requirements);
});

test('scanPage names every defect with its line', () => {
  const bad = [
    '---',
    'code: plx-bad',
    'kind: contract',
    'maturity: draft',
    'binds: cloud',
    '---',
    '> - before any heading',
    'A host MUST not say so in prose.',
    '## § 1 One',
    '> quoted, not a bullet',
    '## Maintaining',
    '> - under maintaining',
    '## § 2 Late',
  ].join('\n');
  const scan = scanPage(bad, 'approaches/bad.md', 'module');
  assert.deepEqual(scan.defects, [
    '✗ approaches/bad.md: line 3: kind is the folder, contracts/ or approaches/, not a field',
    '✗ approaches/bad.md: line 7: requirement in a module at draft maturity: > - before any heading',
    '✗ approaches/bad.md: line 8: BCP 14 keyword outside a requirement: A host MUST not say so in prose.',
    '✗ approaches/bad.md: line 10: blockquote line is not a "> - " requirement bullet',
    '✗ approaches/bad.md: line 12: requirement in a module at draft maturity: > - under maintaining',
    '✗ approaches/bad.md: line 13: numbered section after Maintaining',
    '✗ approaches/bad.md: line 13: maturity must be note, candidate or standard, not "draft"',
    '✗ approaches/bad.md: line 13: binds must be repo, app, host or organisation, not "cloud"',
    '✗ approaches/bad.md: line 13: code must be PLX- plus one capitalised word, not "plx-bad"',
  ]);
  assert.deepEqual(scanPage('---\ntitle: x\n---\n\n> - The map MUST not.\n', 'essentials/standard.md', 'map').defects, [
    '✗ essentials/standard.md: line 5: requirement in the map: > - The map MUST not.',
  ]);
  assert.deepEqual(scanPage('---\ncode: PLX-Note\nmaturity: note\nbinds: repo\n---\n', 'n.md', 'module').defects, [
    '✗ n.md: line 5: a note carries no code',
  ]);
});

const page = (code: string, maturity: string, binds: string, extra = '') =>
  `---\n${code ? `code: ${code}\n` : ''}maturity: ${maturity}\nbinds: ${binds}\n${extra}---\n\nProse.\n`;

test('checkCompendium applies the cross-page rules', async () => {
  const tree: Tree = {
    c: {
      essentials: { 'standard.md': '---\ntitle: map\n---\n\nProse.\n' },
      contracts: {
        'index.md': '---\ntitle: index\n---\n',
        'repo.md': page('PLX-Repo', 'standard', 'repo'),
        'host.md': page('PLX-Host', 'candidate', 'host'),
        'twin.md': page('PLX-Repo', 'candidate', 'repo'),
        'odd.md': page('PLX-Odd', 'candidate', 'repo', 'depends: [PLX-Deploy]\nconsumes: [PLX-Host]\n'),
      },
      approaches: {
        'deploy.md': page(
          'PLX-Deploy',
          'candidate',
          'app',
          'depends: [PLX-Repo, PLX-Gone]\nconsumes: [PLX-Host, PLX-Deploy, PLX-Nope]\n',
        ),
        'ops.md': page('PLX-Ops', 'candidate', 'host', 'depends: [PLX-Deploy]\n'),
        'note.md': page('', 'note', 'host'),
      },
    },
  };
  const result = await checkCompendium(new Context({}, fakeIo(tree)), '/c');
  assert.equal(result.contracts, 4);
  assert.equal(result.approaches, 3);
  assert.deepEqual(result.defects.sort(), [
    '✗ PLX-Deploy consumes PLX-Deploy, which is an approach; only a contract is consumed across a seam',
    '✗ PLX-Deploy consumes unknown module PLX-Nope',
    '✗ PLX-Odd is a contract and consumes PLX-Host; a contract has no other side to consume',
    '✗ PLX-Odd is a contract and depends on the approach PLX-Deploy',
    '✗ PLX-Ops (host) depends on PLX-Deploy (app) across the dev/ops seam; only a contract may be depended on across a seam',
    '✗ duplicate module code: PLX-Repo',
    '✗ unknown module in depends: PLX-Gone',
  ]);
});

test('checkCompendium is clean on a well-formed compendium', async () => {
  const tree: Tree = {
    c: {
      essentials: { 'standard.md': '---\ntitle: map\n---\n\nProse.\n' },
      contracts: { 'repo.md': page('PLX-Repo', 'standard', 'repo'), 'app.md': page('PLX-App', 'standard', 'app') },
      approaches: {
        'platform.md': page('PLX-Platform', 'candidate', 'host', 'consumes: [PLX-App]\n'),
        'js.md': page('PLX-JS', 'candidate', 'repo', 'depends: [PLX-Repo]\n'),
      },
    },
  };
  const result = await checkCompendium(new Context({}, fakeIo(tree)), '/c');
  assert.deepEqual(result.defects, []);
});
