// deploy: launch a released artifact into an execution environment (§ 6
// PLX-Delivery). A stateless procedure, not a system:
//
//   render compose.yaml from the invoking checkout, pinning the image ref (§§ 2 and 3 PLX-App)
//   → stage it on the host → docker compose pull → compose run --rm migrate (if declared),
//     both against the staged file → swap the file into place → docker compose up -d
//     → poll the readiness path → on failure: restore the previous file, up -d (no pull), fail
//
// Run from a checkout of the app's SOURCE repo (§ 2 PLX-App): an app repo's
// CI, or the platform repo for third-party software the tenant merely
// operates. The run shape, apps/<app>/docker/compose.yaml (or
// apps/<app>/compose.yaml), is read from there, rendered with the concrete
// image ref in place of ${PLEXUS_DEPLOYMENT_IMAGE}, staged on the host, and
// swapped into place only once pull and migrate have succeeded, so the compose
// file on the host always names the image it serves, and a failed deploy
// leaves the host exactly as it was. Three files in the app dir, one writer
// each (PLX-Secrets): the configure playbook owns .env and .env.secret, this
// verb owns compose.yaml. Compose reads .env implicitly, so every command here
// and by a human is a bare `docker compose …` in the app dir.
//
// Every command sent to the host is one line of shell over ssh, carried in
// the plan and printed verbatim by the dry run, so a stranded operator copies
// the lines; the host needs bash, docker and curl and nothing else. The ssh
// calls share one connection (ControlMaster), opened by the first and closed
// at the end. Reality is the source of truth: the previous image is read from
// the running container, never from a file this verb owns.
//
// Migrations are an artifact capability, not a host toolchain: an app that
// has them declares a one-shot `migrate` service (same image, migrate command,
// `profiles: ["migrate"]` so plain `up` never starts it). The `web` service is
// the app service by convention; it is the one the live image and the
// readiness path are read from, every other service rides along with pull
// and up. A third-party app pins its image inside compose.yaml and passes no
// image ref; the file is then placed as is.
//
//   plx deploy deploy@1.2.3.4 plexus website --image ghcr.io/org/website:<sha>
//   plx -n deploy deploy@host plexus beszel          # the ssh lines it would run
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from './context.ts';
import { ExecError } from './io.ts';
import { run } from './plan.ts';
import { UsageError } from './train.ts';

export interface DeployOptions {
  /** ssh target, `deploy@host`. */
  host: string;
  tenant: string;
  app: string;
  /** The image ref to pin; empty or absent for a third-party app whose file pins its own. */
  image?: string;
  /** The readiness URL polled on the host; resolved there from .env and the `plexus.healthz` label when empty. */
  healthUrl?: string;
  /** Poll attempts, two seconds apart. */
  retries?: number;
  /** The app dir on the host; default /opt/stacks/<tenant>/<app>, the configure playbook's layout. */
  appDir?: string;
  /** The app's dir in the checkout; default apps/<app>. */
  source?: string;
  /** The checkout; default the cwd. */
  dir?: string;
}

export interface Deploy {
  host: string;
  appDir: string;
  /** The compose file read, relative to the checkout. */
  compose: string;
  image?: string;
  /** The image that was live before, from the running container. */
  previous?: string;
  /** The image live at the end, healthy or rolled back to. */
  live?: string;
  healthy: boolean;
  rolledBack: boolean;
}

const PLACEHOLDER = /\$\{PLEXUS_DEPLOYMENT_IMAGE(:[^}]*)?\}/g;
const INCOMING = '.incoming';

/**
 * Pin the image ref in place of the ${PLEXUS_DEPLOYMENT_IMAGE} placeholder
 * (§ 3 PLX-App), with or without a `:?message` suffix: one literal
 * substitution, nothing else touched. A first-party file without the
 * placeholder would silently ignore the ref, and a third-party file with one
 * would ship an empty image; both are errors here, never on the host.
 */
export function renderCompose(text: string, image: string | undefined, path: string): string {
  const has = PLACEHOLDER.test(text);
  PLACEHOLDER.lastIndex = 0;
  if (image) {
    if (!has)
      throw new UsageError(
        `${path} does not reference \${PLEXUS_DEPLOYMENT_IMAGE}; an image ref was given but nothing would use it (§ 3 PLX-App)`,
      );
    return text.replace(PLACEHOLDER, image);
  }
  if (has) throw new UsageError(`${path} references \${PLEXUS_DEPLOYMENT_IMAGE} but no image ref was given`);
  return text;
}

/** Single-quote a word for a remote shell. */
export const q = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

