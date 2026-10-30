import { Controller, Get, Header, Inject, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { githubPrincipal } from './github-principal';
import { buildOctokitClient } from '../sources/github-client';
import { knownRepos, whereOwnerWent, type AskRepo } from './owner-rename';

/**
 * `GET /api/auth/owners/:login` — where that owner's work is now, when the
 * board can prove it moved (#1167).
 *
 * The refusal screen asks this about the owner in the address, and only about
 * an owner the answer to `/api/auth/me` does not list. `owner-rename.ts` holds
 * the whole of what may be believed and why; this is the wiring.
 *
 * It answers a BODY for every case rather than a status, and it throws nothing.
 * Every arm here is a question the board could not settle — an unconnected
 * session, a login that is not a login, a Github that refused every ask — and
 * none of them is a failure of this request. A refusal screen that met a 4xx
 * here would have to decide what to say about the failure of the thing it asked
 * in order to say something better; `renamedTo: null` is the same screen it drew
 * before this route existed.
 *
 * Its own controller rather than a second handler on `MeController`, which is a
 * reflection of the session JWT and nothing else: this one spends up to five
 * Github round trips on somebody's behalf, and folding it into the mount probe
 * would put them in front of every page load on the board.
 *
 * The person's OWN token does the asking, so this can reveal nothing they could
 * not already read. That is also what makes the answer worth having: the
 * repositories it reasons from are repositories they reach, so an answer of
 * `acme` is proof they reach `acme`.
 */
@Controller('auth')
export class OwnerRenameController {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  @Get('owners/:login')
  @Header('Cache-Control', 'no-store')
  async owner(@Param('login') login: string): Promise<{ login: string; renamedTo: string | null }> {
    return { login, renamedTo: await this.renamedTo(login) };
  }

  private async renamedTo(login: string): Promise<string | null> {
    // `githubPrincipal` throws where a request reached here with an unresolved
    // context. That is a state this answer has no opinion about, and the screen
    // asking has one already: it is drawn over a session with no Github on it.
    let person;
    try {
      person = githubPrincipal();
    } catch {
      return null;
    }
    if (!person?.token) return null;
    const octokit = buildOctokitClient(this.config, 'read');
    const ask: AskRepo = async (owner, repo) => {
      try {
        // Octokit follows the 301 Github serves for a repository that moved,
        // which lands on `/repositories/<id>` and answers with the repository's
        // current owner. The id in that answer is what the decision compares.
        const { data } = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
        return { id: data.id, owner: data.owner.login };
      } catch {
        return null;
      }
    };
    return whereOwnerWent(login, knownRepos(person.repositories), ask);
  }
}
