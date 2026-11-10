import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCatalog } from './catalog.ts';
import { Context } from './context.ts';
import { buildManifest, catalogOf, MANIFEST_FILE, parseManifest, renderManifest } from './manifest.ts';
import { fakeIo, type Tree } from './testing/fakeIo.ts';

const compendium: Tree = {
  contracts: {
    'index.md': '---\ntitle: the contracts\n---\n',
    'repo.md':
      '---\ncode: PLX-Repo\nmaturity: standard\nbinds: repo\nchanged: 0.2.0\ndepends: []\n---\n\n> - A repo MUST.\n',
    'host.md': '---\ncode: PLX-Host\nmaturity: candidate\nbinds: host\ndepends: []\n---\n',
  },
  approaches: {
    'platform.md':
      '---\ncode: PLX-Platform\nmaturity: standard\nbinds: host\nchanged: 0.3.0\ndepends: [PLX-Tenancy]\nconsumes: [PLX-Host, PLX-App]\n---\n',
    'note.md': '---\ntitle: a note\nmaturity: note\n---\n',
  },
};

const catalog = () => readCatalog(new Context({ quiet: true }, fakeIo({ c: compendium })), 'c');

test('a manifest read back is the catalogue readCatalog builds from the checkout it was written from', async () => {
  const fromCheckout = await catalog();
  const text = renderManifest(buildManifest(fromCheckout, '0.3.0', '2026-01-02'));
  const manifest = parseManifest(text);
  assert.deepEqual(catalogOf(manifest), fromCheckout);
  assert.equal(manifest.train, '0.3.0');
  assert.equal(manifest.date, '2026-01-02');
  assert.equal(MANIFEST_FILE, 'train.json');
});

test('the manifest is plain data: modules by code, a module without changed has none, notes are absent', async () => {
  const text = renderManifest(buildManifest(await catalog(), '0.3.0', '2026-01-02'));
  assert.ok(text.endsWith('}\n'));
  const data = JSON.parse(text);
  assert.deepEqual(Object.keys(data), ['schema', 'train', 'date', 'modules']);
  assert.deepEqual(
    data.modules.map((m: { code: string }) => m.code),
    ['PLX-Host', 'PLX-Platform', 'PLX-Repo'],
  );
  assert.deepEqual(data.modules[1], {
    code: 'PLX-Platform',
    kind: 'approach',
    maturity: 'standard',
    binds: 'host',
    changed: '0.3.0',
    depends: ['PLX-Tenancy'],
    consumes: ['PLX-Host', 'PLX-App'],
  });
  assert.ok(!('changed' in data.modules[0]), 'a candidate carries no changed');
});

test('what is not a manifest is refused with what is wrong', async () => {
  const good = buildManifest(await catalog(), '0.3.0', '2026-01-02');
  const bad = (change: object) => () => parseManifest(JSON.stringify({ ...good, ...change }));
  assert.throws(() => parseManifest('<html>Not Found</html>'), /is not JSON/);
  assert.throws(() => parseManifest('[]'), /is not an object/);
  assert.throws(bad({ schema: 2 }), /has schema 2; this plx reads 1/);
  assert.throws(bad({ train: 'v0.3' }), /names 'v0.3', not a train/);
  assert.throws(bad({ date: 'yesterday' }), /is dated 'yesterday'/);
  assert.throws(bad({ modules: undefined }), /lists no modules/);
  assert.throws(bad({ modules: [{ code: 'PLX-X', kind: 'note' }] }), /module PLX-X is neither contract nor approach/);
  assert.throws(
    bad({ modules: [{ code: 'PLX-X', kind: 'contract', maturity: 'standard', binds: 'repo' }] }),
    /module PLX-X lacks depends or consumes/,
  );
});
