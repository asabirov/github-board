import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrismaClient } from '../prisma';
import { buildOctokitClient } from '../sources/github-client';
import { initializeDestinations, type DestinationBindings, type DestinationKey } from './github-destination';

@Injectable()
export class GithubDestinationBootstrap implements DestinationBindings {
  private readonly database;
  private readonly logger = new Logger('GithubDestinations');
  private destinationTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private started = false;
  private destinationAttempt?: Promise<void>;
  private readonly memory = new Map<DestinationKey, number>();
  get persisted(): boolean { return this.database !== null; }

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {
    const url = config.get<string>('GITHUB_STORE_DATABASE_URL');
    this.database = url ? createPrismaClient(url, { urlName: 'GITHUB_STORE_DATABASE_URL' }) : null;
  }

  async read(key: DestinationKey): Promise<number | undefined> {
    if (!this.database) return this.memory.get(key);
    const row = await this.database.githubDestination.findUnique({ where: { key } });
    return row ? Number(row.repositoryId) : undefined;
  }

  async bind(key: DestinationKey, id: number): Promise<number> {
    if (!this.database) {
      if (!this.memory.has(key)) this.memory.set(key, id);
      return this.memory.get(key)!;
    }
    await this.database.githubDestination.createMany({
      data: [{ key, repositoryId: BigInt(id) }], skipDuplicates: true,
    });
    const row = await this.database.githubDestination.findUniqueOrThrow({ where: { key } });
    return Number(row.repositoryId);
  }

  /** Called after listen; no GitHub or persistence promise enters the boot path. */
  start(report: () => Promise<void>): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const client = () => buildOctokitClient(this.config, 'write');
    const delays = [60_000, 300_000, 900_000, 3_600_000];
    let destinationRetries = 0;
    let reported = false;
    const attempt = async () => {
      let complete = false;
      try { complete = await initializeDestinations(this.config, client(), this.logger, this); }
      catch { this.logger.error('GitHub destination initialization failed; affected features will retry in the background.'); }
      if (!complete && !this.stopped) {
        this.destinationTimer = setTimeout(() => { this.destinationAttempt = attempt(); }, delays[Math.min(destinationRetries++, delays.length - 1)]);
        this.destinationTimer.unref();
      }
      // The callback drains the shared boot recorder. Never call it from retries.
      if (!reported && !this.stopped) {
        reported = true;
        void Promise.resolve().then(report).catch(() => { this.logger.error('Destination boot alert could not be delivered.'); });
      }
    };
    this.destinationAttempt = attempt();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.destinationTimer);
    await this.destinationAttempt;
    await this.database?.$disconnect();
  }
}
