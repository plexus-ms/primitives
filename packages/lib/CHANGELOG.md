# @plexus-ms/lib

## 0.1.0

### Minor Changes

- 05defa2: Scaffold `@plexus-ms/lib`, the core layer behind `plx`: an injected `Io`, a `Plan` of effects as data, and a `Context` that reads, confirms and applies plans with every step narrated, so that a dry run and a real run come from the one plan. No verbs yet; it has no dependencies.
- fd2c05f: Add `plx overview [dir]`, the map of a folder of repos that replaces the toolbox's `overview.sh`: every directory carrying a git repo, a copier template, a copier-managed project or a `PLEXUS.md` declaration, annotated, as a tree or as `--json`. In lib this brings the one parser of the marker and of copier's answers file (`parseMarker`, `parseAnswers`, on the `yaml` package), the `Directory` model with its facets and `kindOf`, and the `overview` reader.
