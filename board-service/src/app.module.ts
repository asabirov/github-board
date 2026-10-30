import { createPrismaClient } from './prisma';
import { GithubExpiryInterceptor } from './auth/github-expiry.interceptor';
import { GithubUserService, GITHUB_DB } from './auth/github-user.service';
import { GithubAuthController } from './auth/github-auth.controller';
import { GithubPrincipalGuard } from './auth/github-principal.guard';
import { githubContext } from './auth/github-principal';
import { Module, Inject, type NestModule, type MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { configValidationSchema } from './config/config.schema';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { GithubAdmissionGuard } from './auth/github-admission.guard';
import { GithubAdmissionService } from './auth/github-admission.service';
import { RequiredScopesGuard } from './auth/required-scopes.guard';
import { SessionService } from './auth/session.service';
import { SessionRevocationModule } from './auth/session-revocation.module';
import { MeController } from './auth/me.controller';
import { OwnerRenameController } from './auth/owner-rename.controller';
import { HealthController } from './health/health.controller';
import { PeopleModule } from './people/people.module';
import { AdminModule } from './admin/admin.module';
import { AdminAuthorityModule } from './auth/admin-authority.module';
import { CapabilityModule } from './capability/capability.module';
import { CapabilityGuard } from './capability/capability.guard';
import { IdentityModule } from './identity/identity.module';
import { IssuesMetricsModule } from './issues-metrics/issues-metrics.module';
import { IssuesCacheModule } from './issues-metrics/issues-cache.module';
import { IssueBucketsModule } from './issue-buckets/issue-buckets.module';
import { IssueDetailModule } from './issue-detail/issue-detail.module';
import { AuditModule } from './audit/audit.module';
import { ProjectsModule } from './projects/projects.module';
import { ReposModule } from './repos/repos.module';
import { DeliveryModule } from './delivery/delivery.module';
import { FreshnessModule } from './freshness/freshness.module';
import { McpModule } from './mcp/mcp.module';
import { McpController } from './mcp/mcp.controller';
import { GoalsModule } from './goals/goals.module';
import { AccountModule } from './account/account.module';
import { SyncModule } from './sync/sync.module';
import { GithubStoreModule } from './github-store/github-store.module';
import { GithubDestinationBootstrap } from './config/github-destination-bootstrap';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: configValidationSchema,
      validationOptions: { libraryOptions: { abortEarly: false } },
    }),
    // First, and @Global (#584): the capability guard task 6 registers resolves
    // the registry from AppModule's own injector.
    CapabilityModule,
    AdminAuthorityModule,
    // Was a bare provider here (#112). Promoted to a @Global module (#456) so the
    // MCP surface can reach the same denylist the guard and the logout controller
    // use — re-declaring it in a second module would split it in two.
    SessionRevocationModule,
    // @Global too (#1007, V5): the issues cache module is a leaf and takes the
    // webhook store from here without importing anything.
    GithubStoreModule,
    PeopleModule,
    AdminModule,
    IdentityModule,
    IssuesMetricsModule,
    // Imported HERE as well as transitively (#650), because MeController is
    // declared on this module and resolves its providers from this injector.
    // What it takes is ORG_READ_STATE — one method — not the cache itself. Nest
    // instantiates a module once, so the ~70-repo scan is still the one every
    // other consumer already shares.
    IssuesCacheModule,
    IssueBucketsModule,
    IssueDetailModule,
    AuditModule,
    ProjectsModule,
    ReposModule,
    DeliveryModule,
    McpModule,
    AccountModule,
    GoalsModule,
    SyncModule,
    // LAST, and after every module whose cache it drops (#692). It resolves the
    // four through the container rather than by injection, so import order does
    // not decide what it can reach — but a reader looking for what a write
    // invalidates should find it after the things it invalidates.
    FreshnessModule,
  ],
  controllers: [
    HealthController,
    GithubAuthController,
    MeController,
    // #1167 — where a renamed organisation went. Beside MeController and not on
    // it: this one spends Github round trips, and the mount probe must not.
    OwnerRenameController,
    McpController,
  ],
  providers: [
    SessionService,
    GithubAdmissionService,
    GithubUserService,
    // Resolves the FEEDBACK_REPO and boot-alert repository IDs. `main.ts` starts it.
    GithubDestinationBootstrap,
    { provide: APP_INTERCEPTOR, useClass: GithubExpiryInterceptor },
    { provide: GITHUB_DB, useFactory: () => createPrismaClient() },
    // Guard order matters: JwtAuthGuard runs first (populates request.user),
    // then GithubAdmissionGuard checks the GitHub sign-in allow list (agents
    // skip it), then RequiredScopesGuard enforces the route's declared
    // @RequiredScopes against a scoped actor's req.user.scopes (humans pass
    // through), then CapabilityGuard checks what the BOARD'S own Github
    // credential may do (#584) — the one guard a human does not pass through,
    // because that credential is not theirs.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: GithubAdmissionGuard },
    { provide: APP_GUARD, useClass: RequiredScopesGuard },
    { provide: APP_GUARD, useClass: GithubPrincipalGuard },
    { provide: APP_GUARD, useClass: CapabilityGuard },
  ],
})
export class AppModule implements NestModule {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply((req: unknown, res: { setHeader(name: string, value: string): void }, next: () => void) => {
      if (!this.config.get<boolean>('AUTH_DISABLED', false)) {
        res.setHeader('Cache-Control', 'private, no-store');
        githubContext.run({ principal: null }, next);
      }
      else next();
    }).forRoutes('*');
  }
}
