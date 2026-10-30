import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DELIVERY_SOURCE } from './delivery.types';
import { GithubDeliverySource } from './github-delivery.source';
import { FixtureDeliverySource } from './fixture-delivery.source';
import { DeliveryService } from './delivery.service';
import { DeliveryController } from './delivery.controller';

@Module({
  controllers: [DeliveryController],
  providers: [
    {
      // `fixture` runs fully local; anything else reads the real org over GraphQL.
      // Mirrors the other *_SOURCE toggles so a fixture read model never touches GitHub.
      provide: DELIVERY_SOURCE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<string>('DELIVERY_SOURCE') === 'fixture'
          ? new FixtureDeliverySource()
          : new GithubDeliverySource(config),
    },
    {
      provide: DeliveryService,
      inject: [DELIVERY_SOURCE, ConfigService],
      useFactory: (source, config) => new DeliveryService(source, config),
    },
  ],
})
export class DeliveryModule {}
