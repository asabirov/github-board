import { Module } from '@nestjs/common';
import { AdminAuthorityModule } from '../auth/admin-authority.module';
import { AdminGuard } from '../admin/admin.guard';
import { HumanOnlyGuard } from '../account/human-only.guard';
import { GoalsController } from './goals.controller';
import { GoalsService } from './goals.service';

@Module({ imports: [AdminAuthorityModule], controllers: [GoalsController], providers: [GoalsService, AdminGuard, HumanOnlyGuard] })
export class GoalsModule {}
