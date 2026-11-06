import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildArgs, tagsOf } from './build.ts';

const options = { app: 'website', hash: '0f2a', sha: 'abc', encryptionKey: 'k', registry: { kind: 'own' } as const };

test('the build names both sidecars as cache sources when the previous one answers, and only the current one otherwise', () => {
  const both = buildArgs(options, '/ctx/full', '/ctx/meta.json', true).join(' ');
  assert.match(both, /--cache-from type=registry,ref=localhost:5000\/website:cache/);
  assert.match(both, /--cache-from type=registry,ref=localhost:5001\/website:cache/);
  assert.match(both, /--cache-to type=registry,ref=localhost:5000\/website:cache,mode=max/);
  assert.match(both, /--tag localhost:5000\/website:build-0f2a --tag localhost:5000\/website:abc/);
  assert.match(both, /--file \/ctx\/full\/apps\/website\/docker\/Dockerfile/);
  assert.match(both, /--provenance=false --sbom=false/);
  const one = buildArgs(options, '/ctx/full', '/ctx/meta.json', false).join(' ');
  assert.doesNotMatch(one, /5001/);
});

test('a no-cache build has no cache arguments and carries the extra tags', () => {
  const args = buildArgs({ ...options, noCache: true, tags: ['repro-41-1'] }, '/c', '/m', true).join(' ');
  assert.match(args, /--no-cache/);
  assert.doesNotMatch(args, /cache-from|cache-to/);
  assert.match(args, /--tag localhost:5000\/website:repro-41-1/);
});

test('in the forge’s registry a build pushes no commit tag and names no previous month', () => {
  const ghcr = { ...options, registry: { kind: 'ghcr', prefix: 'ghcr.io/plexus-ms-tenant' } as const };
  assert.deepEqual(tagsOf(ghcr), ['build-0f2a']);
  assert.deepEqual(tagsOf(options), ['build-0f2a', 'abc']);
  const args = buildArgs(ghcr, '/c', '/m', false).join(' ');
  assert.match(args, /--tag ghcr.io\/plexus-ms-tenant\/website:build-0f2a/);
  assert.doesNotMatch(args, /website:abc/);
  assert.match(args, /--cache-to type=registry,ref=ghcr.io\/plexus-ms-tenant\/website:cache,mode=max/);
  assert.doesNotMatch(args, /localhost/);
});
