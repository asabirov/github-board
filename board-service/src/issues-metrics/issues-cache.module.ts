import { IssueStoreHealth } from '../github-store/issue-store-health';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ISSUES_SOURCE, IIssuesSource } from './issues-metrics.types';
import { GithubIssuesSource } from './github-issues.source';
import { FixtureIssuesSource } from './fixture-issues.source';
import { IssuesCacheService } from './issues-cache.service';
import { CapabilityRegistry } from '../capability/capability.registry';
import { composeOrgReadState, ORG_READ_STATE } from './org-read-state';
import { ISSUE_STORE, IssueStoreSignal, type IssueStore } from '../github-store/issue-store';

/**
 * The single owner of the raw-issues source + its cache. A leaf module: it
 * imports nothing from metrics/projects, so both IssuesMetricsModule and
 * ProjectsModule can import it without a cycle. Exporting IssuesCacheService
 * means the heavy ~70-repo scan runs once per TTL for the whole app instead of
 * once per consumer.
 *
 * It also composes ORG_READ_STATE (#650) — the one-question accessor a
 * controller can hold without holding the cache. Composed HERE rather than
 * inside `IssuesCacheService` because the two records it joins belong to
 * different layers: the cache would otherwise have to reach up into the
 * capability layer for a bootstrap it never uses itself. No `imports:` line is
 * needed for that reach — `CapabilityModule` is `@Global`, so the registry is
 * resolvable here without this leaf module importing it, and the leaf stays a
 * leaf.
 */
@Module({
  providers: [
    {
      // `fixture` runs fully local; anything else pages the real repos, so a
      // fixture read model never touches GitHub. The webhook store and its
      // signal (#1007, V5) come from the @Global GithubStoreModule, optionally,
      // so this leaf still builds alone and then reads Github for everything.
      provide: ISSUES_SOURCE,
      inject: [ConfigService, { token: ISSUE_STORE, optional: true }, { token: IssueStoreHealth, optional: true }],
      useFactory: (config: ConfigService, store?: IssueStore | null, health?: IssueStoreHealth) =>
        config.get<string>('ISSUES_SOURCE') === 'fixture'
          ? new FixtureIssuesSource()
          : new GithubIssuesSource(config, store ?? null, health),
    },
    {
      provide: IssuesCacheService,
      inject: [ISSUES_SOURCE, ConfigService, { token: IssueStoreSignal, optional: true }],
      useFactory: (source: IIssuesSource, config: ConfigService, signal?: IssueStoreSignal | null) =>
        new IssuesCacheService(source, config, signal ?? undefined),
    },
    {
      provide: ORG_READ_STATE,
      // Optional registry: a deployment or a spec that builds this module
      // without the capability layer loses the pre-first-ingest window and
      // nothing else — the composer then answers `[]`, which is "no claim".
      inject: [IssuesCacheService, { token: CapabilityRegistry, optional: true }],
      useFactory: (cache: IssuesCacheService, boot?: CapabilityRegistry) =>
        composeOrgReadState(cache, boot),
    },
  ],
  exports: [IssuesCacheService, ORG_READ_STATE],
})
export class IssuesCacheModule {}
