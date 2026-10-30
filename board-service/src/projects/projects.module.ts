import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IssuesCacheModule } from '../issues-metrics/issues-cache.module';
import { IssuesCacheService } from '../issues-metrics/issues-cache.service';
import { PROJECTS_SOURCE, IProjectsSource } from './project.types';
import { FixtureProjectsSource } from './fixture-projects.source';
import { GithubProjectsSource } from './github-projects.source';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';

@Module({
  // IssuesCacheModule exports the shared raw-issues cache — the rollup derives
  // each board's weekly close-rate (#391) from it. It's a leaf (imports nothing
  // from metrics/projects), so importing it here is cycle-free; the one org-wide
  // issue scan is now shared with the metrics side instead of duplicated.
  imports: [IssuesCacheModule],
  controllers: [ProjectsController],
  providers: [
    {
      // `github` reads the Projects (v2) boards of every owner in scope over
      // GraphQL; `fixture` runs local with no GitHub creds.
      provide: PROJECTS_SOURCE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<string>('PROJECTS_SOURCE') === 'github'
          ? new GithubProjectsSource(config)
          : new FixtureProjectsSource(),
    },
    {
      // Explicit-token factory: tsx/esbuild emit no param metadata, so the source
      // + cache are injected by token here rather than inferred.
      provide: ProjectsService,
      inject: [PROJECTS_SOURCE, ConfigService, IssuesCacheService],
      useFactory: (source: IProjectsSource, config: ConfigService, issuesCache: IssuesCacheService) =>
        new ProjectsService(source, config, issuesCache),
    },
  ],
  exports: [ProjectsService],
})
export class ProjectsModule {}
