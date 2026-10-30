import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HumanOnlyGuard } from '../account/human-only.guard';
import { CapabilityRegistry } from '../capability/capability.registry';
import { IssuesCacheModule } from '../issues-metrics/issues-cache.module';
import { IssuesCacheService } from '../issues-metrics/issues-cache.service';
import { IdentityModule } from '../identity/identity.module';
import { GithubLoginResolver } from '../identity/github-login.resolver';
import { FixtureReposSource } from './fixture-repos.source';
import { GithubReposSource } from './github-repos.source';
import { IReposSource, REPOS_SOURCE } from './repo.types';
import { ReposController } from './repos.controller';
import { ReposService } from './repos.service';

@Module({
  // IssuesCacheModule exports the shared raw-issues cache — the map's per-repo
  // counts are a rollup of that one org-wide scan (#257/#391), so this surface
  // adds no issue fetch of its own. It's a leaf module, so importing it here is
  // cycle-free.
  //
  // IdentityModule brings GithubLoginResolver, which answers the owner names the
  // map puts beside a dri login (#541) — previously read straight off the
  // checked-in table, so a roster-only owner showed as a bare handle. It imports
  // nothing of its own, so it is a leaf too and there is no cycle — the same
  // argument issues-metrics.module.ts already makes.
  imports: [IssuesCacheModule, IdentityModule],
  controllers: [ReposController],
  providers: [
    HumanOnlyGuard,
    {
      // Reuse the ISSUES_SOURCE toggle, as the buckets/detail surfaces do:
      // `fixture` runs fully local, anything else reads the org over GitHub.
      provide: REPOS_SOURCE,
      // The registry is injected by TOKEN, not inferred from the parameter's
      // type: tsx/esbuild emit no `design:paramtypes`, so an inferred
      // class-typed parameter boots in dev and crash-loops compiled (#584).
      inject: [ConfigService, CapabilityRegistry],
      useFactory: (config: ConfigService, registry: CapabilityRegistry) =>
        config.get<string>('ISSUES_SOURCE') === 'fixture'
          ? new FixtureReposSource()
          : new GithubReposSource(config, registry),
    },
    {
      // Explicit-token factory: tsx/esbuild emit no param metadata, so the source
      // and the shared cache are injected by token rather than inferred.
      provide: ReposService,
      inject: [REPOS_SOURCE, ConfigService, IssuesCacheService, GithubLoginResolver],
      useFactory: (
        source: IReposSource,
        config: ConfigService,
        issuesCache: IssuesCacheService,
        githubLogins: GithubLoginResolver,
      ) => new ReposService(source, config, issuesCache, githubLogins),
    },
  ],
  // Exported so the sync endpoint (#301) can force the map fresh.
  exports: [ReposService],
})
export class ReposModule {}
