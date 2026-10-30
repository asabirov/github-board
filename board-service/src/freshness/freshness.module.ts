import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { FreshnessRegistry } from './freshness.registry';
import { WriteFreshnessInterceptor } from './write-freshness.interceptor';

/**
 * What keeps the board's cached answers honest after one of its own writes
 * (#692).
 *
 * `@Global`, for the reason `SessionRevocationModule` and `CapabilityModule` are:
 * one registry for the whole app, reachable without every module that might
 * want it declaring an import. Nothing here is per-request or per-module — the
 * four caches it drops are singletons, and a second registry would be a second
 * list of them to keep in sync.
 *
 * The interceptor is registered as `APP_INTERCEPTOR` from this module rather
 * than from `AppModule`'s own `providers`, so the mechanism arrives whole with
 * one import line: a deployment either has the module or does not.
 */
@Global()
@Module({
  providers: [FreshnessRegistry, { provide: APP_INTERCEPTOR, useClass: WriteFreshnessInterceptor }],
  exports: [FreshnessRegistry],
})
export class FreshnessModule {}
