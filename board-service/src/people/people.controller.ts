import {
  BadGatewayException,
  Controller,
  Get,
  Header,
  Inject,
  Logger,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { IPeopleSource, PEOPLE_SOURCE } from './people-source';
import { Person, buildPeople } from './people-aliases';
import { AuthenticatedActor, isStaticAgent } from '../auth/static-agent';
import { IDENTITY_REPOSITORY, IdentityRepository, recordToAlias } from '../identity/identity.repository';

interface AuthedRequest {
  /** The shared actor shape, not a local restatement of it (#525): what tells a
   *  static token from a person is the `staticAgent` flag JwtAuthGuard sets, and
   *  it is declared next to the predicate that reads it. */
  user?: AuthenticatedActor;
}

// Global prefix 'api' → /api/people. Runs under JwtAuthGuard + TeamAccessGuard.
@Controller('people')
export class PeopleController {
  private readonly logger = new Logger(PeopleController.name);
  /** Local-part ↔ name linking only inside the team group's own domain. */
  private readonly nameMatchDomains: string[];

  constructor(
    @Inject(PEOPLE_SOURCE) private readonly source: IPeopleSource,
    @Inject(IDENTITY_REPOSITORY) private readonly identity: IdentityRepository,
  ) {
    // No email-domain name matching under GitHub-only sign-in: a GitHub login
    // has no domain to match a local part against.
    this.nameMatchDomains = [];
  }

  /**
   * The team roster: the GitHub allow list's named logins × the alias table.
   * An empty allow list names nobody, so the roster is empty.
   *
   * A static `BOARD_AGENT_TOKENS` token gets the roster with `emails` emptied
   * (#482). The alias table holds people's personal, non-corporate addresses,
   * and that token is nobody — a synthetic `agent:<name>` with no person behind
   * it, so nothing about the read is accountable to anyone. What it keeps is
   * what makes the roster useful to an agent: names, GitHub logins, ClickUp
   * names, and `id` — the person's group address, which is the row's key and
   * the one address the team group publishes about them anyway. A human session
   * and a personal access token see the list unchanged.
   *
   * The full roster stays out of HTTP caches. The board may persist its
   * existing projection without personal aliases. A request with no user
   * is a guard regression, and it must fail loudly rather than answer 200 with
   * the unredacted roster.
   */
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('X-Board-Persist', 'roster-without-aliases')
  async list(@Req() req: AuthedRequest): Promise<{ people: Person[] }> {
    if (!req?.user?.email) throw new UnauthorizedException('No session');
    try {
      const [emails, records] = await Promise.all([
        this.source.listMemberEmails(),
        this.identity.list(),
      ]);
      const aliases = records.map(recordToAlias);
      const people = buildPeople(emails, aliases, { nameMatchDomains: this.nameMatchDomains });
      if (isStaticAgent(req?.user)) {
        return { people: people.map((person) => ({ ...person, emails: [] })) };
      }
      return { people };
    } catch (err) {
      // Cold failure with no cached list — the frontend falls back to its
      // legacy name-merge roster on any non-2xx. Detail goes to the log only:
      // a malformed GOOGLE_SERVICE_ACCOUNT_JSON makes JSON.parse throw with a
      // snippet of the raw key material in the message — never echo that.
      this.logger.error(`people source failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new BadGatewayException('people source unavailable');
    }
  }
}
