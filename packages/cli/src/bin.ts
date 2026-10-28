#!/usr/bin/env node
// Entry point of `plx`. Everything else is importable and testable without a
// process: build the program, parse argv, map a thrown error to exit code 1,
// a mistake in the arguments to 2.
import { UsageError } from '@plexus-ms/lib';
import { buildProgram } from './program.ts';

try {
  await buildProgram().parseAsync(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`✗ ${message}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
