import assert from 'node:assert/strict';
import { test } from 'node:test';
import { render } from './io.ts';
import { describe, run, write } from './plan.ts';

test('a step describes itself as the shell an operator would type', () => {
  assert.equal(
    describe(run('git', ['push', 'origin', 'main'], { cwd: '/repo' })),
    '$ (cd /repo && git push origin main)',
  );
  assert.equal(describe(write('/etc/x', 'ab')), '> /etc/x (2 bytes)');
});

test('render quotes only what a shell would need quoted', () => {
  assert.equal(render('ssh', ['deploy@host', 'bash', '-s']), 'ssh deploy@host bash -s');
  assert.equal(render('echo', ["it's"]), "echo 'it'\\''s'");
});
