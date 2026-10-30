import { createHash, randomBytes } from 'crypto';
import type { PrismaClient } from '../generated/prisma/client';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * OAuth state for board's MCP authorization server: registered clients,
 * authorizations in flight, and one-time codes.
 *
 * There are two implementations of each and they are not two backends, exactly
 * as with `mcp-grant.repository.ts`. The Prisma ones are the only path a
 * deployment takes — `BOARD_MCP_ENABLED=true` requires `IDENTITY_SOURCE=db` at
 * boot, and `mcp.module.ts` throws a second time if that were ever bypassed. The
 * in-memory ones are a **test seam and never a production path**: the provider's
 * own specs drive consent and code exchange with no database in sight.
 *
 * Everything is async on both sides. Postgres cannot answer synchronously, and a
 * seam whose shape differs from the store would let every test above it prove
 * something about a thing that never runs.
 *
 * Two values are secrets and neither is stored: the initiator secret held by the
 * browser that started a flow (#554) and the authorization code itself. Both are
 * kept as sha256 hex, in BOTH implementations. That last part is not symmetry for
 * its own sake — `consent.controller.ts` compares the initiator through one code
 * path shared by both, and `secretsMatch` checks length before it reaches
 * `timingSafeEqual`, so a seam holding plaintext beside a store holding a hash
 * would refuse every fixture-mode consent while looking like a passing store.
 */

/** How long an authorization may sit unanswered before it is dead. */
export const PENDING_TTL_MS = 10 * 60_000;

/** How long a one-time code may be redeemed for. */
export const CODE_TTL_MS = 5 * 60_000;

const MAX_ENTRIES = 1000;
const MAX_CLIENTS = 1000;

/** Injection tokens, so the module graph decides which implementation runs. */
export const MCP_CLIENTS_STORE = 'MCP_CLIENTS_STORE';
export const MCP_PENDING_STORE = 'MCP_PENDING_STORE';
export const MCP_CODE_STORE = 'MCP_CODE_STORE';

/** How a secret is held at rest: sha256 hex, never the value. */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface PendingAuth {
  id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  /** OAuth2 requested scopes (space-delimited board:*), if the client asked. */
  requestedScopes?: string[];
  /**
   * The browser that started this flow (#554). The consent screen refuses a
   * request whose initiator it cannot match, which is what closes the
   * pre-seeded-link attack: the victim's browser never held the attacker's
   * secret.
   *
   * ON THE WAY IN this is the secret itself, as `authorize` minted it into the
   * cookie. ON THE WAY OUT it is the sha256 hex of that secret, because that is
   * what the store holds — so the consent screen hashes the browser's cookie
   * before comparing, and both sides of the comparison are 64 hex characters.
   *
   * OPTIONAL, and it has to stay that way. `create()` takes
   * `Omit<PendingAuth, 'id'>`, and `mcp-signout-revocation.integration.spec.ts`
   * builds these records from three fields — a required field here is a compile
   * error there. A record carrying no initiator is treated as unbindable and
   * refused rather than admitted, so the optionality is a typing accommodation
   * and not a hole in the control.
   */
  initiator?: string;
}

export interface CodeRecord {
  /** sha256 hex of the code. The code itself is handed out once and not kept. */
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  sub: string;
  email: string;
}

/**
 * The SDK's registry interface, narrowed so `registerClient` is required.
 *
 * It is optional there because a server may refuse dynamic client registration
 * — and the SDK mounts `/register` only when the method exists. Board's whole
 * client onboarding is DCR, so a registry that could not register is not one of
 * ours, and saying so in the type keeps every call site off `?.`.
 */
export interface McpClientsStore extends OAuthRegisteredClientsStore {
  registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull>;
}

export interface McpPendingAuthStore {
  create(p: Omit<PendingAuth, 'id'>): Promise<string>;
  /** One-time: the record is gone whether or not it was still live. */
  consume(id: string): Promise<PendingAuth | null>;
  /** Non-consuming read, used to surface requested scopes on the consent GET. */
  peek(id: string): Promise<PendingAuth | null>;
}

export interface McpCodeStore {
  /** Returns the plaintext code, the only time it exists outside the client. */
  create(r: Omit<CodeRecord, 'codeHash'>): Promise<string>;
  /** PKCE lookup for the SDK's token handler — must not consume the code. */
  peekChallenge(code: string): Promise<string | null>;
  consume(code: string): Promise<CodeRecord | null>;
}

function opaqueId(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Drop entries older than `ttl` (lazy sweep), then bound the map size by
 * evicting oldest-first (Map keeps insertion order). Keeps an abandoned-flow
 * flood from growing memory without bound over uptime. The Prisma stores need no
 * equivalent: `pruneExpired` on the grant repository deletes both tables by age.
 */
function sweep(map: Map<string, { at: number }>, ttl: number, now: number): void {
  for (const [k, v] of map) {
    if (now - v.at > ttl) map.delete(k);
  }
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * A registration as board keeps it: public, with nothing secret to store.
 *
 * The SDK mints 32 random bytes for every client that does not register with
 * `token_endpoint_auth_method: 'none'`, and compares that secret in plaintext at
 * `clientAuth.js`, so hashing it would lock out every confidential client. Board
 * takes the other exit and issues none. MCP clients are desktop applications;
 * OAuth 2.1 requires PKCE of them precisely because such a client cannot keep a
 * secret, and board's flow already runs PKCE end to end. Handing one a secret and
 * then storing it is theatre with a database row.
 *
 * The return value IS the registration response — the SDK reassigns
 * `clientInfo = await clientsStore.registerClient(clientInfo)` and sends it — so
 * the client is told it is public, and the SDK's `if (client.client_secret)`
 * branch never runs for it afterwards.
 */
function asPublicClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
  const { client_secret: _secret, client_secret_expires_at: _expiry, ...rest } = client;
  return { ...rest, token_endpoint_auth_method: 'none' };
}

export class InMemoryClientsStore implements McpClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    // Bound the client registry: DCR is rate-limited by the SDK, but nothing
    // else evicts. Oldest-first once past the cap.
    while (this.clients.size >= MAX_CLIENTS) {
      const oldest = this.clients.keys().next().value;
      if (oldest === undefined) break;
      this.clients.delete(oldest);
    }
    const stored = asPublicClient(client);
    this.clients.set(stored.client_id, stored);
    return stored;
  }
}

