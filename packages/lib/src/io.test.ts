import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecError, orAbsent } from './io.ts';

const exit = (code: number, stderr: string) => Promise.reject(new ExecError('tool', code, stderr));

test('orAbsent: an exit it accepts is undefined, any other failure stays an error', async () => {
  assert.equal(await orAbsent(Promise.resolve('out')), 'out');
  assert.equal(await orAbsent(exit(1, 'no such path')), undefined);
  const notFound = (e: ExecError) => /404/.test(e.stderr);
  assert.equal(await orAbsent(exit(22, 'error: 404'), notFound), undefined);
  await assert.rejects(orAbsent(exit(22, 'error: 401'), notFound), /401/);
  await assert.rejects(orAbsent(Promise.reject(new Error('spawn tool ENOENT'))), /ENOENT/);
});
