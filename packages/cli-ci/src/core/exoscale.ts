// The cloud's instances, through the exo CLI's raw API calls (`exo x <operation>`): one
// operation each, so that a role holds exactly the operations the daily work
// names (§ 8 PLX-Delivery), where the CLI's own commands end in reads
// the roles have no business holding. Reads go through ctx.read, effects
// through ctx.effect, so a dry run lists them and performs none. The key is
// in the environment (EXOSCALE_API_KEY, EXOSCALE_API_SECRET), never on argv.
import type { Context } from '@plexus-ms/lib';
import { run } from '@plexus-ms/lib';

export interface Instance {
  id: string;
  name: string;
  state: string;
  publicIp?: string;
  createdAt: string;
  labels: Record<string, string>;
}

export interface Operation {
  id: string;
  state: string;
  /** The created instance's id, on create-instance. */
  reference?: string;
}

/** The request of create-instance, the fields this tooling uses. */
export interface CreateInstance {
  name: string;
  templateId: string;
  instanceTypeId: string;
  securityGroupId: string;
  sshKey: string;
  diskSize: number;
  userDataBase64: string;
  labels: Record<string, string>;
}

export class Exo {
  readonly ctx: Context;
  readonly zone: string;
  readonly server: string;

  constructor(ctx: Context, zone: string) {
    this.ctx = ctx;
    this.zone = zone;
    this.server = `https://api-${zone}.exoscale.com/v2`;
  }

  private args(operation: string, rest: string[] = []): string[] {
    return ['x', operation, ...rest, '--server', this.server, '--raw'];
  }

  private async read(operation: string, rest: string[] = []): Promise<unknown> {
    return JSON.parse(await this.ctx.read('exo', this.args(operation, rest)));
  }

  /** An effect with a result: the operation the API answers with, or undefined under --dry-run. */
  private async effect(operation: string, rest: string[] = [], input?: string): Promise<Operation | undefined> {
    const out = await this.ctx.effect(run('exo', this.args(operation, rest), input === undefined ? {} : { input }));
    if (out === undefined) return undefined;
    const data = JSON.parse(out) as { id: string; state: string; reference?: { id?: string } };
    return { id: data.id, state: data.state, reference: data.reference?.id };
  }

  async listInstances(): Promise<Instance[]> {
    const data = (await this.read('list-instances')) as { instances?: RawInstance[] };
    return (data.instances ?? []).map(instanceOf);
  }

  async instance(id: string): Promise<Instance | undefined> {
    return (await this.listInstances()).find((i) => i.id === id);
  }

  async templateId(name: string): Promise<string> {
    const data = (await this.read('list-templates')) as {
      templates?: { id: string; name: string; visibility: string }[];
    };
    const t = (data.templates ?? []).find((t) => t.name === name && t.visibility === 'public');
    if (!t) throw new Error(`no public template named "${name}" in ${this.zone}`);
    return t.id;
  }

  async instanceTypeId(type: string): Promise<string> {
    const data = (await this.read('list-instance-types')) as {
      'instance-types'?: { id: string; family: string; size: string }[];
    };
    const t = (data['instance-types'] ?? []).find((t) => `${t.family}.${t.size}` === type);
    if (!t) throw new Error(`no instance type "${type}" in ${this.zone}`);
    return t.id;
  }

  async securityGroupId(name: string): Promise<string> {
    const data = (await this.read('list-security-groups')) as { 'security-groups'?: { id: string; name: string }[] };
    const g = (data['security-groups'] ?? []).find((g) => g.name === name);
    if (!g) throw new Error(`no security group "${name}"; it is created once, at setup`);
    return g.id;
  }

  createInstance(request: CreateInstance): Promise<Operation | undefined> {
    const body = {
      name: request.name,
      template: { id: request.templateId },
      'instance-type': { id: request.instanceTypeId },
      'disk-size': request.diskSize,
      'security-groups': [{ id: request.securityGroupId }],
      'ssh-key': { name: request.sshKey },
      'public-ip-assignment': 'inet4',
      'user-data': request.userDataBase64,
      labels: request.labels,
    };
    return this.effect('create-instance', [], JSON.stringify(body));
  }

  /**
   * Poll an operation to its end, for three minutes: a create completes
   * within seconds as a rule and has taken more than one minute under load.
   */
  async waitOperation(id: string, attempts = 90): Promise<string> {
    let state = 'pending';
    for (let i = 0; i < attempts && state === 'pending'; i++) {
      if (i > 0) await sleep(2000);
      state = ((await this.read('get-operation', [id])) as { state: string }).state;
    }
    return state;
  }

  deleteInstance(id: string): Promise<Operation | undefined> {
    return this.effect('delete-instance', [id]);
  }

  stopInstance(id: string): Promise<Operation | undefined> {
    return this.effect('stop-instance', [id]);
  }

  /** Rename and relabel: the whole label map is sent, since the API replaces it. */
  updateInstance(id: string, name: string, labels: Record<string, string>): Promise<Operation | undefined> {
    return this.effect('update-instance', [id], JSON.stringify({ name, labels }));
  }
}

interface RawInstance {
  id: string;
  name: string;
  state: string;
  'public-ip'?: string;
  'created-at': string;
  labels?: Record<string, string>;
}

export function instanceOf(raw: RawInstance): Instance {
  return {
    id: raw.id,
    name: raw.name,
    state: raw.state,
    publicIp: raw['public-ip'],
    createdAt: raw['created-at'],
    labels: raw.labels ?? {},
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
