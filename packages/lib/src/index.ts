// @plexus-ms/lib: the core layer of plx, usable without the CLI.
//
// A verb here is either a reader returning data, or a pure planner returning
// a Plan (plan.ts) from what was read. The Context (context.ts) reads through
// an injected Io (io.ts) and applies plans, narrating every step; the CLI
// package is an adapter that maps argv onto this. The parsers of Plexus's own
// file shapes (marker.ts, copier.ts) live here, once, for every verb.
// Conventions: compendium/miscellaneous/cli-design.md.
export {
  bumpCatalogPin,
  bumpCollectionPin,
  bumpConfigPin,
  bumpGalaxyVersion,
  bumpManifestVersion,
  bumpPlxPin,
  bumpWorkflowRefs,
  COLLECTION_SOURCE,
  CONFIG_PIN,
  hasConflictMarkers,
  hasUnmergedEntries,
  PLX_PIN,
  stampChanged,
  stampStandard,
  syncMarker,
  today,
  WORKFLOW_REF,
} from './bookkeeping.ts';
export { CATALOG_DIRS, type Catalog, type Module, parseModule, readCatalog } from './catalog.ts';
export {
  type ChangedApps,
  type ChangedAppsInput,
  type Reason,
  readChangedApps,
  selectChangedApps,
} from './changedApps.ts';
export {
  CHANGESET_DIR,
  type Changeset,
  type ChangesetInput,
  changesetPath,
  type DependencyChange,
  type Manifest,
  parseCatalogs,
  planChangeset,
  readChangeset,
  workspaceGlobs,
} from './changeset.ts';
export { type Consumer, expectedBranch, findConsumers, presetSource, type Site } from './consumers.ts';
export { Context, type Options } from './context.ts';
export { ANSWERS_FILE, type Answers, COPIER_VERSION, copierVia, parseAnswers, TEMPLATE_FILES } from './copier.ts';
export { type Deploy, type DeployOptions, deploy, q as shellQuote, renderCompose } from './deploy.ts';
export {
  type DeployTargets,
  type InventoryFile,
  parseInventoryFile,
  readDeployTargets,
  selectDeployTargets,
} from './deployTargets.ts';
export { compareTrains, type Diagnosis, diagnose, type Report } from './doctor.ts';
export { frontmatterField, setFrontmatterField } from './frontmatter.ts';
export { type DirEntry, ExecError, type ExecOptions, type Io, realIo, render } from './io.ts';
export { type Declaration, MARKER_FILE, parseMarker, splitFrontmatter } from './marker.ts';
export {
  type Directory,
  type GitFacet,
  isNotable,
  type Kind,
  kindOf,
  shortRemote,
  type TemplateFacet,
} from './model.ts';
export { overview, PRUNED, type ScanOptions } from './overview.ts';
export { body, describe, type Plan, run, type Step, write } from './plan.ts';
export { isClean, propagate, type Summary } from './propagate.ts';
export {
  type CompendiumCheck,
  checkCompendium,
  extractRequirements,
  MAP_PAGE,
  modulePages,
  type PageMode,
  type Scan,
  scanPage,
} from './requirements.ts';
export { preflightSelf, SELF_PACKAGE } from './self.ts';
export { type PublishWait, type ShipOptions, type ShipResult, ship } from './ship.ts';
export {
  isTrainVersion,
  latestTag,
  nextMinor,
  PHASES,
  PRIMITIVES,
  phasesOf,
  preflightForge,
  preflightRelease,
  readTrain,
  resolveVersion,
  TRAIN_PACKAGES,
  TRAIN_REPOS,
  type Train,
  type TrainRepo,
  UPSTREAM,
  UsageError,
} from './train.ts';
export { PRESETS, type UpdateOptions, update } from './update.ts';
