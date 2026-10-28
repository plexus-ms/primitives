import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Context } from './context.ts';
import { preflightSelf } from './self.ts';
import { fakeIo } from './testing/fakeIo.ts';

/** A Context whose `npm view` answers `latest`, or fails when undefined; with what it narrated. */
function registry(latest: string | undefined) {
  const io = fakeIo({}, undefined, { npm: (_cwd, args) => (args[0] === 'view' ? latest : undefined) });
  const stderr = new PassThrough();
  let out = '';
  stderr.on('data', (c: Buffer) => {
    out += c;
  });
  return { ctx: new Context({}, { ...io, stderr }), said: () => out };
}

test('preflightSelf refuses a plx behind the newest release, naming the update', async () => {
  await assert.rejects(
    preflightSelf(registry('0.7.0\n').ctx, '0.6.0'),
    /plx 0\.6\.0 is behind 0\.7\.0.*mise up npm:@plexus-ms\/cli/,
  );
});

test('preflightSelf passes plx at or ahead of the newest release', async () => {
  await preflightSelf(registry('0.7.0\n').ctx, '0.7.0');
  await preflightSelf(registry('0.7.0\n').ctx, '0.8.0'); // a local build before its release
});

test('preflightSelf only warns when the registry cannot be asked', async () => {
  const { ctx, said } = registry(undefined);
  await preflightSelf(ctx, '0.6.0');
  assert.match(said(), /could not ask the registry for the newest @plexus-ms\/cli; going on with plx 0\.6\.0/);
});
