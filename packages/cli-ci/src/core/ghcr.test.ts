import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context, ExecError } from '@plexus-ms/lib';
import { fakeIo, notThere } from '../testing/fakeIo.ts';
import { Packages, packageOf, prunable, prune, type Version } from './ghcr.ts';

const now = new Date('2026-11-06T12:00:00Z');
const old = '2026-09-30T12:00:00Z';
const recent = '2026-10-20T12:00:00Z';
const v = (id: number, createdAt: string, tags: string[]): Version => ({ id, createdAt, tags });

test('only a version older than thirty days whose every tag is a candidate’s goes', () => {
  const versions = [
    v(1, old, ['build-0f2a']),
    v(2, old, ['build-0f2a', 'test-5b05']),
    v(3, old, ['build-0f2a', 'test-5b05', '8e51d0821a4c0d1f6b0a9d6e2f0c7d3b5a1e4f90']),
    v(4, recent, ['build-c51b']),
    v(5, old, []),
    v(6, old, ['cache']),
    v(7, old, ['build-0f2a', 'latest']),
    v(8, old, ['build-notahash']),
  ];
  assert.deepEqual(
    prunable(versions, now).map((x) => x.id),
    [1, 2],
  );
});

test('an app’s package is named by what follows the owner in the prefix, and the app', () => {
  assert.equal(packageOf('ghcr.io/Damage-MS', 'website'), 'website');
  assert.equal(packageOf('ghcr.io/damage-ms/web/', 'app'), 'web/app');
});

test('prune takes the named packages only, skips one that does not exist, and deletes by the rule; a dry run deletes nothing', async () => {
  const calls: string[] = [];
  const io = fakeIo({}, undefined, {
    curl: (_cwd, _args, input = '') => {
      const method = input.match(/request = "(\w+)"/)?.[1];
      const url = input.match(/url = "([^"]+)"/)?.[1] ?? '';
      calls.push(`${method} ${url.replace('https://api.github.com/orgs/damage-ms/packages', '')}`);
      assert.match(input, /Authorization: Bearer ghp_x/);
      if (method === 'DELETE') return '';
      if (url.includes('/container/website/'))
        return JSON.stringify([
          { id: 1, created_at: old, metadata: { container: { tags: ['build-0f2a'] } } },
          { id: 2, created_at: old, metadata: { container: { tags: ['build-aaaa', 'abc123'] } } },
        ]);
      if (url.includes('/container/web%2Fapp/'))
        return JSON.stringify([{ id: 3, created_at: recent, metadata: { container: { tags: ['test-5b05'] } } }]);
      return notThere('curl');
    },
  });
  const ctx = new Context({}, io);
  const names = ['website', 'never-built', 'web/app'];
  const pruned = await prune(ctx, new Packages(ctx, 'damage-ms', 'ghp_x'), names, now);
  assert.deepEqual(pruned, [{ package: 'website', id: 1, tags: ['build-0f2a'] }]);
  assert.deepEqual(calls, [
    'GET /container/website/versions?per_page=100&page=1',
    'DELETE /container/website/versions/1',
    'GET /container/never-built/versions?per_page=100&page=1',
    'GET /container/web%2Fapp/versions?per_page=100&page=1',
  ]);

  calls.length = 0;
  const dry = new Context({ dryRun: true }, io);
  assert.equal((await prune(dry, new Packages(dry, 'damage-ms', 'ghp_x'), names, now)).length, 1);
  assert.ok(!calls.some((c) => c.startsWith('DELETE')));
});

test('a package API that refuses the token is an error, not a package that does not exist', async () => {
  const io = fakeIo({}, undefined, {
    curl: () => {
      throw new ExecError('curl', 22, 'curl: (22) The requested URL returned error: 401\n');
    },
  });
  const ctx = new Context({}, io);
  await assert.rejects(prune(ctx, new Packages(ctx, 'damage-ms', 'ghp_x'), ['website'], now), /401/);
});
