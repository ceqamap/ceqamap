import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { AwsClient } from "aws4fetch";

/**
 * Where pipeline state and published data live.
 *
 * Production uses a Cloudflare R2 bucket through its S3-compatible API. Local
 * development and tests use a plain directory with the same layout, so you
 * can run the whole pipeline on a laptop and serve the result with `pnpm dev`.
 *
 * Bucket layout:
 *   state/docs/YYYY-MM.ndjson.gz   normalized documents, one partition per received month
 *   state/raw/YYYY-MM.csv.gz       verbatim CEQAnet CSV, for reprocessing
 *   state/manifest.json            content hashes of published project files
 *   data/meta.json                 what the app polls (short cache)
 *   data/tiles/projects-<id>.pmtiles  immutable tilesets
 *   data/projects/<sch>.json       project details
 */

export interface PutOptions {
  contentType: string;
  cacheControl?: string;
  contentEncoding?: string;
}

export interface Storage {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array | string, opts: PutOptions): Promise<void>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export class LocalStorage implements Storage {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async get(key: string) {
    try {
      return new Uint8Array(await readFile(join(this.root, key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async put(key: string, body: Uint8Array | string) {
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async list(prefix: string) {
    const base = join(this.root, prefix);
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else out.push(relative(this.root, p).split('\\').join('/'));
      }
    };
    await walk(base.endsWith('/') ? base : dirname(base + 'x'));
    return out.filter((k) => k.startsWith(prefix)).sort();
  }

  async delete(key: string) {
    await rm(join(this.root, key), { force: true });
  }
}

export class R2Storage implements Storage {
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(opts: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }) {
    this.client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: 's3',
      region: 'auto',
      retries: 5,
    });
    this.base = `https://${opts.accountId}.r2.cloudflarestorage.com/${opts.bucket}`;
  }

  private url(key: string) {
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async get(key: string) {
    const res = await this.client.fetch(this.url(key));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 GET ${key} failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async put(key: string, body: Uint8Array | string, opts: PutOptions) {
    const headers: Record<string, string> = { 'Content-Type': opts.contentType };
    if (opts.cacheControl) headers['Cache-Control'] = opts.cacheControl;
    if (opts.contentEncoding) headers['Content-Encoding'] = opts.contentEncoding;
    const res = await this.client.fetch(this.url(key), { method: 'PUT', body, headers });
    if (!res.ok) throw new Error(`R2 PUT ${key} failed: ${res.status} ${await res.text()}`);
  }

  async list(prefix: string) {
    const keys: string[] = [];
    let token: string | null = null;
    do {
      const q = new URLSearchParams({ 'list-type': '2', prefix });
      if (token) q.set('continuation-token', token);
      const res = await this.client.fetch(`${this.base}?${q}`);
      if (!res.ok) throw new Error(`R2 LIST ${prefix} failed: ${res.status}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(decodeXml(m[1]));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? null)
        : null;
    } while (token);
    return keys.sort();
  }

  async delete(key: string) {
    const res = await this.client.fetch(this.url(key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key} failed: ${res.status}`);
  }
}

function decodeXml(s: string) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Pick storage from the environment: R2 when credentials exist, else ./.data. */
export function storageFromEnv(env = process.env): Storage {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET) {
    return new R2Storage({
      accountId: R2_ACCOUNT_ID,
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      bucket: R2_BUCKET,
    });
  }
  return new LocalStorage(env.LOCAL_DATA_DIR ?? new URL('../../../.data', import.meta.url).pathname);
}

/** Run async work over items with bounded concurrency. */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}
