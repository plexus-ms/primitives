# @plexus-ms/lib

## 0.4.0

### Minor Changes

- 0060836: `plx changeset`: the changeset a dependency bump owes. On an update bot's branch it diffs every workspace package's `dependencies`, `optionalDependencies` and `peerDependencies` against the merge base, catalog entries included, and writes one deterministic `.changeset/bot-<branch>.md`: a patch per package whose runtime dependencies moved, a major when a peer range did; devDependencies, private and ignored packages owe nothing, and a stale file from an earlier run is removed. In lib: `readChangeset`, the pure `planChangeset`, `parseCatalogs` and `workspaceGlobs`.
  
  The cli now declares what it inlines, `@plexus-ms/lib`, `commander` and `@inquirer/prompts`, as dependencies rather than devDependencies: a release of theirs has to release the cli that carries them, which changesets and `plx changeset` do for a declared dependency, and the redundant install is small. The published 0.3.0 bundle had missed lib 0.3.1's fix that keeps stdout clean during interactive steps; this release carries it.

## 0.3.1

### Patch Changes

- b675a94: An interactive step's output (copier's, during `ship` and `propagate`) goes to stderr like every other narration; stdout stays the verb's result, so `--json` and pipes are not corrupted.

## 0.3.0

### Minor Changes

- b7fb2bd: `plx ship`, `plx propagate` and `plx requirements`: the release train and the compendium's requirements check move from bash into plx.

  - `ship` tags every train repo identically after writing the train bookkeeping (galaxy version, the preset's collection pin, workflow refs, the map's version and timestamp, `changed` on every standard module whose requirements moved), then propagates.
  - `propagate` copier-updates every consumer in the workspace on its expected branch, syncs markers, refreshes lockfiles and pins the consumers' ci-cd workflow refs; `-n` previews in scratch clones.
  - `requirements` lints the standard's map and module pages and extracts a module's requirement lines, replacing the compendium's `requirements.sh`.
  - lib: `Context.stage` performs a step on scratch state in every mode; `run` steps can be `interactive`; line-based frontmatter edits; the train, consumer and bookkeeping readers behind the verbs.
  - `plx` exits 2 on a mistake in the arguments.

## 0.2.0

### Minor Changes

- 26a019a: Add `plx doctor [dir]`, the staleness check of § 13.4 PLX that replaces the toolbox's `staleness.sh`: every marker under a directory is checked against the compendium's modules for requirements that changed since and dependencies not declared where § 1.4 says they are satisfied. In lib: `readCatalog` and `parseModule` for module pages, the pure `diagnose`, and a `git: false` scan option.

## 0.1.0

### Minor Changes

- 05defa2: Scaffold `@plexus-ms/lib`, the core layer behind `plx`: an injected `Io`, a `Plan` of effects as data, and a `Context` that reads, confirms and applies plans with every step narrated, so that a dry run and a real run come from the one plan. No verbs yet; it has no dependencies.
- fd2c05f: Add `plx overview [dir]`, the map of a folder of repos that replaces the toolbox's `overview.sh`: every directory carrying a git repo, a copier template, a copier-managed project or a `PLEXUS.md` declaration, annotated, as a tree or as `--json`. In lib this brings the one parser of the marker and of copier's answers file (`parseMarker`, `parseAnswers`, on the `yaml` package), the `Directory` model with its facets and `kindOf`, and the `overview` reader.
