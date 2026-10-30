import { describe, expect, it } from 'vitest';
import { BadGatewayException, UnauthorizedException } from '@nestjs/common';
import { PeopleController } from './people.controller';
import type { IPeopleSource } from './people-source';
import { FixtureIdentityRepository } from '../identity/fixture-identity.repository';

const source = (impl: () => Promise<string[]>): IPeopleSource => ({ listMemberEmails: impl });
// Read-only PEOPLE_ALIASES-backed store — same identities the file always provided.
const identity = new FixtureIdentityRepository();

/** A signed-in teammate: no scopes, so nothing about the roster is narrowed. */
const human = { user: { sub: 'g-1', email: 'octocat@example.com' } };
/** A `BOARD_AGENT_TOKENS` actor: no person behind it, and carrying the
 *  `staticAgent` flag JwtAuthGuard sets to say so (#525). */
const staticAgent = {
  user: { sub: 'agent:ci', email: 'agent:ci', agent: true, staticAgent: true, scopes: ['board:read'] },
};
/** The same actor from a token whose name would have made it read as a person.
 *  Unconfigurable since #525, and no longer decided by the address either. */
const staticAgentWithPersonShapedName = {
  user: {
    sub: 'agent:claude@ci',
    email: 'agent:claude@ci',
    agent: true,
    staticAgent: true,
    scopes: ['board:read'],
  },
};
/** A personal access token — agent flag too, but it carries its owner's address. */
const pat = {
  user: { sub: 'octocat@example.com', email: 'octocat@example.com', agent: true, scopes: ['board:read'] },
};

describe('PeopleController', () => {
  it('wraps member emails in { people } via buildPeople', async () => {
    const ctrl = new PeopleController(source(async () => ['octocat@example.com']), identity);
    const res = await ctrl.list(human);
    expect(res.people).toHaveLength(1);
    expect(res.people[0]).toMatchObject({ id: 'octocat@example.com', displayName: 'Octocat' });
  });

  it('cold source failure → 502, and the upstream error text is NOT echoed to the client', async () => {
    // A malformed GOOGLE_SERVICE_ACCOUNT_JSON surfaces as a JSON.parse error whose
    // message quotes the raw input — the wire body must stay generic.
    const ctrl = new PeopleController(source(async () => {
      throw new SyntaxError('Unexpected token p in JSON: "-----BEGIN PRIVATE KEY-----MC4C…"');
    }), identity);
    const err = await ctrl.list(human).then(
      () => null,
      (e: unknown) => e as BadGatewayException,
    );
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(JSON.stringify(err!.getResponse())).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(err!.getResponse())).toContain('people source unavailable');
  });

  it('an impostor gmail whose local part title-cases to a fixture name stays unlinked', async () => {
    const ctrl = new PeopleController(
      source(async () => ['monalisa@gmail.com']),
      identity,
    );
    const { people } = await ctrl.list(human);
    // Not linked to the Octocat alias entry: no GitHub login, own card.
    expect(people).toHaveLength(1);
    expect(people[0].githubLogin).toBeNull();
  });

  // #482 — a static agent token is nobody: no person is accountable for what it
  // reads, so the roster it gets back carries no addresses. The alias table's
  // personal, non-corporate ones (octocat@example.org) are the ones that matter.
  it('static agent token: the roster keeps its names and logins but drops every address', async () => {
    const ctrl = new PeopleController(source(async () => ['octocat@example.com']), identity);
    const { people } = await ctrl.list(staticAgent);
    expect(people).toHaveLength(1);
    expect(people[0].displayName).toBe('Octocat');
    expect(people[0].githubLogin).toBe('octocat');
    expect(people[0].emails).toEqual([]);
    expect(JSON.stringify(people)).not.toContain('octocat@example.org');
  });

  // #525 — the roster used to be redacted on the strength of "no @ in the
  // address". A token named `claude@ci` produced `agent:claude@ci`, which reads
  // as a person, and every address in the alias table went out with it.
  it('static agent token whose address reads as a person: the addresses still do not go out', async () => {
    const ctrl = new PeopleController(source(async () => ['octocat@example.com']), identity);
    const { people } = await ctrl.list(staticAgentWithPersonShapedName);
    expect(people[0].emails).toEqual([]);
    expect(JSON.stringify(people)).not.toContain('octocat@example.org');
  });

  it('personal access token: the roster is untouched — its owner sees the same list in the board', async () => {
    const ctrl = new PeopleController(source(async () => ['octocat@example.com']), identity);
    const { people } = await ctrl.list(pat);
    expect(people[0].emails).toContain('octocat@example.org');
  });

  it('human session: the roster is untouched', async () => {
    const ctrl = new PeopleController(source(async () => ['octocat@example.com']), identity);
    const { people } = await ctrl.list(human);
    expect(people[0].emails).toContain('octocat@example.org');
  });

  // The guards make this unreachable — it is spelled out so a later reorder
  // cannot turn "no identity" into the unredacted roster, which is what the
  // redaction test above would still be passing while it happened.
  it('no user at all: 401 rather than the roster, redacted or otherwise', async () => {
    const ctrl = new PeopleController(source(async () => ['octocat@example.com']), identity);
    await expect(ctrl.list({})).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
