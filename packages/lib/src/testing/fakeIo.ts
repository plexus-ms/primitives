// A test Io over an in-memory tree: files map to their text, directories to
// nested trees; `git` answers exec calls. Not shipped (excluded in tsconfig).
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ExecError, type Io } from '../io.ts';

export type Tree = { [name: string]: string | Tree };

export type FakeExec = (cwd: string, args: string[], input?: string) => string | undefined;

/** `git` answers git calls; `other` answers any other command, by name. */
export function fakeIo(tree: Tree, git: FakeExec = () => undefined, other: Record<string, FakeExec> = {}): Io {
  const at = (path: string): Tree | string | undefined =>
    path
      .split('/')
      .filter((p) => p && p !== '.')
      .reduce<Tree | string | undefined>((node, p) => (typeof node === 'object' ? node[p] : undefined), tree);
  return {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exec: async (command, args, options) => {
      const handler = command === 'git' ? git : other[command];
      assert.ok(handler, `fake io: no handler for ${command}`);
      const out = handler(options?.cwd ?? '', args, options?.input);
      if (out === undefined)
        throw new ExecError(`${command} ${args.join(' ')}`, 1, `fake ${command} fails in ${options?.cwd}`);
      return out;
    },
    readFile: async (path) => {
      const node = at(path);
      if (typeof node !== 'string') throw new Error(`no file ${path}`);
      return node;
    },
    writeFile: async () => {},
    readDir: async (path) => {
      const node = at(path);
      if (typeof node !== 'object') throw new Error(`no directory ${path}`);
      return Object.entries(node).map(([name, v]) => ({ name, directory: typeof v === 'object' }));
    },
  };
}
