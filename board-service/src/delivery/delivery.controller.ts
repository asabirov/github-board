import { Controller, Get, Inject } from '@nestjs/common';
import { DeliveryService } from './delivery.service';
import type { DeliveryView } from './delivery.types';

/**
 * Read-only delivery-stream API. Global prefix 'api' → GET /api/delivery. Runs
 * under the existing global chain (JwtAuthGuard → TeamAccessGuard): any team
 * member reads; nothing writes (everything deep-links to GitHub).
 */
@Controller('delivery')
export class DeliveryController {
  constructor(@Inject(DeliveryService) private readonly delivery: DeliveryService) {}

  @Get()
  get(): Promise<DeliveryView> {
    return this.delivery.getDelivery();
  }
}
