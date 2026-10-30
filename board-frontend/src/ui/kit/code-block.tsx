import * as React from 'react';
import { Button, type ButtonProps } from './button';
import { cn } from './cn';
import { CheckGlyph, CopyGlyph } from './icons';

export type CodeLang = 'tsx' | 'ts' | 'bash' | 'json' | 'css';
export type CodeVariant = 'default' | 'diff' | 'terminal';
type TokenKind = 'comment' | 'string' | 'keyword' | 'other';
type Token = { kind: TokenKind; text: string };

const TOKEN_CLASS: Record<TokenKind, string> = {
  comment: 'text-muted italic',
  string: 'text-success',
  keyword: 'text-[var(--accent)]',
  other: 'text-dim',
};

const TS_KEYWORDS = [
  'import', 'from', 'export', 'default', 'const', 'let', 'var', 'function', 'return', 'new', 'type',
  'interface', 'enum', 'extends', 'implements', 'class', 'async', 'await', 'if', 'else', 'for', 'while',
  'switch', 'case', 'break', 'continue', 'true', 'false', 'null', 'undefined', 'void', 'as', 'satisfies',
  'typeof', 'keyof', 'in', 'of',
];

type LangConfig = { lineComment?: string; blockComment: boolean; keywords: string[] };

const LANGS: Record<CodeLang, LangConfig> = {
  ts: { lineComment: '//', blockComment: true, keywords: TS_KEYWORDS },
  tsx: { lineComment: '//', blockComment: true, keywords: TS_KEYWORDS },
  bash: {
    lineComment: '#',
    blockComment: false,
    keywords: [
      'pnpm', 'npm', 'npx', 'yarn', 'node', 'cd', 'export', 'echo', 'sudo', 'git', 'rm', 'mkdir', 'cp', 'mv',
      'ls', 'cat', 'set', 'source',
    ],
  },
  json: { blockComment: false, keywords: ['true', 'false', 'null'] },
  css: {
    blockComment: true,
    keywords: [
      'important', 'inherit', 'initial', 'unset', 'none', 'auto', '@media', '@import', '@keyframes',
      '@font-face', '@supports',
    ],
  },
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildRegex(cfg: LangConfig) {
  const commentAlts: string[] = [];
  if (cfg.blockComment) commentAlts.push('/\\*[\\s\\S]*?\\*/');
  if (cfg.lineComment) commentAlts.push(escapeRe(cfg.lineComment) + '[^\\n]*');
  const comment = commentAlts.length ? `(?<comment>${commentAlts.join('|')})` : '';
  const string = '(?<string>\'(?:[^\'\\\\]|\\\\.)*\'|"(?:[^"\\\\]|\\\\.)*"|`(?:[^`\\\\]|\\\\.)*`)';
  const kw = cfg.keywords.map(escapeRe).join('|');
  const keyword = kw ? `(?<keyword>(?<![\\w$])(?:${kw})(?![\\w$]))` : '';
  const other = '(?<other>[\\s\\S])';
  return new RegExp([comment, string, keyword, other].filter(Boolean).join('|'), 'g');
}

const LANG_RE = Object.fromEntries(Object.entries(LANGS).map(([lang, cfg]) => [lang, buildRegex(cfg)])) as Record<CodeLang, RegExp>;

function tokenize(code: string, lang: CodeLang) {
  const tokens: Token[] = [];
  for (const match of code.matchAll(LANG_RE[lang])) {
    const g = match.groups ?? {};
    const kind: TokenKind = g.comment != null ? 'comment' : g.string != null ? 'string' : g.keyword != null ? 'keyword' : 'other';
    const prev = tokens[tokens.length - 1];
    if (prev && prev.kind === kind && kind === 'other') prev.text += match[0];
    else tokens.push({ kind, text: match[0] });
  }
  return tokens;
}

function tokenizeLines(code: string, lang: CodeLang) {
  const lines: Token[][] = [[]];
  for (const token of tokenize(code, lang)) {
    token.text.split('\n').forEach((segment, i) => {
      if (i > 0) lines.push([]);
      if (segment !== '') lines[lines.length - 1].push({ kind: token.kind, text: segment });
    });
  }
  return lines;
}

function dropLeading(tokens: Token[], count: number) {
  const out: Token[] = [];
  let remaining = count;
  for (const token of tokens) {
    if (remaining <= 0) out.push(token);
    else if (token.text.length <= remaining) remaining -= token.text.length;
    else {
      out.push({ kind: token.kind, text: token.text.slice(remaining) });
      remaining = 0;
    }
  }
  return out;
}

export interface CopyButtonProps extends Omit<ButtonProps, 'value' | 'children' | 'icon' | 'iconPosition' | 'asChild'> {
  value: string;
  label?: string;
}

export const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(
  ({ value, label = 'Copy', className, variant = 'ghost', size = 'icon', onClick, ...props }, ref) => {
    const [copied, setCopied] = React.useState(false);
    const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
    React.useEffect(() => () => clearTimeout(timer.current), []);
    const handleClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (!navigator.clipboard?.writeText) return;
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      } catch {
        // A refused clipboard leaves the button as it was.
      }
    };
    return (
      <Button
        ref={ref}
        type="button"
        variant={variant}
        size={size}
        onClick={handleClick}
        className={cn(className)}
        {...props}
        aria-label={copied ? 'Copied' : label}
        icon={copied ? <CheckGlyph className="text-success" /> : <CopyGlyph />}
      />
    );
  },
);
CopyButton.displayName = 'CopyButton';

