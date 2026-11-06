// GitHub's self-hosted runner API, through curl: one JIT config registers one
// runner for exactly one job (§ 8 PLX-Delivery). The token goes to curl as a
// config on stdin (`-K -`), never on argv, where a process listing would show it.
import type { Context } from '@plexus-ms/lib';
import { run } from '@plexus-ms/lib';

export interface Runner {
  id: number;
  name: string;
  status: string;
  busy: boolean;
}

export class GitHubRunners {
  readonly ctx: Context;
  readonly repo: string;
  private readonly token: string;

  constructor(ctx: Context, repo: string, token: string) {
    this.ctx = ctx;
    this.repo = repo;
    this.token = token;
  }

  private config(method: string, url: string, body?: unknown): string {
    const lines = [
      `url = "${url}"`,
      `request = "${method}"`,
      'fail-with-body',
      'silent',
      'show-error',
      `header = "Authorization: Bearer ${this.token}"`,
      'header = "Accept: application/vnd.github+json"',
      'header = "X-GitHub-Api-Version: 2022-11-28"',
    ];
    if (body !== undefined) lines.push(`data = ${JSON.stringify(JSON.stringify(body))}`);
    return `${lines.join('\n')}\n`;
  }

  private url(path: string): string {
    return `https://api.github.com/repos/${this.repo}/actions/runners${path}`;
  }

  /** Register the runner `name` under the one label `label`; its JIT config, or undefined under --dry-run. */
  async generateJitConfig(
    name: string,
    label: string,
  ): Promise<{ runnerId: number; encodedJitConfig: string } | undefined> {
    const out = await this.ctx.effect(
      run('curl', ['-K', '-'], {
        input: this.config('POST', this.url('/generate-jitconfig'), {
          name,
          runner_group_id: 1,
          labels: [label],
          work_folder: '_work',
        }),
      }),
    );
    if (out === undefined) return undefined;
    const data = JSON.parse(out) as { encoded_jit_config?: string; runner?: { id: number } };
    if (!data.encoded_jit_config || !data.runner)
      throw new Error(`no JIT config in GitHub's answer: ${out.slice(0, 200)}`);
    return { runnerId: data.runner.id, encodedJitConfig: data.encoded_jit_config };
  }

  async deleteRunner(id: number): Promise<void> {
    await this.ctx.effect(run('curl', ['-K', '-'], { input: this.config('DELETE', this.url(`/${id}`)) }));
  }

  async list(): Promise<Runner[]> {
    const out = await this.ctx.read('curl', ['-K', '-'], { input: this.config('GET', this.url('?per_page=100')) });
    const data = JSON.parse(out) as { runners?: Runner[] };
    return (data.runners ?? []).map((r) => ({ id: r.id, name: r.name, status: r.status, busy: r.busy }));
  }

  /** `online`, `offline`, or `unknown` when no runner has the name. */
  async status(name: string): Promise<string> {
    const out = await this.ctx.read('curl', ['-K', '-'], {
      input: this.config('GET', this.url(`?name=${encodeURIComponent(name)}`)),
    });
    const data = JSON.parse(out) as { runners?: Runner[] };
    return data.runners?.find((r) => r.name === name)?.status ?? 'unknown';
  }
}
