import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Command } from 'commander';
import { commands } from './commands/index.ts';
import { buildProgram, contextOf } from './program.ts';

test('global options reach a command through its context', async () => {
  let seen: ReturnType<typeof contextOf> | undefined;
  commands.push((program: Command) => {
    program
      .command('probe')
      .description('test-only')
      .action((_opts, cmd: Command) => {
        seen = contextOf(cmd);
      });
  });
  try {
    await buildProgram().parseAsync(['-n', '-vv', '-y', '--json', 'probe'], { from: 'user' });
  } finally {
    commands.pop();
  }
  assert.ok(seen);
  assert.equal(seen.dryRun, true);
  assert.equal(seen.verbose, 2);
  assert.equal(seen.yes, true);
  assert.equal(seen.json, true);
});

test('help lists the global options', () => {
  const help = buildProgram().helpInformation();
  for (const flag of ['--dry-run', '--verbose', '--quiet', '--yes', '--json', '--version'])
    assert.match(help, new RegExp(flag));
});
