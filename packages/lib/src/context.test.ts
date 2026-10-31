import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Context, type Options } from './context.ts';
import { type ExecOptions, type Io, realIo } from './io.ts';
import { run, write } from './plan.ts';

/** A fake Io that records what it was asked and performs nothing. */
function make(overrides: Options = {}, prompt?: Io['prompt']) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (c: Buffer) => {
    out += c;
  });
  stderr.on('data', (c: Buffer) => {
    err += c;
  });
  const calls: string[] = [];
  const io: Io = {
    stdout,
    stderr,
    prompt,
    exec: async (command, args, options: ExecOptions = {}) => {
      calls.push(`exec ${command} ${args.join(' ')}${options.input ? ` < ${options.input}` : ''}`);
      return 'state\n';
    },
    readFile: async (path) => {
      calls.push(`readFile ${path}`);
      return 'content';
    },
    writeFile: async (path) => {
      calls.push(`writeFile ${path}`);
    },
    readDir: async () => [],
  };
  return { ctx: new Context(overrides, io), calls, out: () => out, err: () => err };
}

const plan = [
  run('docker', ['compose', 'pull']),
  run('ssh', ['deploy@host', '--', 'echo hi'], { input: 'hi\n' }),
  write('/tmp/x', 'abc'),
];

test('a dry run narrates the plan exactly as a real run and performs nothing', async () => {
  const real = make();
  const dry = make({ dryRun: true });
  await real.ctx.apply(plan);
  await dry.ctx.apply(plan);
  const lines = ['$ docker compose pull', "$ ssh deploy@host -- 'echo hi'", '> /tmp/x (3 bytes)'];
  assert.equal(real.err(), `${lines.join('\n')}\n`);
  assert.equal(dry.err(), `${lines.map((l) => `[dry-run] ${l}`).join('\n')}\n`);
  assert.deepEqual(real.calls, [
    'exec docker compose pull',
    'exec ssh deploy@host -- echo hi < hi\n',
    'writeFile /tmp/x',
  ]);
  assert.deepEqual(dry.calls, []);
});

test('verbose shows what a step feeds in', async () => {
  const { ctx, err } = make({ dryRun: true, verbose: 1 });
  await ctx.apply([run('ssh', ['deploy@host', '--', 'cat > x'], { input: 'hi\n' })]);
  assert.equal(err(), "[dry-run] $ ssh deploy@host -- 'cat > x'\n    hi\n");
});

test('a read is performed in a dry run and narrated only when verbose', async () => {
  const quiet = make({ dryRun: true });
  assert.equal((await quiet.ctx.read('git', ['rev-parse', 'HEAD'])).trim(), 'state');
  assert.deepEqual(quiet.calls, ['exec git rev-parse HEAD']);
  assert.equal(quiet.err(), '');
  const verbose = make({ dryRun: true, verbose: 1 });
  await verbose.ctx.read('git', ['rev-parse', 'HEAD']);
  assert.equal(verbose.err(), '? $ git rev-parse HEAD\n');
});

test('results go to stdout, human by default and JSON under --json', () => {
  const human = make();
  human.ctx.result(['app-a', 'app-b']);
  assert.equal(human.out(), 'app-a\napp-b\n');
  const json = make({ json: true });
  json.ctx.result(['app-a', 'app-b']);
  assert.deepEqual(JSON.parse(json.out()), ['app-a', 'app-b']);
  const custom = make();
  custom.ctx.result({ n: 2 }, (d) => `${d.n} apps`);
  assert.equal(custom.out(), '2 apps\n');
});

test('--quiet silences narration but not outcomes', async () => {
  const { ctx, err } = make({ quiet: true, verbose: 2 });
  await ctx.apply(plan);
  ctx.done('deployed');
  assert.equal(err(), '✓ deployed\n');
});

test('confirm answers yes under --yes or --dry-run, asks the prompt otherwise, and never hangs', async () => {
  assert.equal(await make({ yes: true }).ctx.confirm('deploy?'), true);
  assert.equal(await make({ dryRun: true }).ctx.confirm('deploy?'), true);
  assert.equal(await make({}, async () => false).ctx.confirm('deploy?'), false);
  await assert.rejects(make().ctx.confirm('deploy?'), /pass --yes/);
});

test('the real Io runs processes and reports failure with the rendered command and stderr', async () => {
  const io = realIo();
  assert.equal((await io.exec('echo', ['hello world'])).trim(), 'hello world');
  await assert.rejects(io.exec('sh', ['-c', 'echo boom >&2; exit 3']), (e: Error) => {
    assert.match(e.message, /^sh -c 'echo boom >&2; exit 3' exited with 3\nboom$/);
    return true;
  });
});
