import { describe, expect, it, vi } from 'vitest';
import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReposController } from './repos.controller';
import type { ReposService } from './repos.service';
import type { IReposSource, RepoOwner, RepoPageView, ReposHealthView, ReposView } from './repo.types';
import type { AuditService } from '../audit/audit.service';
import { CapabilityRegistry } from '../capability/capability.registry';

/**
 * The source stub the read-route fixtures below pass.
 *
 * `servedOrgs` names one org, and nothing derives WHICH: the fixtures build
 * `new ConfigService({})`, `GITHUB_ORGS` has carried no default since #1175, and
 * `githubOrgs` throws on an env that names no key. None of those four cases
 * sends an `?org=`, so the gate returns before reading either — the stub is here
 * because the controller's constructor takes a source, not because those cases
 * turn on which org it names.
 *
 * One named const rather than four copies of the same literal, and NOT an
 * `as any`: the two `#649` suites at the bottom of this file build their own
 * sources with `servedOrg` set deliberately against the config, and three of
 * those tests discriminate only because the value is real.
 */
const DEFAULT_SOURCE = { servedOrgs: ['acme'] } as unknown as IReposSource;

describe('ReposController (#472)', () => {
  it('serves the map straight off the service cache', async () => {
    const view: ReposView = {
      updatedAt: '2026-08-05T00:00:00.000Z',
      repos: [],
      driOptions: [],
      driOptionsByOrg: {},
      unreadableOrgs: [],
      ownerWritability: 'writable',
    };
    const listRepos = vi.fn(async () => view);
    const controller = new ReposController(
      { listRepos } as unknown as ReposService,
      new ConfigService({}),
      { record: vi.fn() } as unknown as AuditService,
      new CapabilityRegistry(new ConfigService({})),
      DEFAULT_SOURCE,
    );
    expect(await controller.list()).toBe(view);
    expect(listRepos).toHaveBeenCalledTimes(1);
  });

  it('serves security and CI off the health read, never off the map (#571)', async () => {
    const health: ReposHealthView = {
      repos: [
        {
          full: 'acme/board',
          security: { depHigh: 1, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read' },
          ci: 'failure',
          ciUrl: 'https://github.com/acme/board/actions/runs/1',
        },
      ],
      unreadableOrgs: [],
    };
    const listRepos = vi.fn(async () => ({}) as ReposView);
    const listHealth = vi.fn(async () => health);
    const controller = new ReposController(
      { listRepos, listHealth } as unknown as ReposService,
      new ConfigService({}),
      { record: vi.fn() } as unknown as AuditService,
      new CapabilityRegistry(new ConfigService({})),
      DEFAULT_SOURCE,
    );

    expect(await controller.health()).toBe(health);
    // The two are separate reads: asking for health must not drag the map's
    // repo listing and issue ingest along with it.
    expect(listRepos).not.toHaveBeenCalled();
  });

  it('serves one repo\'s page from the owner and name in the route (#575)', async () => {
    const completedDayChange: RepoPageView['completedDayChange'] = {
      previousDay: '2026-08-12',
      day: '2026-08-13',
      openIssues: { state: 'read', value: 0 },
      openPrs: { state: 'none' },
      ciNetUsd: { state: 'unknown' },
    };
    const page = { repo: { full: 'acme/board' }, completedDayChange } as unknown as RepoPageView;
    const repoPage = vi.fn(async () => page);
    const listRepos = vi.fn(async () => ({}) as ReposView);
    const controller = new ReposController(
      { repoPage, listRepos } as unknown as ReposService,
      new ConfigService({}),
      { record: vi.fn() } as unknown as AuditService,
      new CapabilityRegistry(new ConfigService({})),
      DEFAULT_SOURCE,
    );

    expect(await controller.page('acme', 'board')).toBe(page);
    expect(repoPage).toHaveBeenCalledWith('acme', 'board');
    const payload = JSON.parse(JSON.stringify(await controller.page('acme', 'board')));
    expect(payload.completedDayChange).toEqual(completedDayChange);
    expect(payload.completedDayChange.ciNetUsd).not.toEqual(payload.completedDayChange.openIssues);
    // A read, under the same guard chain as the map — it must not go anywhere
    // near the map's own listing to answer.
    expect(listRepos).not.toHaveBeenCalled();
  });

  it('lets a repo that is not on the map 404 rather than answering an empty page', async () => {
    const repoPage = vi.fn(async () => {
      throw new NotFoundException('repo acme/nope not found');
    });
    const controller = new ReposController(
      { repoPage } as unknown as ReposService,
      new ConfigService({}),
      { record: vi.fn() } as unknown as AuditService,
      new CapabilityRegistry(new ConfigService({})),
      DEFAULT_SOURCE,
    );
    await expect(controller.page('acme', 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

function make(
  opts: {
    writesEnabled?: boolean;
    writability?: ReposView['ownerWritability'];
    /** What the write RESOLVES with — Github's record, which need not be the ask. */
    recorded?: RepoOwner | null;
    /** Org config, overriding the single-org default below (#649). */
    env?: Record<string, unknown>;
  } = {},
) {
  const view: ReposView = {
    updatedAt: '2026-08-05T00:00:00.000Z',
    repos: [],
    driOptions: ['octocat', 'IvanRoslov'],
    driOptionsByOrg: { 'acme': ['octocat', 'IvanRoslov'] },
    unreadableOrgs: [],
    ownerWritability: opts.writability ?? 'writable',
  };
  const listRepos = vi.fn(async () => view);
  const resolvedOwner: RepoOwner =
    opts.recorded === undefined ? { login: 'octocat', name: 'Octocat Octocat' } : (opts.recorded as RepoOwner);
  const ownerWriteEnv = vi.fn(async (_org: string) => ({
    allowed: view.driOptions,
    writability: view.ownerWritability,
  }));
  const setDri = vi.fn(async () => resolvedOwner);
  const record = vi.fn(async () => {});
  // The controller holds the write to the owner scope. It read
  // `ISSUES_METRICS_ORG` until #1209 part 4 retired the key, and the scope on
  // the no-person path these tests run is `GITHUB_ORGS`.
  const env: Record<string, unknown> = {
    GITHUB_ORGS: 'acme',
    GITHUB_WRITE_ENABLED: opts.writesEnabled ?? true,
    ...opts.env,
  };
  // A key an override sets to `undefined` means ABSENT — the key gone from the
  // object, not present holding `undefined`. The org resolver's rule is presence
  // rather than truthiness, so the two are different inputs to it, and a fixture
  // that spelled "no pin" the second way would model a deployment nobody runs.
  // `ConfigService` answers both with `undefined` today, so this changes nothing
  // these tests observe; it stops the fixture from being wrong on a point the
  // code under test turns on.
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const config = new ConfigService(env);
  const registry = new CapabilityRegistry(config);
  const controller = new ReposController(
    { listRepos, setDri, ownerWriteEnv } as unknown as ReposService,
    config,
    { record } as unknown as AuditService,
    // A real registry, empty: every capability reads `unknown`, and `unknown`
    // refuses nothing — so these cases test the envelope's other rungs exactly
    // as they did before the capability rung existed. The rung's own cases live
    // in `capability/write-envelope.spec.ts`, against a fed registry.
    registry,
    // The write path never asks the source anything — `setDri` resolves its
    // target through the allow-list and reads that org's schema through the
    // service. This is here because the controller holds a source for the READ
    // gate, and a fixture that omitted it would be testing a controller Nest
    // cannot build.
    { servedOrgs: ['acme'] } as unknown as IReposSource,
  );
  return { controller, listRepos, ownerWriteEnv, setDri, record, resolvedOwner, registry };
}

describe('ReposController.setDri (#558)', () => {
  it('returns the resolved owner on a happy-path write, and audits it', async () => {
    const { controller, setDri, record, resolvedOwner } = make();
    const req = { user: { email: 'a@x.io' } } as unknown as Parameters<ReposController['setDri']>[3];
    const result = await controller.setDri('acme', 'board', { login: 'octocat' }, req);
    expect(result).toEqual({ owner: resolvedOwner });
    expect(setDri).toHaveBeenCalledWith('acme/board', 'octocat');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorEmail: 'a@x.io',
        action: 'repo.dri',
        summary: 'Set acme/board DRI to octocat',
        targetType: 'repo',
        targetId: 'acme/board',
      }),
    );
  });

  it('400s a login outside driOptions, and never reaches the write', async () => {
    const { controller, setDri, record } = make();
    const req = { user: { email: 'a@x.io' } } as unknown as Parameters<ReposController['setDri']>[3];
    await expect(
      controller.setDri('acme', 'board', { login: 'not-a-real-login' }, req),
    ).rejects.toThrow(BadRequestException);
    expect(setDri).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

describe('ReposController.setDri — the rung the write used to skip (#577)', () => {
  const req = () => ({ user: { email: 'a@x.io' } }) as unknown as Parameters<ReposController['setDri']>[3];

  it('403s and never writes when the map says the property is restricted', async () => {
    const { controller, setDri, record } = make({ writability: 'restricted' });

    await expect(
      controller.setDri('acme', 'board', { login: 'octocat' }, req()),
    ).rejects.toThrow(ForbiddenException);

    // The point of the rung: Github is never asked a question the board can
    // already answer, so its 404 can never come back as a 500 on the tile.
    expect(setDri).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('502s and never writes when the map could not read the property at all', async () => {
    // `unreadable` is what a failed read produces since #649; `unknown` is now
    // only the row that read fine and held a value this board cannot map. Both
    // are the board admitting it does not know, so both answer 502 and neither
    // reaches Github.
    for (const writability of ['unreadable', 'unknown'] as const) {
      const { controller, setDri, record } = make({ writability });

      await expect(
        controller.setDri('acme', 'board', { login: 'octocat' }, req()),
      ).rejects.toThrow(BadGatewayException);

      expect(setDri).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    }
  });

  it('403s and never writes when the org has no dri property to set', async () => {
    // The state the whole route used to reach as `unknown`: a 404 on the schema
    // read, filed as "could not check", retried by the tile forever. It is a
    // fact about the org now, so it refuses permanently — and, like every other
    // refusing rung, Github is never asked a question the board can answer.
    const { controller, setDri, record } = make({ writability: 'absent' });

    await expect(
      controller.setDri('acme', 'board', { login: 'octocat' }, req()),
    ).rejects.toThrow(ForbiddenException);

    expect(setDri).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

describe('ReposController.setDri — the org pin, and what gets recorded (#577 round 2)', () => {
  const req = () => ({ user: { email: 'a@x.io' } }) as unknown as Parameters<ReposController['setDri']>[3];

  it('404s a repo outside the owner scope, and never reaches the write', async () => {
    const { controller, setDri, record } = make();

    await expect(
      controller.setDri('someone-else', 'their-repo', { login: 'octocat' }, req()),
    ).rejects.toThrow(NotFoundException);

    expect(setDri).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('reads the write gate through ownerWriteEnv, so a stale unknown can refresh', async () => {
    const { controller, ownerWriteEnv } = make();
    await controller.setDri('acme', 'board', { login: 'octocat' }, req());
    expect(ownerWriteEnv).toHaveBeenCalledTimes(1);
  });

  it('audits the owner Github RECORDED, naming the ask only when it differed', async () => {
    // The commit's whole thesis is that the record is the truth and the request
    // is not. The one row meant to be evidence must not say the ask happened.
    const { controller, record } = make({ recorded: { login: 'IvanRoslov', name: 'Ivan Roslov' } });

    await controller.setDri('acme', 'board', { login: 'octocat' }, req());

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: 'Set acme/board DRI to IvanRoslov (asked for octocat)',
      }),
    );
  });

  it('audits a cleared owner as nobody', async () => {
    const { controller, record } = make({ recorded: null });

    await controller.setDri('acme', 'board', { login: null }, req());

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'Set acme/board DRI to nobody' }),
    );
  });
});

/** Both read routes behind the org gate (#648), each with the spy that proves
 *  whether the refusal came before the read or after it. */
function gated(org?: string) {
  const view = {} as ReposView;
  const health = {} as ReposHealthView;
  const listRepos = vi.fn(async () => view);
  const listHealth = vi.fn(async () => health);
  const config = org === undefined ? new ConfigService({}) : new ConfigService({ GITHUB_ORGS: org });
  const controller = new ReposController(
    { listRepos, listHealth } as unknown as ReposService,
    config,
    { record: vi.fn() } as unknown as AuditService,
    new CapabilityRegistry(config),
    // Source and config AGREE here, deliberately: `servedOrg` is derived from the
    // same `org` this fixture pins the config with, so the two can never differ.
    // That is the right shape for these cases, which vary the `?org=` PARAM —
    // absent, blank, re-cased, repeated, a stranger — against a board whose map
    // and whose config name one org. A second axis they never read would make
    // them harder to follow and would prove nothing they are asking about.
    //
    // Where the two DISAGREE is its own suite: `ReposController read gate follows
    // the MAP, not the write set (#649)` builds its controller through `pair`,
    // which takes the served org and the configured orgs separately, and its
    // `follows the source, not the config` case reverses one against the other.
    //
    // `org ?? 'acme'` has the shape of the real source's answer: its map is
    // scoped to the first org of the metrics set, and an unset key follows
    // GITHUB_ORGS. WHICH org that is belongs to the deployment — GITHUB_ORGS has
    // carried no default since #1175, and an env naming none is refused at boot —
    // so the literal is this file's own org, the one its rows are written
    // against, and not a value anything here derives.
    { servedOrgs: [org ?? 'acme'] } as unknown as IReposSource,
  );
  return {
    view,
    health,
    routes: [
      { name: 'GET /repos', call: (q?: string) => controller.list(q), spy: listRepos, answer: view },
      { name: 'GET /repos/health', call: (q?: string) => controller.health(q), spy: listHealth, answer: health },
    ],
    listRepos,
    listHealth,
  };
}

describe('ReposController org param (#648)', () => {
  it('an org param outside the configured set is refused by the API, not degraded', async () => {
    for (const route of gated('acme').routes) {
      await expect(route.call('other-org'), route.name).rejects.toBeInstanceOf(NotFoundException);
      // The refusal PRECEDES the read: a 404 raised after the org-scoped Github
      // calls had already run would have read a stranger's posture first.
      expect(route.spy, route.name).not.toHaveBeenCalled();
    }
  });

  it('refuses a stranger on the inline default too, with nothing configured', async () => {
    for (const route of gated(undefined).routes) {
      await expect(route.call('other-org'), route.name).rejects.toBeInstanceOf(NotFoundException);
      expect(route.spy, route.name).not.toHaveBeenCalled();
    }
  });

  it('no org param serves the whole union, and says so to the service', async () => {
    for (const route of gated('acme').routes) {
      expect(await route.call(undefined), route.name).toBe(route.answer);
      expect(route.spy, route.name).toHaveBeenCalledTimes(1);
      // `undefined` is what "no org was asked" IS since #718, and the service
      // reads it as the whole union. It used to be `[]` — the param reached no
      // service at all, because there was nothing for a service to do with it.
      expect(route.spy.mock.calls[0], route.name).toEqual([undefined]);
    }
  });

  it('a case variant of the configured org is served, narrowed to the CONFIGURED spelling', async () => {
    for (const route of gated('acme').routes) {
      expect(await route.call('Acme'), route.name).toBe(route.answer);
      // Never the caller's half: the rows carry the org as Github spells it,
      // and a service handed `Acme` would filter on a spelling no row has.
      expect(route.spy.mock.calls[0], route.name).toEqual(['acme']);
    }
  });

  it('a repeated org param is refused, not answered and not crashed', async () => {
    // Express hands `?org=a&org=b` to the handler as an array, so a gate that
    // assumed a string would throw TypeError and answer 500 — and a request
    // naming two orgs at once must be refused, never quietly served as one.
    for (const route of gated('acme').routes) {
      const two = ['acme', 'other-org'] as unknown as string;
      await expect(route.call(two), route.name).rejects.toBeInstanceOf(NotFoundException);
      expect(route.spy, route.name).not.toHaveBeenCalled();
    }
  });

  it('a blank org param is treated as absent', async () => {
    for (const route of gated('acme').routes) {
      expect(await route.call('   '), route.name).toBe(route.answer);
      expect(route.spy.mock.calls[0], route.name).toEqual([undefined]);
    }
  });
});

/**
 * The scope as an ALLOW-LIST (#649, plan #618 task 7). The route serves every
 * org the scope names, and the schema read has to be aimed at one of them rather
 * than at whatever the caller typed.
 */
describe('ReposController.setDri — the owner scope is a set (#649)', () => {
  const req = () => ({ user: { email: 'a@x.io' } }) as unknown as Parameters<ReposController['setDri']>[3];
  /** Two orgs served — the shape this task exists for. */
  const two = { env: { GITHUB_ORGS: 'acme,globex' } };

  it('writes to either org in the configured set', async () => {
    // The positive control: without it every refusal below passes against a
    // route that refused both orgs.
    for (const owner of ['acme', 'globex']) {
      const { controller, setDri } = make(two);
      await controller.setDri(owner, 'board', { login: 'octocat' }, req());
      expect(setDri, owner).toHaveBeenCalledWith(`${owner}/board`, 'octocat');
    }
  });

  it('an owner outside the set never reaches ownerWriteEnv', async () => {
    // THE discriminating case. A schema read is an outward Github call, so the
    // 404 alone proves nothing — it would be thrown just the same by a route
    // that had already aimed a read at the stranger's org. What is asserted is
    // that the call never went out.
    const { controller, ownerWriteEnv, setDri, record } = make(two);
    await expect(
      controller.setDri('selgeo', 'their-repo', { login: 'octocat' }, req()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ownerWriteEnv).not.toHaveBeenCalled();
    expect(setDri).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('aims the schema read at the CONFIGURED spelling, never the caller half', async () => {
    // Github matches owners case-insensitively, so `GLOBEX` is a member of the
    // set and must be served. What goes outward is the operator's spelling.
    const { controller, ownerWriteEnv } = make(two);
    await controller.setDri('GLOBEX', 'board', { login: 'octocat' }, req());
    expect(ownerWriteEnv).toHaveBeenCalledWith('globex');
  });

  it('reads the schema for the org the request names, not the first in the list', async () => {
    const { controller, ownerWriteEnv } = make(two);
    await controller.setDri('globex', 'board', { login: 'octocat' }, req());
    expect(ownerWriteEnv).toHaveBeenCalledWith('globex');
  });

  it('refuses every owner when the scope names none', async () => {
    // `ISSUES_METRICS_ORG=''` turned this surface off and is retired (#1209 part
    // 4). An empty scope must still refuse rather than stop checking.
    const { controller, ownerWriteEnv, setDri } = make({ env: { GITHUB_ORGS: '   ' } });
    await expect(
      controller.setDri('acme', 'board', { login: 'octocat' }, req()),
    ).rejects.toThrow(/GITHUB_ORGS/);
    expect(ownerWriteEnv).not.toHaveBeenCalled();
    expect(setDri).not.toHaveBeenCalled();
  });
});

/**
 * The read gate answers a DIFFERENT question from the write pin, and this suite
 * is what holds the two apart (#649).
 *
 * An earlier revision of this file asserted the opposite — that the gate serves
 * every org the write pin allows. That was wrong and it is rewritten rather than
 * removed: `GET /api/repos?org=<second-org>` answered 200 carrying the FIRST
 * org's rows, and on `/health` those rows are per-repo secret-scanning,
 * dependabot and code-scanning counts, so the second org would have been
 * rendered a clean bill of health it never earned.
 */
describe('ReposController read gate follows the MAP, not the write set (#649)', () => {
  /** The read routes, with the write set and the served org set separately —
   *  which is the whole point: they are allowed to differ, and here they do. */
  function pair(opts: { orgs: string; servedOrgs: string[] }) {
    const view = {} as ReposView;
    const health = {} as ReposHealthView;
    const listRepos = vi.fn(async () => view);
    const listHealth = vi.fn(async () => health);
    const config = new ConfigService({ GITHUB_ORGS: opts.orgs });
    const controller = new ReposController(
      { listRepos, listHealth } as unknown as ReposService,
      config,
      { record: vi.fn() } as unknown as AuditService,
      new CapabilityRegistry(config),
      { servedOrgs: opts.servedOrgs } as unknown as IReposSource,
    );
    return [
      { name: 'GET /repos', call: (q?: string) => controller.list(q), spy: listRepos, answer: view },
      { name: 'GET /repos/health', call: (q?: string) => controller.health(q), spy: listHealth, answer: health },
    ];
  }

  /** Two orgs writable, one org on the map — the shape this leg actually ships. */
  const split = { orgs: 'acme,globex', servedOrgs: ['acme'] };

  it('serves the org the map covers', async () => {
    // The positive control: without it every refusal below passes against a gate
    // that refused everything.
    for (const route of pair(split)) {
      expect(await route.call('acme'), route.name).toBe(route.answer);
    }
  });

  it('an org in the write set that the map does not serve is refused by the read gate', async () => {
    // `globex` is an org a WRITE may legitimately target on this deployment.
    // The map still does not hold it, so a read asking for it has no answer —
    // and answering with the served org's rows under the asked org's name is a
    // false-clean security signal, not a near-enough one.
    for (const route of pair(split)) {
      await expect(route.call('globex'), route.name).rejects.toBeInstanceOf(NotFoundException);
      expect(route.spy, route.name).not.toHaveBeenCalled();
    }
  });

  it('follows the source, not the config — the two are read from different places', async () => {
    // THE discriminating case. A gate that re-derived its answer from the owner
    // scope would serve `globex` here and refuse `acme`, which is
    // exactly backwards from what the map holds.
    for (const route of pair({ orgs: 'globex,acme', servedOrgs: ['acme'] })) {
      expect(await route.call('acme'), route.name).toBe(route.answer);
    }
    for (const route of pair({ orgs: 'globex,acme', servedOrgs: ['acme'] })) {
      await expect(route.call('globex'), route.name).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('a case variant of the served org is served, because Github matches that way', async () => {
    for (const route of pair(split)) {
      expect(await route.call('Acme'), route.name).toBe(route.answer);
    }
  });

  it('still refuses an org in neither the set nor the map, before anything reads', async () => {
    for (const route of pair(split)) {
      await expect(route.call('selgeo'), route.name).rejects.toBeInstanceOf(NotFoundException);
      expect(route.spy, route.name).not.toHaveBeenCalled();
    }
  });

  it('refuses everything when the source serves no org at all', async () => {
    // `servedOrgs` is empty when the metrics set is — an operator who turned
    // enumeration off. There is no map, so there is nothing to serve.
    for (const route of pair({ orgs: 'acme', servedOrgs: [] })) {
      await expect(route.call('acme'), route.name).rejects.toBeInstanceOf(NotFoundException);
      expect(route.spy, route.name).not.toHaveBeenCalled();
    }
  });

  /**
   * The map is plural now (#718), so the gate is membership over every org the
   * source serves — and `?org=` NARROWS rather than merely passing.
   *
   * The suite above stays exactly as it was and is not a contradiction of this
   * one: it pins a source serving ONE org while two are configured, which is
   * still refused, because the gate goes on following the map rather than the
   * write set.
   */
  describe('and the map now spans every configured org (#718)', () => {
    const both = { orgs: 'acme,globex', servedOrgs: ['acme', 'globex'] };

    it('serves either served org, and tells the service which one to narrow to', async () => {
      for (const org of ['acme', 'globex']) {
        for (const route of pair(both)) {
          expect(await route.call(org), `${route.name} ${org}`).toBe(route.answer);
          // The narrowing is the service's, and this is the seam: a controller
          // that validated the org and then dropped it would answer 200 with
          // both orgs' rows under one org's name.
          expect(route.spy.mock.calls[0], `${route.name} ${org}`).toEqual([org]);
        }
      }
    });

    it('serves the whole union when no org was asked for', async () => {
      for (const route of pair(both)) {
        expect(await route.call(undefined), route.name).toBe(route.answer);
        expect(route.spy.mock.calls[0], route.name).toEqual([undefined]);
      }
    });

    it('hands over the CONFIGURED spelling of a re-cased org, never the caller’s', async () => {
      for (const route of pair(both)) {
        expect(await route.call('GLOBEX'), route.name).toBe(route.answer);
        expect(route.spy.mock.calls[0], route.name).toEqual(['globex']);
      }
    });

    it('still refuses an org neither served nor configured, before anything reads', async () => {
      for (const route of pair(both)) {
        await expect(route.call('selgeo'), route.name).rejects.toBeInstanceOf(NotFoundException);
        expect(route.spy, route.name).not.toHaveBeenCalled();
      }
    });
  });
});
