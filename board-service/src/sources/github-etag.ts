import { Logger } from '@nestjs/common';
import type { Octokit } from '@octokit/rest';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

const pack = promisify(gzip);
const unpack = promisify(gunzip);

/** Compressed bytes held across every identity. A person's whole issue ingest
 *  is an estimated 2-3 MiB here, so this holds a few dozen identities' reads. */
export const ETAG_STORE_MAX_BYTES = 64 * 1024 * 1024;
const SUMMARY_EVERY_MS = 60_000;

type Answer = Awaited<ReturnType<Octokit['request']>>;
interface Held { etag: string; blob: Buffer; bytes: number }

/**
 * The answers conditional reads are replayed from (#1007, V3).
 *
 * An entry is the ETag and the whole 200 it came with, compressed, as one
 * object. Nothing stores or drops one half without the other, and a read holds
 * the entry it sent the ETag from, so an eviction while that read is in flight
 * cannot leave it with a 304 and nothing to answer it with.
 *
 * In memory on purpose. A 304 is only worth anything with the body beside it,
 * and these bodies are one person's Github data exactly as Github sent it to
 * them. Keeping that in Postgres is the per-person store V5 has to design, with
 * the filtering that goes with it, and what memory costs instead is one full
 * read per resource after a restart.
 */
export class GithubEtagStore {
  private readonly held = new Map<string, Held>();
  private total = 0;
  private tally = { notModified: 0, full: 0 };
  private summary: ReturnType<typeof setTimeout> | undefined;
  private readonly logger = new Logger('GithubEtags');

  constructor(private readonly maxBytes = ETAG_STORE_MAX_BYTES) {}

  get size(): number { return this.held.size; }
  get bytes(): number { return this.total; }

  /** The entry for `key`, marked as the most recently used. */
  take(key: string): Held | undefined {
    const held = this.held.get(key);
    if (held) { this.held.delete(key); this.held.set(key, held); }
    return held;
  }

  put(key: string, held: Held): void {
    this.drop(key);
    if (held.bytes > this.maxBytes / 16) return;
    this.held.set(key, held);
    this.total += held.bytes;
    for (const oldest of this.held.keys()) {
      if (this.total <= this.maxBytes) break;
      this.drop(oldest);
    }
  }

  drop(key: string): void {
    const held = this.held.get(key);
    if (!held) return;
    this.held.delete(key);
    this.total -= held.bytes;
  }

  /** One line a minute at most, and only in a minute that had reads, so the
   *  log says what the store saved without a line per request. */
  count(notModified: boolean): void {
    if (notModified) this.tally.notModified += 1;
    else this.tally.full += 1;
    if (this.summary) return;
    this.summary = setTimeout(() => this.summarise(), SUMMARY_EVERY_MS);
    this.summary.unref?.();
  }

  private summarise(): void {
    this.summary = undefined;
    const { notModified, full } = this.tally;
    this.tally = { notModified: 0, full: 0 };
    this.logger.log(
      `Github REST reads in the last minute: ${notModified} answered 304 Not Modified, which Github does not count ` +
        `against the quota, and ${full} read in full. ${this.held.size} answers held in ${(this.total / 1048576).toFixed(1)} MiB.`,
    );
  }
}

export const githubEtagStore = new GithubEtagStore();

function plain(data: unknown): boolean {
  if (typeof data === 'string') return true;
  if (data === null || typeof data !== 'object') return false;
  const proto = Object.getPrototypeOf(data);
  return Array.isArray(data) || proto === Object.prototype || proto === null;
}

async function remember(store: GithubEtagStore, key: string, response: Answer): Promise<void> {
  const etag = response.headers.etag;
  // A 200 with no ETag, or a body that is not JSON, retires the old entry: the
  // next read must not be answered from a body older than this one.
  if (response.status !== 200 || typeof etag !== 'string' || !plain(response.data)) {
    store.drop(key);
    return;
  }
  let text: string;
  try {
    text = JSON.stringify({ status: response.status, url: response.url, headers: response.headers, data: response.data });
  } catch {
    // Octokit parses an integer past 2^53 into a BigInt, which JSON cannot
    // write. Such a body is not kept at all, rather than kept with its numbers
    // changed, and the read it came from must still succeed.
    store.drop(key);
    return;
  }
  const blob = await pack(text);
  store.put(key, { etag, blob, bytes: blob.length + key.length });
}

/** The stored 200, parsed afresh so no caller can edit what the next one gets,
 *  with the 304's own headers laid over it the way an HTTP cache updates a
 *  stored response. `content-*` stays the stored body's. */
async function replay(held: Held, fresh: Answer['headers']): Promise<Answer> {
  const stored = JSON.parse((await unpack(held.blob)).toString('utf8')) as Answer;
  const headers = { ...stored.headers };
  for (const [name, value] of Object.entries(fresh)) {
    if (value !== undefined && !name.startsWith('content-')) headers[name] = value;
  }
  return { ...stored, headers };
}

/**
 * Conditional REST reads for one client (#1007, V3).
 *
 * Every GET goes out with the ETag of the last 200 this identity got for the
 * same request, and a 304 is answered with that 200. Github does not count a
 * 304 against the REST quota when the request was correctly authorized, so a
 * read of something unchanged is free. It is still a round trip: latency and
 * the secondary limits are unchanged, and nothing here makes a read happen more
 * often.
 *
 * No caller ever sees the 304. It gets the stored status, headers and body, so
 * `paginate` follows the stored Link header and no reader has to learn that an
 * empty body can mean "the same as before". A 304 with nothing held cannot
 * arise, because the ETag is only sent from an entry this read already holds;
 * a request that set its own `If-None-Match` passes through untouched.
 *
 * The key is `identity`, the same string the quota cooldown bills, then the
 * whole request URL with its query, then the Accept and API-version headers
 * Github varies its answer on. For a signed-in person the identity is their
 * Github user id, never their token, so the entry outlives the eight-hourly
 * token refresh; one person's answer is never sent on another's request.
 */
export function withGithubEtags(client: Octokit, identity: string, store: GithubEtagStore = githubEtagStore): Octokit {
  client.hook.wrap('request', async (request, options) => {
    const headers = options.headers;
    if (
      String(options.method).toUpperCase() !== 'GET' ||
      headers['if-none-match'] !== undefined ||
      headers['if-modified-since'] !== undefined ||
      options.request?.parseSuccessResponseBody === false
    ) {
      return request(options);
    }
    // Called through a local, not on the client: `endpoint.parse` only builds
    // the URL, and a call on the client itself reads as a Github write to the
    // census in `capability/github-write-census.contract.ts`.
    const { endpoint } = client.request;
    const parsed = endpoint.parse(options);
    const key = [identity, parsed.url, parsed.headers.accept ?? '', parsed.headers['x-github-api-version'] ?? ''].join('\n');
    const held = store.take(key);
    // Set on the request's own headers, not on a copy: every hook on this
    // client is handed the same options object, and the quota hook inside
    // this one passes that object on rather than what it was called with.
    // `endpoint.merge` builds it afresh for each request, so nothing else sees it.
    if (held) headers['if-none-match'] = held.etag;
    let response: Answer;
    try {
      response = await request(options);
    } catch (error) {
      const failed = error as { status?: unknown; response?: { headers?: Answer['headers'] } };
      if (!held || failed.status !== 304) throw error;
      store.count(true);
      return replay(held, failed.response?.headers ?? {});
    }
    store.count(false);
    await remember(store, key, response);
    return response;
  });
  return client;
}
