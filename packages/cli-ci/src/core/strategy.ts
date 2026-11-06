// The three answers a repo gives about its CI (§ 8 PLX-Delivery), read once:
// the strategy (where the jobs of each size run), the registry (where the
// candidates live) and the overlay (how a deploy reaches the hosts; the
// deploy mount acts on it, the commands only check it). The
// reusable workflows set them as CI_STRATEGY, CI_REGISTRY and CI_OVERLAY from
// their inputs; `--strategy` overrides the first by hand. Pure, so that the
// tests pin the defaults and the labels.
import { UsageError } from '@plexus-ms/lib';

export const STRATEGIES = ['github', 'on-prem', 'hybrid'] as const;
export type Strategy = (typeof STRATEGIES)[number];

export const REGISTRIES = ['ghcr', 'own'] as const;
/** `ghcr`: the candidates live beside the published images; `own`: in the registry pair on the tenant's object storage. */
export type RegistryKind = (typeof REGISTRIES)[number];

export const OVERLAYS = ['none', 'netbird'] as const;
export type Overlay = (typeof OVERLAYS)[number];

export interface Settings {
  strategy: Strategy;
  registry: RegistryKind;
  overlay: Overlay;
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value))
    throw new UsageError(`${name} is "${value}"; it is one of ${allowed.join(', ')}`);
  return value as T;
}

/**
 * The settings from the environment, `flag` (--strategy) before CI_STRATEGY.
 * Without a strategy it is `github`, the forge's runners, where everything
 * runs without a host or a cloud. The registry defaults from the strategy:
 * `ghcr` under `github`, `own` otherwise.
 */
export function settingsOf(env: NodeJS.ProcessEnv = process.env, flag?: string): Settings {
  const strategy = oneOf('the strategy', flag || env.CI_STRATEGY || 'github', STRATEGIES);
  const registry = oneOf('CI_REGISTRY', env.CI_REGISTRY || (strategy === 'github' ? 'ghcr' : 'own'), REGISTRIES);
  const overlay = oneOf('CI_OVERLAY', env.CI_OVERLAY || 'none', OVERLAYS);
  return { strategy, registry, overlay };
}

export type Size = 'small' | 'medium' | 'large';

/** The label a job of a size asks for where the tenant's own runners serve it. */
export const sizeLabel = (size: Size): string => `ci-${size}`;

/**
 * What a job of a size runs on. Under `github` every size is the forge's
 * runner; under `on-prem` every size is a slot of a runner host; under
 * `hybrid` small and medium are slots, and a large job has an instance of its
 * own, launched for it, whose one label is `instance`.
 */
export function runnerOf(strategy: Strategy, size: Size, instance?: string): string {
  if (strategy === 'github') return 'ubuntu-latest';
  if (strategy === 'hybrid' && size === 'large') {
    if (!instance) throw new Error('a large job under hybrid needs its instance’s label');
    return instance;
  }
  return sizeLabel(size);
}
