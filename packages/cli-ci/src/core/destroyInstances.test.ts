import assert from 'node:assert/strict';
import { test } from 'node:test';
import { destroyInstances, repoLabel, selectRunInstances, selectRunRegistrations } from './destroyInstances.ts';
import type { Exo, Instance } from './exoscale.ts';

const run = { repo: 'damage-ms/web', runId: '41836428433', attempt: '1' };
const instance = (name: string, labels: Record<string, string>): Instance => ({
  id: `id-${name}`,
  name,
  state: 'running',
  createdAt: '2026-11-04T13:15:00Z',
  labels: { 'plexus-ci': 'true', repo: 'damage-ms-web', run: run.runId, attempt: '1', ...labels },
});

test('the repo label replaces the slash', () => {
  assert.equal(repoLabel('damage-ms/web'), 'damage-ms-web');
});

test('selectRunInstances takes this run and attempt, spares kept instances, and ignores other runs and unlabelled instances', () => {
  const mine = instance('exo-build-41836428433-website-1-1', {});
  const kept = instance('exo-build-41836428433-website-1-kept', { kept: '2026-11-04T13:17:00Z' });
  const other = instance('exo-build-1-website-1', { run: '1' });
  const attempt2 = instance('exo-build-41836428433-website-2', { attempt: '2' });
  const foreign: Instance = { ...instance('davids-test', {}), labels: {} };
  assert.deepEqual(
    selectRunInstances([mine, kept, other, attempt2, foreign], run).map((i) => i.name),
    [mine.name],
  );
});

test('selectRunRegistrations matches every label shape of the run and leaves busy ones', () => {
  const runners = [
    { id: 1, name: 'exo-build-41836428433-website-1', status: 'offline', busy: false },
    { id: 2, name: 'exo-build-41836428433-vernier-app-1-2', status: 'online', busy: false },
    { id: 3, name: 'exo-dummy-41836428433-1-orphan', status: 'offline', busy: false },
    { id: 4, name: 'exo-build-41836428433-website-1', status: 'online', busy: true },
    { id: 5, name: 'exo-build-99-website-1', status: 'offline', busy: false },
    { id: 6, name: 'exo-build-41836428433-website-2', status: 'offline', busy: false },
  ];
  assert.deepEqual(
    selectRunRegistrations(runners, run).map((r) => r.id),
    [1, 2, 3],
  );
});

const quiet = { say: () => undefined } as unknown as Parameters<typeof destroyInstances>[0];
/** An Exo whose delete refuses an id as often as `refusals` says. */
function fakeExo(instances: Instance[], refusals: Record<string, number>) {
  const calls: string[] = [];
  const exo = {
    listInstances: async () => instances,
    deleteInstance: async (id: string) => {
      calls.push(id);
      if ((refusals[id] ?? 0) > 0) {
        refusals[id] = (refusals[id] ?? 0) - 1;
        throw new Error('HTTP 400: Only running or stopped instances can be deleted.');
      }
      return undefined;
    },
  } as unknown as Exo;
  return { exo, calls };
}

test('destroyInstances deletes the others when one is refused, and asks again for that one', async () => {
  const starting = { ...instance('exo-build-41836428433-website-1', {}), state: 'starting' };
  const running = instance('exo-build-41836428433-vernier-app-1', {});
  const { exo, calls } = fakeExo([starting, running], { [starting.id]: 2 });
  const waits: number[] = [];
  const done = await destroyInstances(quiet, exo, undefined, run, { wait: async (ms) => void waits.push(ms) });
  assert.deepEqual(calls, [starting.id, running.id, starting.id, starting.id]);
  assert.deepEqual(waits, [10_000, 10_000]);
  assert.equal(done.instances.length, 2);
});

test('destroyInstances fails after the last retry, naming what is left, with the others deleted', async () => {
  const stuck = { ...instance('exo-build-41836428433-website-1', {}), state: 'starting' };
  const running = instance('exo-build-41836428433-vernier-app-1', {});
  const { exo, calls } = fakeExo([stuck, running], { [stuck.id]: 99 });
  await assert.rejects(
    destroyInstances(quiet, exo, undefined, run, { retries: 2, wait: async () => undefined }),
    /1 instance\(s\) could not be deleted: exo-build-41836428433-website-1/,
  );
  assert.equal(calls.filter((id) => id === running.id).length, 1);
  assert.equal(calls.filter((id) => id === stuck.id).length, 3);
});
