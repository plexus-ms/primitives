import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from './context.ts';
import { fakeIo } from './testing/fakeIo.ts';
import { isTrainVersion, preflightForge } from './train.ts';

const withGh = (gh: () => string | undefined) =>
  new Context(
    {},
    fakeIo({}, () => undefined, { gh }),
  );

test('preflightForge needs a logged-in gh', async () => {
  await preflightForge(withGh(() => 'Logged in\n'));
  await assert.rejects(preflightForge(withGh(() => undefined)), /gh is not logged in/);
});

test('a train version is plain semver', () => {
  assert.equal(isTrainVersion('0.118.0'), true);
  assert.equal(isTrainVersion('v0.21'), false);
  assert.equal(isTrainVersion('0.100.0-rc.1'), false);
});
