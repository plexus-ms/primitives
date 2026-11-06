// The registry's buckets, through the S3 API itself with curl (§ 8
// PLX-Delivery): whether a bucket exists, creating it, and deleting it whole.
// Plain S3, signed by curl (`--aws-sigv4`), so that the store is any
// S3-compatible one and the job needs no provider's CLI; the runner host's
// own script (ci_runner_host, ci-registry-refresh) speaks to it the same way.
// Path-style addressing, as the registry is configured. The key goes to curl
// as a config on stdin, never on argv.
import { createHash } from 'node:crypto';
import type { Context } from '@plexus-ms/lib';
import { run } from '@plexus-ms/lib';

export interface ObjectStorage {
  /** The S3 endpoint, `https://…`, without a bucket. */
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
}

interface Call {
  method: 'HEAD' | 'GET' | 'PUT' | 'POST' | 'DELETE';
  /** The path below the endpoint, `<bucket>` or `<bucket>/<key>`, and its query. */
  path: string;
  query?: string;
  body?: string;
  headers?: string[];
}

interface Answer {
  status: number;
  body: string;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const md5 = (text: string): string => createHash('md5').update(text).digest('base64');

const unescapeXml = (text: string): string =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
const escapeXml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Every `<tag>…</tag>` of an S3 answer, unescaped. */
export function elements(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((m) => unescapeXml(m[1] ?? ''));
}

/** The uploads a ListMultipartUploads answer names: a key and its upload id each. */
export function uploads(xml: string): { key: string; id: string }[] {
  return [...xml.matchAll(/<Upload>(.*?)<\/Upload>/gs)].flatMap((m) => {
    const key = elements(m[1] ?? '', 'Key')[0];
    const id = elements(m[1] ?? '', 'UploadId')[0];
    return key !== undefined && id !== undefined ? [{ key, id }] : [];
  });
}

/** The body of a DeleteObjects call for up to a thousand keys. */
export function deleteBody(keys: string[]): string {
  return `<Delete><Quiet>true</Quiet>${keys.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join('')}</Delete>`;
}

export class S3 {
  readonly ctx: Context;
  private readonly storage: ObjectStorage;

  constructor(ctx: Context, storage: ObjectStorage) {
    this.ctx = ctx;
    this.storage = storage;
  }

  /** The curl config of one call: the URL, the signature's inputs, the body, and the status after the answer. */
  private config(call: Call): string {
    const { endpoint, region, accessKey, secretKey } = this.storage;
    const url = `${endpoint.replace(/\/$/, '')}/${call.path}${call.query ? `?${call.query}` : ''}`;
    const body = call.body ?? '';
    const lines = [
      `url = ${JSON.stringify(url)}`,
      call.method === 'HEAD' ? 'head' : `request = "${call.method}"`,
      'silent',
      'show-error',
      'max-time = 60',
      `user = ${JSON.stringify(`${accessKey}:${secretKey}`)}`,
      `aws-sigv4 = "aws:amz:${region}:s3"`,
      // Stated, not left to curl: its versions differ in whether they send it, and S3 wants it signed.
      `header = "x-amz-content-sha256: ${sha256(body)}"`,
      ...(call.headers ?? []).map((h) => `header = ${JSON.stringify(h)}`),
      ...(call.body === undefined ? [] : [`data-binary = ${JSON.stringify(body)}`]),
      'write-out = "\\n%{http_code}"',
    ];
    return `${lines.join('\n')}\n`;
  }

  private answer(out: string): Answer {
    const at = out.lastIndexOf('\n');
    return { status: Number(out.slice(at + 1)), body: out.slice(0, at) };
  }

  private async read(call: Call): Promise<Answer> {
    return this.answer(await this.ctx.read('curl', ['-K', '-'], { input: this.config(call) }));
  }

  /** An effect: its answer, or undefined under --dry-run. A status outside 2xx is an error. */
  private async effect(call: Call, what: string): Promise<Answer | undefined> {
    const out = await this.ctx.effect(run('curl', ['-K', '-'], { input: this.config(call) }));
    if (out === undefined) return undefined;
    const answer = this.answer(out);
    if (answer.status < 200 || answer.status >= 300)
      throw new Error(`${what} answered ${answer.status}: ${answer.body.slice(0, 300)}`);
    return answer;
  }

  async bucketExists(bucket: string): Promise<boolean> {
    const { status } = await this.read({ method: 'HEAD', path: bucket });
    if (status === 200) return true;
    if (status === 404) return false;
    throw new Error(`looking up the bucket ${bucket} answered ${status}`);
  }

  async makeBucket(bucket: string): Promise<void> {
    await this.effect({ method: 'PUT', path: bucket }, `creating the bucket ${bucket}`);
  }

  /**
   * Delete a bucket whole: its objects a thousand at a time, the uploads
   * something left unfinished, then the bucket, which S3 refuses while
   * either remains. A dry run lists once and says what would go.
   */
  async removeBucket(bucket: string): Promise<void> {
    let removed = 0;
    for (;;) {
      const page = await this.read({ method: 'GET', path: bucket, query: 'list-type=2&max-keys=1000' });
      if (page.status !== 200) throw new Error(`listing the bucket ${bucket} answered ${page.status}`);
      const keys = elements(page.body, 'Key');
      if (keys.length === 0) break;
      const body = deleteBody(keys);
      const answer = await this.effect(
        { method: 'POST', path: bucket, query: 'delete=', body, headers: [`Content-MD5: ${md5(body)}`] },
        `deleting ${keys.length} objects of ${bucket}`,
      );
      if (answer === undefined) {
        this.ctx.say(`  (the objects of ${bucket}, ${keys.length} in the first listing, then the bucket)`);
        return;
      }
      const failed = elements(answer.body, 'Message');
      if (answer.body.includes('<Error>'))
        throw new Error(`deleting objects of ${bucket} failed: ${failed[0] ?? answer.body.slice(0, 300)}`);
      removed += keys.length;
    }
    const pending = await this.read({ method: 'GET', path: bucket, query: 'uploads=' });
    for (const upload of pending.status === 200 ? uploads(pending.body) : []) {
      const key = upload.key.split('/').map(encodeURIComponent).join('/');
      await this.effect(
        { method: 'DELETE', path: `${bucket}/${key}`, query: `uploadId=${encodeURIComponent(upload.id)}` },
        `aborting an unfinished upload in ${bucket}`,
      );
    }
    await this.effect({ method: 'DELETE', path: bucket }, `deleting the bucket ${bucket}`);
    this.ctx.say(`removed the bucket ${bucket} and its ${removed} object(s)`);
  }
}
