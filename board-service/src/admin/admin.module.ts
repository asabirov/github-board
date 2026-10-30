import { Inject, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { PeopleModule } from '../people/people.module';
import { IdentityModule } from '../identity/identity.module';
import { AccountModule } from '../account/account.module';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminAccessService } from './admin-access.service';
import { AgentsService } from './agents.service';
import { IdentityController } from '../identity/identity.controller';
import { WriteIdentityService } from '../sources/write-identity.service';

/**
 * The admin Access panel (#11). Imports PeopleModule to reuse PEOPLE_SOURCE (the
 * same roster the Team page uses); admin resolution (roles, source, health) runs
 * through the @Global AdminAuthority (#143), so no local admin provider is needed.
 *
 * `WriteIdentityService` is provided here rather than globally (#756) because the
 * admin surface is its only reader — the write paths do not consult it, and must
 * not: nothing about a mutation may wait on a network call that answers a
 * question the mutation did not ask.
 */
@Module({
  imports: [PeopleModule, IdentityModule, AccountModule],
  controllers: [AdminController, IdentityController],
  providers: [AdminGuard, AdminAccessService, AgentsService, WriteIdentityService],
})
export class AdminModule implements OnApplicationBootstrap {
  constructor(@Inject(WriteIdentityService) private readonly writeIdentity: WriteIdentityService) {}

  onApplicationBootstrap(): void {
    // Not awaited, for the reason `capability.module.ts` says at the same hook:
    // a network call must never hold a boot. `announce()` returns void and
    // swallows its own promise, and `resolve()` never rejects, so nothing here
    // can become an unhandled rejection.
    //
    // It is fired at boot and not on first read so the answer is in the log of
    // the deploy that changed the credential — which is where an operator is
    // already looking at the moment the question is live.
    this.writeIdentity.announce();
  }
}
