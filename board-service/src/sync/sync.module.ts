import { Module } from '@nestjs/common';
import { HumanOnlyGuard } from '../account/human-only.guard';
import { IssuesMetricsModule } from '../issues-metrics/issues-metrics.module';
import { IssueBucketsModule } from '../issue-buckets/issue-buckets.module';
import { ProjectsModule } from '../projects/projects.module';
import { ReposModule } from '../repos/repos.module';
import { IdentityModule } from '../identity/identity.module';
import { SyncController } from './sync.controller';

/**
 * The "sync now" endpoint (#301). Imports the cached read modules whose
 * surfaces the dashboards render, and exposes one human-only POST that forces
 * them all fresh. No new source or write — it reuses the existing read caches.
 */
@Module({
  imports: [
    IssuesMetricsModule,
    IssueBucketsModule,
    ProjectsModule,
    ReposModule,
    // #535: brings DerivedLoginsService, whose map this endpoint drops and re-warms.
    IdentityModule,
  ],
  controllers: [SyncController],
  providers: [HumanOnlyGuard],
})
export class SyncModule {}
