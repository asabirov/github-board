import { Controller, Get, Header, Inject } from '@nestjs/common';
import { IssueBucketsService } from './issue-buckets.service';
import { IssueBuckets } from './issue-buckets.types';

/**
 * GET /api/issues/buckets — the dashboard Issues block (#185): open, bugs,
 * feedback and unassigned counts over every org this board serves (#697), plus
 * their GitHub deep-links. `no-store` so
 * the browser never caches on top of the service's short server-side TTL; the
 * `syncedAt` field carries the real freshness. Behind the global SSO + team
 * guards like every other read surface.
 */
@Controller('issues')
export class IssueBucketsController {
  constructor(@Inject(IssueBucketsService) private readonly service: IssueBucketsService) {}

  @Get('buckets')
  @Header('Cache-Control', 'no-store')
  buckets(): Promise<IssueBuckets> {
    return this.service.getBuckets();
  }
}
