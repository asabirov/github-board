import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../auth/jwt-auth.guard';
import { Writes } from '../capability/writes.decorator';
import { ISSUE_STORE, type IssueStore, type ReceiveOutcome } from './issue-store';
import { answerWithin, WEBHOOK_DEADLINE, WEBHOOK_DEADLINE_MS } from './webhook-deadline';
import { verifyWebhookSignature } from './webhook-signature';

interface WebhookRequest {
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Where the board's Github App delivers its webhooks (#1007, V5).
 *
 * Public, because Github holds no board session: the signature is the whole of
 * the authentication. By the time a request reaches this handler,
 * `webhook-body.ts` has refused everything that could be refused without the
 * body and left the body here as the bytes that arrived, and nothing has parsed
 * them. The HMAC is checked over those bytes, and only a delivery that passes is
 * parsed and recorded.
 *
 * What a delivery can do is narrow. It writes the webhook store and moves the
 * store's signal, and it can never make the board serve anything to anybody:
 * the only reader of the store is the issue ingest, which asks it about the
 * repositories of the person whose request it is serving, after every guard in
 * front of that request has run.
 *
 * `@Writes()` with no capability, because nothing here writes Github.
 */
@Controller('github/webhook')
export class GithubWebhookController {
  private readonly logger = new Logger(GithubWebhookController.name);

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Optional() @Inject(ISSUE_STORE) private readonly store: IssueStore | null = null,
    // Injectable only so a spec can drive the deadline in milliseconds rather
    // than in seconds; production has the one value and no way to set another.
    @Optional() @Inject(WEBHOOK_DEADLINE) private readonly deadlineMs: number = WEBHOOK_DEADLINE_MS,
  ) {}

  @Public()
  @Writes()
  @Post()
  @HttpCode(200)
  async receive(@Req() req: WebhookRequest): Promise<{ status: ReceiveOutcome }> {
    const secret = this.config.get<string>('GITHUB_WEBHOOK_SECRET', '');
    if (!secret || !this.store) throw new NotFoundException();
    const raw = req.body;
    if (!Buffer.isBuffer(raw)) throw new BadRequestException('The delivery body was not read as bytes');
    if (!verifyWebhookSignature(secret, raw, headerOf(req, 'x-hub-signature-256'))) {
      throw new UnauthorizedException('The signature does not match');
    }
    const id = headerOf(req, 'x-github-delivery');
    const event = headerOf(req, 'x-github-event');
    if (!id || !event) throw new BadRequestException('Missing X-GitHub-Delivery or X-GitHub-Event');

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BadRequestException('The delivery is not JSON');
    }

    // Bounded here and not by the transaction: see `webhook-deadline.ts`. A
    // store that stalls holds its connection either way, and this is what stops
    // it holding Github's socket with it.
    const work = this.store.receive({ id, event, payload });
    let answered = false;
    // The store signals committed changes before pruning or the HTTP answer.
    // Work may still finish after the response deadline; record that separately.
    void work.then(
      (outcome) => {
        if (answered) {
          this.logger.warn(`webhook delivery ${id} (${event}) was recorded as ${outcome} after board had answered 503`);
        }
      },
      // Logged below, where it is answered.
      () => {},
    );
    let status: ReceiveOutcome;
    try {
      status = await answerWithin(work, this.deadlineMs);
    } catch (err) {
      // A failure answered as one, so Github's delivery log shows it failed and
      // it can be redelivered. Github does not redeliver on its own, but the
      // change is not lost: the store stops serving the repository's baseline
      // once it is older than `maxAgeMs` (issue-store.ts), and the next read
      // pages Github and writes a fresh baseline that carries the change. So
      // this is an expected, recovered state, not an error.
      answered = true;
      this.logger.warn(`webhook delivery ${id} (${event}) could not be recorded: ${(err as Error).message}`);
      throw new ServiceUnavailableException('The delivery could not be recorded');
    }
    return { status };
  }
}

function headerOf(req: WebhookRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}
