import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IssuesCacheModule } from './issues-cache.module';
import { IssuesCacheService } from './issues-cache.service';
import { IssuesMetricsService } from './issues-metrics.service';
import { IssuesMetricsController } from './issues-metrics.controller';
import { ProjectsModule } from '../projects/projects.module';
import { ProjectsService } from '../projects/projects.service';
import { IdentityModule } from '../identity/identity.module';
import { GithubLoginResolver } from '../identity/github-login.resolver';

@Module({
  // IssuesCacheModule owns the shared raw-issues cache (one org-wide scan per
  // TTL); ProjectsModule exports ProjectsService — getMine joins issues to their
  // boards for stacking by project (#206). No cycle: projects never import here,
  // and the cache is a leaf both sides import.
  //
  // IdentityModule exports GithubLoginResolver — the one answer to "which Github
  // handle belongs to this address" (#520), which is what "Your work" attributes
  // by. It imports only ConfigService, so no cycle either.
  imports: [IssuesCacheModule, ProjectsModule, IdentityModule],
  controllers: [IssuesMetricsController],
  providers: [
    {
      provide: IssuesMetricsService,
      inject: [IssuesCacheService, ConfigService, ProjectsService, GithubLoginResolver],
      useFactory: (
        issuesCache: IssuesCacheService,
        config: ConfigService,
        projects: ProjectsService,
        githubLogins: GithubLoginResolver,
      ) => new IssuesMetricsService(issuesCache, config, projects, githubLogins),
    },
  ],
  // Exported so the sync endpoint (#301) can force a refresh of the issue caches.
  exports: [IssuesMetricsService],
})
export class IssuesMetricsModule {}