export class PendingAuthStore implements McpPendingAuthStore {
  private readonly pending = new Map<string, { p: PendingAuth; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async create(p: Omit<PendingAuth, 'id'>): Promise<string> {
    sweep(this.pending, PENDING_TTL_MS, this.now());
    const id = opaqueId();
    // Hashed here, exactly as the Prisma store hashes it, because the consent
    // screen's comparison path is shared by both.
    const initiator = p.initiator === undefined ? undefined : hashSecret(p.initiator);
    this.pending.set(id, { p: { ...p, id, initiator }, at: this.now() });
    return id;
  }

  async consume(id: string): Promise<PendingAuth | null> {
    const entry = this.pending.get(id);
    if (!entry) return null;
    this.pending.delete(id);
    return this.now() - entry.at > PENDING_TTL_MS ? null : entry.p;
  }

  async peek(id: string): Promise<PendingAuth | null> {
    const entry = this.pending.get(id);
    if (!entry) return null;
    return this.now() - entry.at > PENDING_TTL_MS ? null : entry.p;
  }
}

export class CodeStore implements McpCodeStore {
  private readonly codes = new Map<string, { r: CodeRecord; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async create(r: Omit<CodeRecord, 'codeHash'>): Promise<string> {
    sweep(this.codes, CODE_TTL_MS, this.now());
    const code = opaqueId();
    const codeHash = hashSecret(code);
    this.codes.set(codeHash, { r: { ...r, codeHash }, at: this.now() });
    return code;
  }

  async peekChallenge(code: string): Promise<string | null> {
    const entry = this.codes.get(hashSecret(code));
    if (!entry || this.now() - entry.at > CODE_TTL_MS) return null;
    return entry.r.codeChallenge;
  }

  async consume(code: string): Promise<CodeRecord | null> {
    const codeHash = hashSecret(code);
    const entry = this.codes.get(codeHash);
    if (!entry) return null;
    this.codes.delete(codeHash);
    return this.now() - entry.at > CODE_TTL_MS ? null : entry.r;
  }
}

/** Postgres-backed registry. The only implementation a deployment runs. */
export class PrismaClientsStore implements McpClientsStore {
  constructor(private readonly prisma: PrismaClient) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const row = await this.prisma.mcpClient.findUnique({ where: { clientId } });
    return row ? (row.metadata as unknown as OAuthClientInformationFull) : undefined;
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    const stored = asPublicClient(client);
    // Upsert rather than create: dynamic client registration is open, and a
    // client re-registering under an id it already holds should not fail the
    // handshake on a unique-constraint violation.
    await this.prisma.mcpClient.upsert({
      where: { clientId: stored.client_id },
      create: {
        clientId: stored.client_id,
        clientName: stored.client_name ?? null,
        redirectUris: stored.redirect_uris ?? [],
        metadata: stored as never,
      },
      update: {
        clientName: stored.client_name ?? null,
        redirectUris: stored.redirect_uris ?? [],
        metadata: stored as never,
      },
    });
    return stored;
  }
}

export class PrismaPendingAuthStore implements McpPendingAuthStore {
  constructor(
    private readonly prisma: PrismaClient,
    // The store's own clock rather than the database's, so `createdAt` and the
    // TTL comparison read the same time source and a test can age a record.
    private readonly now: () => number = Date.now,
  ) {}

