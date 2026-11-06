import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repoLabel, selectRunInstances, selectRunRegistrations } from './destroyInstances.ts';
import type { Instance } from './exoscale.ts';

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
