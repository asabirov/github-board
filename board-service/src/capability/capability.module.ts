import { Global, Inject, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CapabilityRegistry } from './capability.registry';

/**
 * @Global for the same reason `audit/audit.module.ts` is (#584): a thing every
 * write path needs, injected without each feature module importing it.
 *
 * Two things read the registry: `CapabilityGuard`, which refuses a write whose
 * capability is `refused`, and `/api/auth/me`, which reports the same snapshot
 * to the browser. It is built, provided and probed here.
 */
@Global()
@Module({
  providers: [
    {
      provide: CapabilityRegistry,
      inject: [ConfigService],
      // No validation happens in here. A factory that throws aborts
      // NestFactory.create; the deny list is validated by the Joi schema.
      useFactory: (config: ConfigService) => new CapabilityRegistry(config),
    },
  ],
  exports: [CapabilityRegistry],
})
export class CapabilityModule implements OnApplicationBootstrap {
  constructor(@Inject(CapabilityRegistry) private readonly registry: CapabilityRegistry) {}

  onApplicationBootstrap(): void {
    // NOT awaited. The probe must never hold a boot and never hold the first
    // request: until it lands every capability reads `unknown`, `unknown`
    // refuses nothing, and the first write after a restart goes out and teaches
    // the registry from Github's own answer. `probe()` never rejects, so the
    // floating promise cannot become an unhandled rejection.
    void this.registry.probe();
  }
}
