# @plexus-ms/config

## 0.3.0

### Minor Changes

- d3bc636: Add the `tsconfig-cli` subpath export: the shared TypeScript compiler options for Node CLI and library packages that build to `dist` — `"extends": "@plexus-ms/config/tsconfig-cli"`. It emits (`declaration`, `declarationMap`, `sourceMap`) under `NodeNext` resolution, so source must use explicit `.js` import specifiers. `outDir`/`rootDir` and `include`/`exclude` stay in the extending package, since TypeScript resolves those paths relative to the file that declares them. Requires `@types/node`, which the config pins via `"types": ["node"]`.

### Patch Changes

- 125d677: Update package descriptions

## 0.2.0

### Minor Changes

- 67baa34: Add the `tsconfig-next` subpath export: the shared TypeScript compiler options for Next.js apps — `"extends": "@plexus-ms/config/tsconfig-next"`. `include`/`exclude` and `paths` stay in the extending app, since TypeScript resolves them relative to the file that declares them.

## 0.1.0

### Minor Changes

- b654b86: Initial release: shared tool configurations as subpath exports, starting with Biome — `"extends": ["@plexus-ms/config/biome"]`.
