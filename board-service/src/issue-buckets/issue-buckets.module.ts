import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ISSUE_BUCKETS_SOURCE } from './issue-buckets.types';
import { GithubIssueBucketsSource } from './github-issue-buckets.source';
import { FixtureIssueBucketsSource } from './fixture-issue-buckets.source';
import { IssueBucketsService } from './issue-buckets.service';
import { IssueBucketsController } from './issue-buckets.controller';

@Module({
  controllers: [IssueBucketsController],
  providers: [
    {
      // Reuse the ISSUES_SOURCE toggle: `fixture` runs fully local, anything else
      // hits GitHub search (org-wide counts still need the shared GitHub creds).
      provide: ISSUE_BUCKETS_SOURCE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<string>('ISSUES_SOURCE') === 'fixture'
          ? new FixtureIssueBucketsSource()
          : new GithubIssueBucketsSource(config),
    },
    {
      provide: IssueBucketsService,
      inject: [ISSUE_BUCKETS_SOURCE, ConfigService],
      useFactory: (source, config) => new IssueBucketsService(source, config),
    },
  ],
  // Exported so the sync endpoint (#301) can force a refresh of the counts.
  exports: [IssueBucketsService],
})
export class IssueBucketsModule {}
