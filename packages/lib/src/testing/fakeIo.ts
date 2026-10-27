// A test Io over an in-memory tree: files map to their text, directories to
// nested trees; `git` answers exec calls. Not shipped (excluded in tsconfig).
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { Io } from '../io.ts';

export type Tree = { [name: string]: string | Tree };

export function fakeIo(tree: Tree, git: (cwd: string, args: string[]) => string | undefined = () => undefined): Io {
  const at = (path: string): Tree | string | undefined =>
    path
      .split('/')
      .filter((p) => p && p !== '.')
      .reduce<Tree | string | undefined>((node, p) => (typeof node === 'object' ? node[p] : undefined), tree);
  return {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exec: async (command, args, options) => {
      assert.equal(command, 'git');
      const out = git(options?.cwd ?? '', args);
      if (out === undefined) throw new Error(`fake git: ${args.join(' ')} fails in ${options?.cwd}`);
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
