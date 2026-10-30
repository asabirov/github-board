import { BadRequestException, Inject, Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrismaClient } from '../prisma';

export interface GoalLevels { dailyGoal: number; level2Goal: number; level3Goal: number }
export const DEFAULT_GOAL_LEVELS: GoalLevels = { dailyGoal: 100, level2Goal: 200, level3Goal: 300 };

export function goalLevels(value: unknown): GoalLevels {
  const levels = value as Partial<GoalLevels> | null;
  const values = [levels?.dailyGoal, levels?.level2Goal, levels?.level3Goal];
  if (values.some(n => typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 2147483647)
    || !(values[0]! < values[1]! && values[1]! < values[2]!)) {
    throw new BadRequestException('Enter three flame levels as positive whole numbers in strictly increasing order, up to 2147483647.');
  }
  return { dailyGoal: values[0]!, level2Goal: values[1]!, level3Goal: values[2]! };
}

@Injectable()
export class GoalsService implements OnModuleDestroy {
  readonly db: ReturnType<typeof createPrismaClient> | null;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.db = config.get<string>('IDENTITY_SOURCE') === 'db' ? createPrismaClient() : null;
  }

  get enabled(): boolean { return this.db !== null; }
  async onModuleDestroy() { await this.db?.$disconnect(); }

  async personal(sub: string): Promise<GoalLevels> {
    const row = await this.db?.personalGoal.findUnique({ where: { sub } });
    return row ? goalLevels(row) : { ...DEFAULT_GOAL_LEVELS };
  }

  async team(orgId: bigint): Promise<GoalLevels> {
    const row = await this.db?.organisationGoal.findUnique({ where: { orgId } });
    return row ? goalLevels(row) : { ...DEFAULT_GOAL_LEVELS };
  }

  async savePersonal(sub: string, value: unknown): Promise<GoalLevels> {
    const goal = goalLevels(value);
    if (!this.db) throw new ServiceUnavailableException('Goal settings are unavailable.');
    await this.db.personalGoal.upsert({ where: { sub }, create: { sub, ...goal }, update: goal });
    return goal;
  }

  async saveTeam(orgId: bigint, value: unknown): Promise<GoalLevels> {
    const goal = goalLevels(value);
    if (!this.db) throw new ServiceUnavailableException('Goal settings are unavailable.');
    await this.db.organisationGoal.upsert({ where: { orgId }, create: { orgId, ...goal }, update: goal });
    return goal;
  }
}
