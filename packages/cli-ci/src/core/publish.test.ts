import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@plexus-ms/lib';
import { fakeIo, notThere } from '../testing/fakeIo.ts';
import { publish } from './publish.ts';

const own = { kind: 'own' } as const;

test('a publish copies the tested manifest when the forge’s registry lacks it, and only tags when it is there', async () => {
  const calls: string[][] = [];
  const io = (there: boolean) =>
    fakeIo({}, undefined, {
      crane: (_cwd, args) => {
        calls.push(args);
        if (args[0] === 'digest') return there ? 'sha256:abc' : notThere('crane');
        return '';
      },
      curl: (_cwd, args) => (args.at(-1)?.includes(':5000/') ? '' : notThere('curl')),
    });
  const options = {
    app: 'vernier-app',
    build: 'b1',
    test: 't1',
    sha: 'deadbeef',
    prefix: 'ghcr.io/damage-ms',
    registry: own,
  };

  const copied = await publish(new Context({}, io(false)), options);
  assert.equal(copied.copied, true);
  assert.deepEqual(copied.tags, ['build-b1', 'deadbeef', 'test-t1']);
  assert.deepEqual(
    calls.filter((c) => c[0] !== 'digest'),
    [
      ['copy', '--insecure', 'localhost:5000/vernier-app:test-t1', 'ghcr.io/damage-ms/vernier-app:build-b1'],
      ['tag', 'ghcr.io/damage-ms/vernier-app:build-b1', 'deadbeef'],
      ['tag', 'ghcr.io/damage-ms/vernier-app:build-b1', 'test-t1'],
    ],
  );

  calls.length = 0;
  const tagged = await publish(new Context({}, io(true)), { ...options, test: undefined });
  assert.equal(tagged.copied, false);
  assert.deepEqual(
    calls.filter((c) => c[0] !== 'digest'),
    [['tag', 'ghcr.io/damage-ms/vernier-app:build-b1', 'deadbeef']],
  );
});

test('a publish without the tested tag in the sidecar is an error', async () => {
  const io = fakeIo({}, undefined, {
    crane: (_cwd, args) => (args[0] === 'digest' ? notThere('crane') : ''),
    curl: () => notThere('curl'),
  });
  await assert.rejects(
    publish(new Context({}, io), { app: 'a', build: 'b', test: 't', sha: 's', prefix: 'ghcr.io/o', registry: own }),
    /a:test-t is in no registry here; the tests did not pass/,
  );
});

test('where the candidates live in the forge’s registry, the tested manifest only gets the commit’s tag', async () => {
  const calls: string[][] = [];
  const io = (tested: boolean) =>
    fakeIo({}, undefined, {
      crane: (_cwd, args) => {
        calls.push(args);
        if (args[0] === 'digest') return tested ? 'sha256:abc' : notThere('crane');
        return '';
      },
    });
  const options = {
    app: 'website',
    build: 'b1',
    test: 't1',
    sha: 'deadbeef',
    prefix: 'ghcr.io/plexus-ms-tenant',
    registry: { kind: 'ghcr', prefix: 'ghcr.io/plexus-ms-tenant' } as const,
  };
  const result = await publish(new Context({}, io(true)), options);
  assert.equal(result.copied, false);
  assert.deepEqual(result.tags, ['build-b1', 'test-t1', 'deadbeef']);
  assert.deepEqual(calls, [
    ['digest', 'ghcr.io/plexus-ms-tenant/website:test-t1'],
    ['tag', 'ghcr.io/plexus-ms-tenant/website:test-t1', 'deadbeef'],
  ]);
  await assert.rejects(publish(new Context({}, io(false)), options), /website:test-t1 is in no registry here/);
});

test('a dry run publishes where crane is missing, on a placeholder', async () => {
  const io = fakeIo({}, undefined, {
    crane: () => {
      throw Object.assign(new Error('spawn crane ENOENT'), { code: 'ENOENT' });
    },
  });
  const options = { app: 'website', build: 'b1', test: 't1', sha: 'deadbeef', prefix: 'ghcr.io/o' };
  const dry = new Context({ dryRun: true }, io);
  assert.equal((await publish(dry, { ...options, registry: { kind: 'ghcr', prefix: 'ghcr.io/o' } })).copied, false);
  assert.equal((await publish(dry, { ...options, registry: own })).copied, true);
});
