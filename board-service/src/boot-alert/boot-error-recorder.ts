import { ConsoleLogger, LogLevel, LoggerService } from '@nestjs/common';

/**
 * One error the service logged while it was starting (#592).
 *
 * `level` is the whole trigger. Nothing here is ever matched against — the
 * message and detail are carried so a person can read them, never so code can
 * decide on them. See the note on `BootErrorRecorder` for why that matters.
 */
export interface CapturedLog {
  level: 'error' | 'fatal';
  at: string;
  context: string | null;
  message: string;
  detail: string | null;
}

/**
 * How many records one boot may hold. A crash-looping module can log the same
 * failure hundreds of times in the seconds before `listen` resolves, and the
 * report has to stay a thing somebody reads — and stay under Github's body
 * limit. Past this the count in `dropped` carries the rest.
 */
const MAX_CAPTURED = 25;

/**
 * A Nest logger that behaves exactly like the console one and, on the side,
 * remembers every error and fatal.
 *
 * Installed before `NestFactory.create` so it is already listening while the
 * modules initialise — which is where the errors worth waking somebody for are
 * logged, long before any request arrives.
 *
 * It keys on SEVERITY. Not on wording, not on a context name, not on a regex
 * over the message: the only question asked is which method was called. That is
 * the lesson of #588, where a rule matching a sentence went quiet the day the
 * sentence was rewritten. A reworded, retranslated or reformatted error is the
 * same error to this class.
 */
export class BootErrorRecorder implements LoggerService {
  private readonly captured: CapturedLog[] = [];

  /** Errors past `MAX_CAPTURED`, counted rather than kept. */
  dropped = 0;

  constructor(private readonly delegate: LoggerService = new ConsoleLogger()) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.delegate.log(message, ...rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.delegate.warn(message, ...rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.delegate.debug?.(message, ...rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.delegate.verbose?.(message, ...rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.delegate.error(message, ...rest);
    this.capture('error', message, rest);
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.delegate.fatal?.(message, ...rest);
    this.capture('fatal', message, rest);
  }

  setLogLevels(levels: LogLevel[]): void {
    this.delegate.setLogLevels?.(levels);
  }

  /**
   * Hand over what was captured and forget it, so the report is filed once even
   * if something calls this twice.
   */
  drain(): CapturedLog[] {
    return this.captured.splice(0, this.captured.length);
  }

  /**
   * The console has already had the call by the time this runs, so a failure
   * here costs the report and nothing else — hence the catch. Rendering runs on
   * whatever a module chose to pass, including objects that will not stringify.
   */
  private capture(level: 'error' | 'fatal', message: unknown, rest: unknown[]): void {
    try {
      if (this.captured.length >= MAX_CAPTURED) {
        this.dropped += 1;
        return;
      }
      this.captured.push({
        level,
        at: new Date().toISOString(),
        context: contextOf(rest),
        message: render(message),
        detail: detailOf(rest),
      });
    } catch {
      this.dropped += 1;
    }
  }
}

/**
 * Nest's convention is `error(message, stack?, context?)`, with the context
 * last. Treating a trailing short string as the context is a presentation
 * guess and nothing depends on it being right.
 */
function contextOf(rest: unknown[]): string | null {
  const last = rest[rest.length - 1];
  return typeof last === 'string' && last.length > 0 && !last.includes('\n') && last.length <= 80
    ? last
    : null;
}

function detailOf(rest: unknown[]): string | null {
  const parts = (contextOf(rest) === null ? rest : rest.slice(0, -1)).map(render).filter(Boolean);
  return parts.length ? parts.join('\n') : null;
}

function render(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
