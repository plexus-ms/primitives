# @plexus-ms/config

## 0.2.0

### Minor Changes

- 67baa34: Add the `tsconfig-next` subpath export: the shared TypeScript compiler options for Next.js apps — `"extends": "@plexus-ms/config/tsconfig-next"`. `include`/`exclude` and `paths` stay in the extending app, since TypeScript resolves them relative to the file that declares them.

## 0.1.0

### Minor Changes

- b654b86: Initial release: shared tool configurations as subpath exports, starting with Biome — `"extends": ["@plexus-ms/config/biome"]`.