  async create(p: Omit<PendingAuth, 'id'>): Promise<string> {
    const id = opaqueId();
    await this.prisma.mcpPendingAuth.create({
      data: {
        id,
        clientId: p.clientId,
        redirectUri: p.redirectUri,
        codeChallenge: p.codeChallenge,
        state: p.state ?? null,
        requestedScopes: p.requestedScopes ?? [],
        initiatorHash: p.initiator === undefined ? null : hashSecret(p.initiator),
        createdAt: new Date(this.now()),
      },
    });
    return id;
  }

  async consume(id: string): Promise<PendingAuth | null> {
    const row = await this.prisma.mcpPendingAuth.findUnique({ where: { id } });
    if (!row) return null;
    // `deleteMany` and its count, not `delete`: two callers arriving together
    // must not both be handed the record, and the one whose delete removed
    // nothing is the one that lost.
    const removed = await this.prisma.mcpPendingAuth.deleteMany({ where: { id } });
    if (removed.count === 0) return null;
    return this.live(row);
  }

  async peek(id: string): Promise<PendingAuth | null> {
    const row = await this.prisma.mcpPendingAuth.findUnique({ where: { id } });
    return row ? this.live(row) : null;
  }

  /** A row past `PENDING_TTL_MS` is not a record, whatever the table still holds. */
  private live(row: {
    id: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state: string | null;
    requestedScopes: string[];
    initiatorHash: string | null;
    createdAt: Date;
  }): PendingAuth | null {
    if (this.now() - row.createdAt.getTime() > PENDING_TTL_MS) return null;
    return {
      id: row.id,
      clientId: row.clientId,
      redirectUri: row.redirectUri,
      codeChallenge: row.codeChallenge,
      ...(row.state === null ? {} : { state: row.state }),
      requestedScopes: row.requestedScopes,
      // Null stays undefined, so `secretsMatch(undefined, …)` refuses at its
      // first line and a record carrying no initiator is unanswerable rather
      // than answerable by everybody.
      ...(row.initiatorHash === null ? {} : { initiator: row.initiatorHash }),
    };
  }
}

export class PrismaCodeStore implements McpCodeStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => number = Date.now,
  ) {}

  async create(r: Omit<CodeRecord, 'codeHash'>): Promise<string> {
    const code = opaqueId();
    await this.prisma.mcpAuthCode.create({
      data: {
        codeHash: hashSecret(code),
        clientId: r.clientId,
        redirectUri: r.redirectUri,
        codeChallenge: r.codeChallenge,
        scopes: r.scopes,
        sub: r.sub,
        email: r.email,
        createdAt: new Date(this.now()),
      },
    });
    return code;
  }

  async peekChallenge(code: string): Promise<string | null> {
    const row = await this.prisma.mcpAuthCode.findUnique({ where: { codeHash: hashSecret(code) } });
    if (!row || this.expired(row.createdAt)) return null;
    return row.codeChallenge;
  }

  async consume(code: string): Promise<CodeRecord | null> {
    const codeHash = hashSecret(code);
    const row = await this.prisma.mcpAuthCode.findUnique({ where: { codeHash } });
    if (!row) return null;
    const removed = await this.prisma.mcpAuthCode.deleteMany({ where: { codeHash } });
    if (removed.count === 0) return null;
    if (this.expired(row.createdAt)) return null;
    return {
      codeHash: row.codeHash,
      clientId: row.clientId,
      redirectUri: row.redirectUri,
      codeChallenge: row.codeChallenge,
      scopes: row.scopes,
      sub: row.sub,
      email: row.email,
    };
  }

  /**
   * Read on every lookup, not merely written. A code that leaked and was never
   * redeemed has to stop being redeemable at `CODE_TTL_MS`; a store that
   * persisted `createdAt` and never consulted it would keep it redeemable
   * forever, which is how a five-minute credential quietly becomes permanent.
   */
  private expired(createdAt: Date): boolean {
    return this.now() - createdAt.getTime() > CODE_TTL_MS;
  }
}
