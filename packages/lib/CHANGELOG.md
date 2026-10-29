# @plexus-ms/lib

## 0.9.0

### Minor Changes

- 26723f0: `plx overview -s`/`--sync` fetches every repo's remotes first (eight at a time) and marks each branch with the commits it is behind (`↓n`) and ahead of (`↑n`) its upstream; a fetch that fails shows as a problem on the repo. Off by default, since the fetches make a quick look slow.

## 0.8.1

### Patch Changes

- 06286c4: The refusal of a `plx` behind its newest release names the update as `mise cache clear npm:@plexus-ms/cli && mise up npm:@plexus-ms/cli` again, scoped to the one tool: mise caches a tool's version list as well as holding back young releases, and the 0.8.0 release showed `mise up` answering "up to date" from that cache minutes after the publish.

## 0.8.0

### Minor Changes

- 9b5f892: `plx changeset` also owes a patch to a published package whose shipped source the bot's branch changed (its `src/`, tests excluded), for a pin the update bot moves outside a manifest through a regex manager. The copier version plx pins is the first: annotated `// renovate: datasource=pypi depName=copier`, it is bumped by Renovate and now released like any dependency bump.

### Patch Changes

- cb0532f: The refusal of a `plx` behind its newest release names the update as `mise up npm:@plexus-ms/cli` alone: what held a fresh release back was mise's minimum release age, not its cache, so the `mise cache clear` it suggested first was never needed.

## 0.7.0

### Minor Changes

- 5364d2c: `ship` and `propagate` refuse to run behind the newest `@plexus-ms/cli` on the registry (asked with `npm view`; an unreachable registry only warns), and propagation runs copier through `mise exec copier@<version>` at the version plx pins (`COPIER_VERSION`, 9.19.1), so the copier a consumer is updated with travels with plx instead of depending on the operator's PATH.

## 0.6.0

### Minor Changes

- 7060269: Add `deploy`, the last ops verb that `ci-cd` carried as bash: render the app's compose file with the image pinned, stage it on the host, pull, migrate, swap, up, poll readiness, roll back on failure. Every command sent to the host is one line of shell over a shared ssh connection, carried in the plan and printed verbatim by `--dry-run`; the heredoc `ssh` step of the plan model is gone with the script it served.

## 0.5.0

### Minor Changes

- b29765e: Add `changed-apps` and `deploy-targets`, the two read-only ops verbs that `ci-cd` carried as bash: the apps whose sources changed between two refs, dependents included, and each app's deploy target from a platform repo's inventory.

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
