// Everything a verb does to the world goes through an Io, injected into the
// Context (context.ts). The real one wraps node; a test hands in a fake and
// asserts what was asked of it, with no subprocess and no filesystem.
import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import type { Writable } from 'node:stream';

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Fed to the process's stdin, then closed. */
  input?: string;
  /**
   * Pass the process's output through to the terminal instead of capturing it,
   * and, when nothing is fed in, its input too: a program that asks questions
   * (copier) gets to ask them. Both of its streams go to stderr: stdout is the
   * verb's result and stays clean for `--json` and pipes.
   */
  inherit?: boolean;
}

export interface Io {
  stdout: Writable;
  stderr: Writable;
  /**
   * Ask a yes/no question of a human, or undefined when there is none: off a
   * terminal, or in a program that brings no prompt (the CLI supplies one).
   */
  prompt?: (question: string) => Promise<boolean>;
  /** Run a process to completion; resolves with its stdout, rejects with ExecError on nonzero exit. */
  exec(command: string, args: string[], options?: ExecOptions): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** The entries of a directory, in no particular order. */
  readDir(path: string): Promise<DirEntry[]>;
}

export interface DirEntry {
  name: string;
  directory: boolean;
}

export class ExecError extends Error {
  readonly command: string;
  readonly code: number | null;
  readonly stderr: string;

  constructor(command: string, code: number | null, stderr: string) {
    super(`${command} exited with ${code ?? 'signal'}${stderr ? `\n${stderr.trimEnd()}` : ''}`);
    this.command = command;
    this.code = code;
    this.stderr = stderr;
  }
}

/** True when a human is on both ends of the terminal. */
export const isInteractive = (): boolean => process.stdin.isTTY === true && process.stderr.isTTY === true;

export function realIo(prompt?: Io['prompt']): Io {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    prompt: prompt && isInteractive() ? prompt : undefined,
    exec: (command, args, options = {}) =>
      new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env,
          stdio: [
            options.input !== undefined ? 'pipe' : options.inherit ? 'inherit' : 'ignore',
            options.inherit ? process.stderr.fd : 'pipe',
            'pipe',
          ],
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk;
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk;
          if (options.inherit) process.stderr.write(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve(stdout);
          else reject(new ExecError(render(command, args), code, stderr));
        });
        if (options.input !== undefined) child.stdin?.end(options.input);
      }),
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, content) => writeFile(path, content),
    readDir: async (path) =>
      (await readdir(path, { withFileTypes: true })).map((e) => ({ name: e.name, directory: e.isDirectory() })),
  };
}

/** The command line as a shell would need it typed: args quoted when they must be. */
export function render(command: string, args: string[]): string {
  return [command, ...args].map(quote).join(' ');
}

function quote(arg: string): string {
  return /^[\w./:@%+=,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}
