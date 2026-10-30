import { ISSUE_STORE, type IssueStore } from '../github-store/issue-store';
import { IssueStoreHealth } from '../github-store/issue-store-health';
import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { Public } from '../auth/jwt-auth.guard';

@Controller()
export class HealthController {
  constructor(
    @Optional() @Inject(IssueStoreHealth) private readonly storeHealth = new IssueStoreHealth(),
    @Optional() @Inject(ISSUE_STORE) private readonly store: IssueStore | null = null,
  ) {}

  @Public()
  @Get('health')
  health() {
    return {
      status: 'ok',
      webhookStore: this.storeHealth.snapshot(Boolean(this.store)),
      // Baked into the image at build time (--build-arg APP_VERSION=<tag>).
      // Lets a deploy assert the *correct* image is live, not merely that the
      // service is up. null in local/dev builds.
      version: process.env.APP_VERSION ?? null,
      timestamp: new Date().toISOString(),
    };
  }
}
