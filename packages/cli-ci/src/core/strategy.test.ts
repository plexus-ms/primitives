import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runnerOf, settingsOf } from './strategy.ts';

test('the settings default to the forge’s runners and registry, and the registry follows the strategy', () => {
  assert.deepEqual(settingsOf({}), { strategy: 'github', registry: 'ghcr', overlay: 'none' });
  assert.deepEqual(settingsOf({ CI_STRATEGY: 'hybrid' }), { strategy: 'hybrid', registry: 'own', overlay: 'none' });
  assert.deepEqual(settingsOf({ CI_STRATEGY: 'on-prem', CI_REGISTRY: 'ghcr', CI_OVERLAY: 'netbird' }), {
    strategy: 'on-prem',
    registry: 'ghcr',
    overlay: 'netbird',
  });
  assert.equal(settingsOf({ CI_STRATEGY: 'hybrid' }, 'github').strategy, 'github');
});

test('an answer outside its set is a usage error that names the set', () => {
  assert.throws(
    () => settingsOf({ CI_STRATEGY: 'cloud' }),
    /the strategy is "cloud"; it is one of github, on-prem, hybrid/,
  );
  assert.throws(() => settingsOf({ CI_REGISTRY: 'dockerhub' }), /CI_REGISTRY is "dockerhub"/);
  assert.throws(() => settingsOf({ CI_OVERLAY: 'tailscale' }), /CI_OVERLAY is "tailscale"/);
});

test('a size runs on the forge, on a slot, or under hybrid on an instance of its own when it is large', () => {
  assert.equal(runnerOf('github', 'small'), 'ubuntu-latest');
  assert.equal(runnerOf('github', 'large', 'exo-build-1-a-1'), 'ubuntu-latest');
  assert.equal(runnerOf('on-prem', 'medium'), 'ci-medium');
  assert.equal(runnerOf('on-prem', 'large', 'exo-build-1-a-1'), 'ci-large');
  assert.equal(runnerOf('hybrid', 'small'), 'ci-small');
  assert.equal(runnerOf('hybrid', 'large', 'exo-build-1-a-1'), 'exo-build-1-a-1');
  assert.throws(() => runnerOf('hybrid', 'large'), /needs its instance/);
});
