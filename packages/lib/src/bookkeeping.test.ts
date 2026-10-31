import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bumpCollectionPin,
  bumpConfigPin,
  bumpGalaxyVersion,
  bumpManifestVersion,
  bumpPlxPin,
  bumpWorkflowRefs,
  hasUnmergedEntries,
  stampChanged,
  stampStandard,
  syncMarker,
  today,
} from './bookkeeping.ts';

test('bumpGalaxyVersion keeps the trailing comment', () => {
  assert.equal(
    bumpGalaxyVersion('namespace: plexus\nversion: 0.1.0                # mirrors the tag\n', '0.2.0'),
    'namespace: plexus\nversion: 0.2.0                # mirrors the tag\n',
  );
});

test('bumpCollectionPin touches only the platform collection', () => {
  const reqs =
    'collections:\n  - name: community.docker\n    version: 9.9.9\n  - name: https://github.com/plexus-ms/primitives.git#/ansible/\n    type: git\n    version: v0.1.0\n  - name: other\n    version: 1.0.0\n';
  assert.equal(bumpCollectionPin(reqs, '0.2.0'), reqs.replace('version: v0.1.0', 'version: 0.2.0'));
  assert.equal(bumpCollectionPin('collections: []\n', '0.2.0'), 'collections: []\n');
});

test('bumpWorkflowRefs pins every primitives workflow, whatever the ref looked like', () => {
  const wf =
    'jobs:\n  a:\n    uses: plexus-ms/primitives/.github/workflows/_pipeline.yml@0.1.0\n  b:\n    uses: plexus-ms/primitives/.github/workflows/verify.yml@v0.9\n  c:\n    uses: other/repo/.github/workflows/x.yml@0.1.0\n';
  assert.equal(
    bumpWorkflowRefs(wf, '0.2.0'),
    wf.replace('_pipeline.yml@0.1.0', '_pipeline.yml@0.2.0').replace('verify.yml@v0.9', 'verify.yml@0.2.0'),
  );
});

test('bumpManifestVersion bumps the top-level version only', () => {
  const pkg =
    '{\n  "name": "@plexus-ms/cli",\n  "version": "0.9.0",\n  "dependencies": { "x": { "version": "1.0.0" } }\n}\n';
  assert.equal(bumpManifestVersion(pkg, '0.100.0'), pkg.replace('"version": "0.9.0"', '"version": "0.100.0"'));
});

test('bumpPlxPin pins plx exactly in either spelling of a mise tool', () => {
  const table = '"npm:@plexus-ms/cli" = { version = "0.6.0", allow_low_downloads = true }\nhk = "latest"\n';
  assert.equal(bumpPlxPin(table, '0.100.0'), table.replace('0.6.0', '0.100.0'));
  assert.equal(bumpPlxPin('"npm:@plexus-ms/cli" = "0.6.0"\n', '0.100.0'), '"npm:@plexus-ms/cli" = "0.100.0"\n');
});

test('bumpConfigPin pins the config dependency exactly and leaves workspace references alone', () => {
  const tpl = '"devDependencies": {\n    "@plexus-ms/config": "^0.3.1",\n    "turbo": "^2.0.0"\n  }\n';
  assert.equal(bumpConfigPin(tpl, '0.100.0'), tpl.replace('"^0.3.1"', '"0.100.0"'));
  const ws = '"devDependencies": { "@plexus-ms/config": "workspace:*" }\n';
  assert.equal(bumpConfigPin(ws, '0.100.0'), ws);
});

test('stampStandard and stampChanged edit the frontmatter only', () => {
  const map = '---\ntitle: PLX\nversion: v0\ntimestamp: 2025-12-31\norder: 1\n---\n\nversion: in prose stays\n';
  assert.equal(
    stampStandard(map, '0.2.0', '2026-01-01'),
    '---\ntitle: PLX\nversion: 0.2.0\ntimestamp: 2026-01-01\norder: 1\n---\n\nversion: in prose stays\n',
  );
  assert.equal(
    stampChanged('---\ncode: PLX-A\nmaturity: standard\nbinds: repo\n---\n', '0.2.0'),
    '---\ncode: PLX-A\nmaturity: standard\nbinds: repo\nchanged: 0.2.0\n---\n',
  );
  assert.equal(
    stampChanged('---\ncode: PLX-A\nmaturity: standard\nbinds: repo\nchanged: 0.1.0\n---\n', '0.2.0'),
    '---\ncode: PLX-A\nmaturity: standard\nbinds: repo\nchanged: 0.2.0\n---\n',
  );
});

test('syncMarker follows the answers file and leaves a conflicted marker alone', () => {
  assert.equal(
    syncMarker('---\nplexus: 0.1.0\nmodules: [PLX-Repo]\n---\nProse.\n', '0.2.0'),
    '---\nplexus: 0.2.0\nmodules: [PLX-Repo]\n---\nProse.\n',
  );
  const conflicted = '---\n<<<<<<< before\nplexus: 0.1.0\n=======\nplexus: 0.1.1\n>>>>>>> after\n---\n';
  assert.equal(syncMarker(conflicted, '0.2.0'), conflicted);
});

test('hasUnmergedEntries and today', () => {
  assert.equal(hasUnmergedEntries(' M a.txt\nUU b.txt\n'), true);
  assert.equal(hasUnmergedEntries(' M a.txt\n?? c\n'), false);
  assert.equal(today(new Date(2026, 0, 5)), '2026-01-05');
});
