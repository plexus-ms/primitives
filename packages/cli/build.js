// Bundle plx into one script with no dependencies: src/ and @plexus-ms/lib,
// commander and the prompt, all inlined. `pnpm build` and `prepack` run this.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/plx.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: {
    js: [
      '// Bundled by esbuild (build.js) after the shebang of src/bin.ts; edit src/, not this file.',
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
});