/** The ssh calls of one deploy, sharing a connection; each command is one line of shell. */
class Remote {
  private readonly socket = join(tmpdir(), `plx-deploy-${randomBytes(4).toString('hex')}.sock`);

  private readonly ctx: Context;
  readonly host: string;

  constructor(ctx: Context, host: string) {
    this.ctx = ctx;
    this.host = host;
  }

  private args(command: string): string[] {
    return [
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${this.socket}`,
      '-o',
      'ControlPersist=60',
      '-o',
      'StrictHostKeyChecking=accept-new',
      this.host,
      '--',
      command,
    ];
  }

  /** An effect on the host: narrated, performed unless --dry-run. */
  exec(command: string, input?: string): Promise<void> {
    return this.ctx.apply([run('ssh', this.args(command), input === undefined ? {} : { input })]);
  }

  /**
   * A read from the host: its output, or undefined under --dry-run, where no
   * host is reached. A read that is a step of the procedure (`show`) is
   * printed by the dry run like an effect, so the operator copies it too.
   */
  async read(command: string, show = false): Promise<string | undefined> {
    if (this.ctx.dryRun) {
      this.ctx.say(`${show ? '[dry-run] $' : '?'} ssh ${this.host} -- ${q(command)}`, show ? 0 : 1);
      return undefined;
    }
    return (await this.ctx.read('ssh', this.args(command))).trimEnd();
  }

  /** A check on the host: whether the command succeeds, or undefined under --dry-run. */
  async test(command: string, show = false): Promise<boolean | undefined> {
    try {
      return (await this.read(command, show)) === undefined ? undefined : true;
    } catch (error) {
      if (error instanceof ExecError) return false;
      throw error;
    }
  }

  /** Close the shared connection; nothing to close when no call was made. */
  close(): Promise<void> {
    return this.ctx.apply([run('ssh', ['-o', `ControlPath=${this.socket}`, '-O', 'exit', this.host])]);
  }
}

/** Deploy from the checkout at `dir`: read, render, then the host-side steps in order. */
export async function deploy(ctx: Context, options: DeployOptions): Promise<Deploy> {
  const { host, tenant, app } = options;
  const dir = options.dir ?? '.';
  const image = options.image || undefined;
  const appDir = options.appDir || `/opt/stacks/${tenant}/${app}`;
  const source = options.source || `apps/${app}`;
  const retries = options.retries ?? 30;

  // The run shape, from the invoking checkout (§ 2 PLX-App).
  let compose: string | undefined;
  let text = '';
  for (const candidate of [`${source}/docker/compose.yaml`, `${source}/compose.yaml`]) {
    try {
      text = await ctx.readFile(join(dir, candidate));
      compose = candidate;
      break;
    } catch {}
  }
  if (compose === undefined)
    throw new UsageError(`no compose.yaml under ${source}; run from the app's source repo (§ 2 PLX-App)`);
  const rendered = renderCompose(text, image, compose);

  ctx.say(`→ deploying ${image ?? '<image pinned in compose.yaml>'}`);
  ctx.say(`  host:    ${host}`);
  ctx.say(`  dir:     ${appDir}`);
  ctx.say(`  compose: ${compose}`);
  ctx.say(`  health:  ${options.healthUrl || '<resolved on host>'}`);

  const remote = new Remote(ctx, host);
  const D = q(appDir);
  // The staged compose file, read in place: --project-directory keeps .env and
  // relative paths resolving against the app dir, so pull and migrate run
  // against the new run shape while the host keeps serving from the old one.
  const dc = `cd ${D} && docker compose`;
  const dci = `${dc} --project-directory . -f ${INCOMING}/compose.yaml`;
  const liveImage = `${dc} ps -q web 2>/dev/null | head -1 | xargs -r docker inspect --format '{{.Config.Image}}' 2>/dev/null || true`;

  const result: Deploy = { host, appDir, compose, image, healthy: false, rolledBack: false };
  let staged = false;
  try {
    // Stage into a verb-owned dir inside the app dir; only the file is written,
    // never the dir's own mode, which the playbook set. Nothing the host runs
    // from is touched until the checks below have passed.
    await remote.exec(
      `rm -rf ${D}/${INCOMING} && mkdir -p ${D}/${INCOMING} && cat > ${D}/${INCOMING}/compose.yaml`,
      rendered,
    );
    staged = true;

    result.previous = (await remote.read(liveImage)) || undefined;
    ctx.say(`  previous: ${result.previous ?? (ctx.dryRun ? '<read on host>' : '<none>')}`);

    // Pull → migrate (idempotent; runs only if compose.yaml declares it), both
    // against the STAGED run shape: a failure here leaves the host exactly as
    // it was. Every non-profiled service is pulled, not just `web`.
    await remote.exec(`${dci} pull`);
    // `compose run` targets the service regardless of its profile; the --profile
    // flag is only needed for the existence check, since `config --services`
    // hides profiled services by default. stdin from /dev/null: `compose run`
    // is interactive by default and would wait on a terminal that is not there.
    const migrate = await remote.test(`${dci} --profile migrate config --services 2>/dev/null | grep -qx migrate`);
    if (migrate === undefined) ctx.say('  (if compose.yaml declares a migrate service:)');
    if (migrate !== false) await remote.exec(`${dci} run --rm migrate </dev/null`);

    // Swap the run shape into place; the previous one is kept for rollback
    // until this run ends.
    const hadPrev = await remote.test(`test -f ${D}/compose.yaml`);
    if (hadPrev !== false) await remote.exec(`cd ${D} && cp -p compose.yaml ${INCOMING}/compose.yaml.prev`);
    await remote.exec(`cd ${D} && mv ${INCOMING}/compose.yaml compose.yaml`);
    // No pull here: the new image was pulled above, the previous one is in the
    // host's cache; a rollback must never depend on the registry answering.
    await remote.exec(`${dc} up -d`);

    // Readiness path: /healthz by contract (§ 5 PLX-App); a third-party image
    // that cannot serve it declares its own via the `plexus.healthz` label,
    // read from the running container, reality, not a parse of the compose
    // file. Each attempt is bounded, so a container that accepts connections
    // but never answers cannot hang the deploy.
    const url = options.healthUrl || (await resolveHealthUrl(remote, D, dc, ctx));
    const poll = `cd ${D} && for _ in $(seq 1 ${retries}); do curl -fsS --max-time 5 -o /dev/null ${q(url)} && exit 0; sleep 2; done; exit 1`;
    const started = Date.now();
    const healthy = await remote.test(poll, true);
    if (healthy !== false) {
      result.live = (await remote.read(liveImage)) || image;
      result.healthy = true;
      if (ctx.dryRun) ctx.say('  (on failure: restore the previous compose.yaml, up -d, poll again)');
      else ctx.done(`${result.live ?? 'the app'} is live and healthy`);
      return result;
    }

    ctx.say(`✗ healthcheck failed after ${Math.round((Date.now() - started) / 1000)}s; last lines from the app:`);
    const logs = await remote.read(`${dc} logs --no-color --tail 50 web 2>&1 || true`);
    if (logs) ctx.say(logs.replace(/^/gm, '    '));

    // Rollback: the previous compose file, image pinned, so it is the
    // combination that was actually serving. There is something to go back to
    // when the file changed with a container running; a first deploy, or a
    // re-deploy of the very same run shape, has no previous state and fails
    // loudly instead.
    const differs = hadPrev && (await remote.test(`cd ${D} && ! cmp -s compose.yaml ${INCOMING}/compose.yaml.prev`));
    if (!differs) {
      ctx.done(
        'nothing to roll back to (first deploy, or the same run shape re-deployed); manual intervention needed',
        false,
      );
      return result;
    }
    await remote.exec(`cd ${D} && cp -p ${INCOMING}/compose.yaml.prev compose.yaml`);
    ctx.say(`↩ rolling back to ${result.previous ?? 'the previous compose.yaml'}`);
    await remote.exec(`${dc} up -d`);
    result.rolledBack = true;
    if (await remote.test(poll)) {
      result.live = result.previous;
      ctx.done(`rolled back to ${result.previous ?? 'the previous compose.yaml'}`);
    } else {
      ctx.done('rollback also unhealthy; manual intervention needed', false);
    }
    return result;
  } finally {
    // The staged run shape and the rollback copy are gone on exit, whatever
    // happened; the shared connection with them.
    if (staged) await remote.exec(`rm -rf ${D}/${INCOMING}`).catch(() => undefined);
    await remote.close().catch(() => undefined);
  }
}

async function resolveHealthUrl(remote: Remote, D: string, dc: string, ctx: Context): Promise<string> {
  const port = await remote.read(`sed -n 's/^PLEXUS_LOOPBACK_PORT=//p' ${D}/.env 2>/dev/null | tail -1`);
  const path = await remote.read(
    `${dc} ps -q web 2>/dev/null | head -1 | xargs -r docker inspect --format '{{ index .Config.Labels "plexus.healthz" }}' 2>/dev/null || true`,
  );
  const url = ctx.dryRun
    ? 'http://127.0.0.1:${PLEXUS_LOOPBACK_PORT:-3000}${plexus.healthz:-/healthz}'
    : `http://127.0.0.1:${port || '3000'}${path || '/healthz'}`;
  ctx.say(`  health:   ${url}`);
  return url;
}
