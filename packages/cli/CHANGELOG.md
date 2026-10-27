# @plexus-ms/cli

## 0.2.0

### Minor Changes

- 26a019a: Add `plx doctor [dir]`, the staleness check of § 13.4 PLX that replaces the toolbox's `staleness.sh`: every marker under a directory is checked against the compendium's modules for requirements that changed since and dependencies not declared where § 1.4 says they are satisfied. In lib: `readCatalog` and `parseModule` for module pages, the pure `diagnose`, and a `git: false` scan option.

## 0.1.0

### Minor Changes

- fd2c05f: Add `plx overview [dir]`, the map of a folder of repos that replaces the toolbox's `overview.sh`: every directory carrying a git repo, a copier template, a copier-managed project or a `PLEXUS.md` declaration, annotated, as a tree or as `--json`. In lib this brings the one parser of the marker and of copier's answers file (`parseMarker`, `parseAnswers`, on the `yaml` package), the `Directory` model with its facets and `kindOf`, and the `overview` reader.
- 05defa2: Scaffold `plx`, the Plexus command-line tool: a commander adapter over `@plexus-ms/lib` with the global `--dry-run`, `--verbose`, `--quiet`, `--yes` and `--json` options, bundled by esbuild into one dependency-free script. No commands yet.
