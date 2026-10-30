import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HumanOnlyGuard } from '../account/human-only.guard';
import { CapabilityRegistry } from '../capability/capability.registry';
import { IssuesCacheModule } from '../issues-metrics/issues-cache.module';
import { IssuesCacheService } from '../issues-metrics/issues-cache.service';
import { ISSUE_DETAIL_SOURCE } from './issue-detail.types';
import { GithubIssueDetailSource } from './github-issue-detail.source';
import { FixtureIssueDetailSource } from './fixture-issue-detail.source';
import { IssueDetailService } from './issue-detail.service';
import { IssueDetailController } from './issue-detail.controller';

@Module({
  // The shared raw-issues cache — a leaf module, so importing it here adds no
  // cycle. The issue page reads it for one thing: the submission marker its
  // relations gate needs (#516).
  imports: [IssuesCacheModule],
  controllers: [IssueDetailController],
  providers: [
    HumanOnlyGuard,
    {
      // Reuse the shared ISSUES_SOURCE toggle: `fixture` runs fully local,
      // anything else fetches from GitHub via the shared creds.
      provide: ISSUE_DETAIL_SOURCE,
      // The registry is injected by TOKEN, not inferred from the parameter's
      // type: tsx/esbuild emit no `design:paramtypes`, so an inferred
      // class-typed parameter boots in dev and crash-loops compiled (#584).
      inject: [ConfigService, CapabilityRegistry],
      useFactory: (config: ConfigService, registry: CapabilityRegistry) =>
        config.get<string>('ISSUES_SOURCE') === 'fixture'
          ? new FixtureIssueDetailSource()
          : new GithubIssueDetailSource(config, registry),
    },
    {
      provide: IssueDetailService,
      inject: [ISSUE_DETAIL_SOURCE, ConfigService, IssuesCacheService],
      useFactory: (source, config, issuesCache) => new IssueDetailService(source, config, issuesCache),
    },
  ],
})
export class IssueDetailModule {}
