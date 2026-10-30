import 'reflect-metadata';
import { GithubDestinationBootstrap } from './config/github-destination-bootstrap';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { AppModule } from './app.module';
import { McpOAuthProvider } from './mcp/mcp-oauth.provider';
import { mcpAuthRouterOptions } from './mcp/mcp-auth-router-options';
import { BootErrorRecorder } from './boot-alert/boot-error-recorder';
import { reportBootErrors } from './boot-alert/boot-alert.notifier';
import { CapabilityRegistry } from './capability/capability.registry';
import { AuditService } from './audit/audit.service';
import { applyBodyParsers } from './config/body-limits';
import { RETIRED_SETTINGS } from './config/retired-settings';

async function bootstrap() {
  // Listening before the modules initialise, because that is where the errors
  // worth waking somebody for are logged (#592). It only watches severity, so a
  // reworded message is still the same error to it.
  const recorder = new BootErrorRecorder();

  const stale = RETIRED_SETTINGS.filter((key) => key in process.env);
  if (stale.length) new Logger('RetiredSettings').warn(`Retired settings are set: ${stale.join(', ')}`);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
    rawBody: true,
    logger: recorder,
  });
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api', { exclude: ['mcp'] });
  applyBodyParsers(app, { webhook: Boolean(config.get<string>('GITHUB_WEBHOOK_SECRET')) });
  app.enableCors({ origin: config.get<string>('CORS_ORIGIN', '*') });

  if (config.get<boolean>('BOARD_MCP_ENABLED')) {
    const base = new URL(config.get<string>('BOARD_BASE_URL')!);
    app.use(mcpAuthRouter(mcpAuthRouterOptions(app.get(McpOAuthProvider), base)));
  }

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
  new Logger('Bootstrap').log(
    `board service on :${port} (auth=${
      config.get('AUTH_DISABLED') ? 'disabled' : 'enabled'
    })`,
  );

  // After listen, so the service is already serving by the time anything is
  // reported and a slow or refused Github call costs availability nothing.
  const report = () => reportBootErrors(
    config,
    recorder.drain(),
    new Logger('BootAlert'),
    recorder.dropped,
    app.get(CapabilityRegistry),
    // #781 — the notifier's two Github writes land in the trail like every
    // other one. AuditModule is @Global, so the service is here to be got.
    app.get(AuditService),
  );
  if (config.get('ISSUES_SOURCE') !== 'fixture' || config.get<boolean>('GITHUB_WRITE_ENABLED', false)) {
    app.get(GithubDestinationBootstrap).start(report);
  } else {
    await report();
  }
}
void bootstrap();