export interface CodeBlockProps extends React.HTMLAttributes<HTMLPreElement> {
  code: string;
  lang?: CodeLang;
  /** `default` plain, `diff` tints `+`/`-` lines, `terminal` dims the `$` prompt and drops copy. */
  variant?: CodeVariant;
  /** Show a copy control in the corner. */
  copy?: boolean;
  /** Scroll long lines instead of wrapping. */
  scroll?: boolean;
}

export const CodeBlock = React.forwardRef<HTMLPreElement, CodeBlockProps>(
  ({ code, lang = 'tsx', variant = 'default', copy = false, scroll = false, className, ...props }, ref) => {
    const lines = React.useMemo(() => tokenizeLines(code, lang), [code, lang]);
    const rawLines = React.useMemo(() => code.split('\n'), [code]);
    const isDiff = variant === 'diff';
    const isTerminal = variant === 'terminal';
    const contentWhitespace = scroll ? 'whitespace-pre' : 'whitespace-pre-wrap break-words';
    return (
      <div className="relative overflow-hidden rounded-lg border border-line bg-bg">
        <pre
          ref={ref}
          className={cn('py-4 font-mono text-xs leading-6 text-dim', scroll && 'overflow-x-auto', className)}
          {...props}
        >
          <code className="block min-w-full">
            {lines.map((tokens, i) => {
              const raw = rawLines[i] ?? '';
              const diffKind = isDiff ? (raw[0] === '+' ? 'add' : raw[0] === '-' ? 'remove' : null) : null;
              const promptLen = isTerminal && raw[0] === '$' ? 1 : 0;
              const markerDrop = diffKind ? 1 : promptLen;
              const body = markerDrop ? dropLeading(tokens, markerDrop) : tokens;
              return (
                <span
                  key={i}
                  data-line={i + 1}
                  className={cn(
                    'flex px-4',
                    // The tint spans the full scroll width, not just the viewport.
                    scroll && 'w-max min-w-full',
                    diffKind === 'add' && 'bg-success-fill',
                    diffKind === 'remove' && 'bg-danger-fill',
                  )}
                >
                  {(isDiff || isTerminal) && (
                    <span
                      aria-hidden
                      className={cn(
                        'mr-2 w-[1ch] shrink-0 select-none text-center',
                        diffKind === 'add' && 'text-success',
                        diffKind === 'remove' && 'text-danger',
                        promptLen > 0 && 'text-muted',
                      )}
                    >
                      {diffKind === 'add' ? '+' : diffKind === 'remove' ? '-' : promptLen > 0 ? '$' : ''}
                    </span>
                  )}
                  <span className={cn('min-w-0 flex-1', contentWhitespace)}>
                    {body.length ? body.map((token, j) => <span key={j} className={TOKEN_CLASS[token.kind]}>{token.text}</span>) : ' '}
                  </span>
                </span>
              );
            })}
          </code>
        </pre>
        {copy && !isTerminal && (
          // Always visible, and opaque so it reads cleanly where a long first line runs under it.
          <CopyButton value={code} label="Copy code" className="absolute right-2 top-2 z-10 size-7 bg-bg" />
        )}
      </div>
    );
  },
);
CodeBlock.displayName = 'CodeBlock';
