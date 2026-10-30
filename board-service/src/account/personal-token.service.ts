import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { grantableScopesFor, ungrantableScopes } from '../auth/scopes';
import {
  PERSONAL_TOKEN_REPOSITORY,
  PersonalTokenRepository,
  PersonalTokenRow,
} from './personal-token.repository';

/**
 * Mints, lists, revokes and verifies personal access tokens (#210). A token is
 * an opaque secret `board_pat_<random>`; only its SHA-256 hash is stored. A
 * token's scopes are a subset of the minter's own authority (a non-admin can
 * never mint an admin token). Verification is a single hashed lookup with
 * revoke/expiry checks — consumed by the auth guard so the normal scope guard
 * gates the token unchanged.
 */

const SECRET_PREFIX = 'board_pat_';
const NAME_MAX = 60;
const EXPIRY_MAX_DAYS = 3650;
const DAY_MS = 86_400_000;

/** Wire-safe view of a token — never carries the secret or its hash. */
export interface PersonalTokenView {
  id: string;
  name: string;
  scopes: string[];
  prefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface MintRequest {
  name: string;
  scopes: string[];
  /** Null = never expires; otherwise a positive integer day count. */
  expiresInDays: number | null;
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

function toView(row: PersonalTokenRow): PersonalTokenView {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    prefix: row.prefix,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class PersonalTokenService {
  constructor(
    @Inject(PERSONAL_TOKEN_REPOSITORY) private readonly repo: PersonalTokenRepository,
  ) {}

  /** Whether the feature is usable (a database is configured). */
  get enabled(): boolean {
    return this.repo.enabled;
  }

  /** The scopes this caller may grant — capped by their own authority (#545:
   *  the one rule, shared with the MCP consent screen). */
  grantableScopes(isAdmin: boolean): string[] {
    return grantableScopesFor(isAdmin);
  }

  async list(ownerEmail: string): Promise<PersonalTokenView[]> {
    const rows = await this.repo.listByOwner(ownerEmail.toLowerCase());
    return rows.map(toView);
  }

  /** `ownerSub` is the minting session's Google subject — the stable identity a
   *  Github credential lookup is allowed to key on (#892). It is a parameter and
   *  not derived from `ownerEmail` because deriving it is exactly the mistake:
   *  an address can be handed to a second person and a subject cannot. */
  async mint(
    ownerEmail: string,
    ownerSub: string | null,
    isAdmin: boolean,
    req: MintRequest,
  ): Promise<{ token: string; record: PersonalTokenView }> {
    // The Tokens sheet prints each of these on its own, under the form
    // (`AccountView.tsx:266`, by way of `readErrorReason` at `api.ts:1857`),
    // so they are written as sentences and not as field rules (#1056).
    const name = (req.name ?? '').trim();
    if (!name) throw new BadRequestException('A token needs a name.');
    if (name.length > NAME_MAX) throw new BadRequestException(`A token name is at most ${NAME_MAX} characters.`);

    const scopes = [...new Set(req.scopes ?? [])];
    if (scopes.length === 0) throw new BadRequestException('Pick at least one scope.');
    const ungrantable = ungrantableScopes(scopes, isAdmin);
    if (ungrantable.length > 0) {
      throw new BadRequestException(`Your account cannot grant ${ungrantable[0]}, so this token cannot carry it.`);
    }

    let expiresAt: Date | null = null;
    if (req.expiresInDays != null) {
      const d = req.expiresInDays;
      if (!Number.isInteger(d) || d < 1 || d > EXPIRY_MAX_DAYS) {
        throw new BadRequestException(`An expiry is 1 to ${EXPIRY_MAX_DAYS} days. Leave it out for a token that does not expire.`);
      }
      expiresAt = new Date(Date.now() + d * DAY_MS);
    }

    const secret = SECRET_PREFIX + randomBytes(32).toString('base64url');
    const row = await this.repo.create({
      ownerEmail: ownerEmail.toLowerCase(),
      ownerSub,
      name,
      scopes,
      tokenHash: sha256hex(secret),
      prefix: secret.slice(0, SECRET_PREFIX.length + 4),
      expiresAt,
    });
    return { token: secret, record: toView(row) };
  }

  /** Revoke one of the owner's tokens; true iff a live row was revoked. */
  revoke(id: string, ownerEmail: string): Promise<boolean> {
    return this.repo.revoke(id, ownerEmail.toLowerCase());
  }

  /**
   * Resolve a `board_pat_` bearer to its owner + scopes, or null when it is not
   * a personal token / is unknown / revoked / expired. Consumed by the auth
   * guard. Bumps last-used best-effort.
   */
  /** `ownerSub` travels with the answer so `JwtAuthGuard` can bind a Github
   *  credential to the identity that minted this token rather than to the
   *  address it happens to carry (#892). Null on a pre-#892 row. */
  async verify(bearer: string): Promise<{ ownerEmail: string; ownerSub: string | null; scopes: string[] } | null> {
    if (!bearer.startsWith(SECRET_PREFIX)) return null;
    const row = await this.repo.findByHash(sha256hex(bearer));
    if (!row || row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
    void this.repo.touchLastUsed(row.id);
    return { ownerEmail: row.ownerEmail, ownerSub: row.ownerSub ?? null, scopes: row.scopes };
  }

  /** Cheap check the guard uses to route a bearer without a DB hit. */
  static looksLikePersonalToken(bearer: string): boolean {
    return bearer.startsWith(SECRET_PREFIX);
  }
}
