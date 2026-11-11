import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bumpCatalogPin,
  bumpCollectionPin,
  bumpConfigPin,
  bumpGalaxyVersion,
  bumpManifestVersion,
  bumpPlxPin,
  bumpRunnerImagePin,
  stampChanged,
  stampStandard,
  today,
} from './bookkeeping.ts';

test('bumpGalaxyVersion keeps the trailing comment', () => {
  assert.equal(
    bumpGalaxyVersion('namespace: plexus\nversion: 0.1.0                # mirrors the tag\n', '0.2.0'),
    'namespace: plexus\nversion: 0.2.0                # mirrors the tag\n',
  );
});

test('bumpRunnerImagePin moves a train tag and leaves a trial tag and other images', () => {
  const defaults =
    'actions_runners_image: ghcr.io/plexus-ms/ci-runner:0.109.0\n# e.g. ghcr.io/plexus-ms/ci-runner:sha-abc\nactions_runners_registry_image: registry:2\n';
  assert.equal(bumpRunnerImagePin(defaults, '0.110.0'), defaults.replace('ci-runner:0.109.0', 'ci-runner:0.110.0'));
});

test('bumpCollectionPin touches every plexus.* collection and nothing else', () => {
  const reqs =
    'collections:\n  - name: community.docker\n    version: 9.9.9\n  - name: https://github.com/plexus-ms/primitives.git#/ansible/host/\n    type: git\n    version: v0.1.0\n  - name: https://github.com/plexus-ms/primitives.git#/ansible/platform/\n    type: git\n    version: 0.1.0\n  - name: other\n    version: 1.0.0\n';
  assert.equal(bumpCollectionPin(reqs, '0.2.0'), reqs.replaceAll(/version: v?0\.1\.0/g, 'version: 0.2.0'));
  assert.equal(bumpCollectionPin('collections: []\n', '0.2.0'), 'collections: []\n');
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
  const both = table + '"npm:@plexus-ms/cli-ci" = { version = "0.6.0", allow_low_downloads = true }\n';
  assert.equal(bumpPlxPin(both, '0.100.0'), both.replaceAll('0.6.0', '0.100.0'));
});

test('bumpConfigPin pins the config dependency exactly and leaves workspace references alone', () => {
  const tpl = '"devDependencies": {\n    "@plexus-ms/config": "^0.3.1",\n    "turbo": "^2.0.0"\n  }\n';
  assert.equal(bumpConfigPin(tpl, '0.100.0'), tpl.replace('"^0.3.1"', '"0.100.0"'));
  const ws = '"devDependencies": { "@plexus-ms/config": "workspace:*" }\n';
  assert.equal(bumpConfigPin(ws, '0.100.0'), ws);
});

test('bumpCatalogPin pins the config entry of the plexus catalog', () => {
  const ws = 'catalog:\n  typescript: ^6\ncatalogs:\n  plexus:\n    "@plexus-ms/config": 0.100.0\n';
  assert.equal(bumpCatalogPin(ws, '0.101.0'), ws.replace('0.100.0', '0.101.0'));
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

test('today is the local date, like date +%F', () => {
  assert.equal(today(new Date(2026, 0, 5)), '2026-01-05');
});
