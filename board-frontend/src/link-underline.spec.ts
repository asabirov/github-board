import { describe, expect, it } from 'vitest';
import * as ts from 'typescript-api';

function bareUnderlines(source: string): number[] {
  const file = ts.createSourceFile('component.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines: number[] = [];
  function visit(node: ts.Node) {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) &&
        node.text.split(/\s+/).some(token => {
          const utility = token.match(/(?:^|:)(!?underline!?|!?\[text-decoration-line:underline\]!?)$/);
          if (!utility) return false;
          const variants = token.slice(0, utility.index).split(':').filter(Boolean);
          return variants.length === 0 || variants.some(variant =>
            !['hover', 'group-hover', 'focus', 'focus-visible'].includes(variant));
        })) {
      lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return lines;
}

describe('shared link underline policy', () => {
  it('rejects bare utilities in literal and interpolated class strings', () => {
    expect(bareUnderlines('const a = "text-link underline";')).toEqual([1]);
    expect(bareUnderlines('const a = `text-link ${tone} underline`;')).toEqual([1]);
    expect(bareUnderlines('const a = "hover:underline focus-visible:underline no-underline";')).toEqual([]);
    expect(bareUnderlines('// underline\nconst a = "text-link";')).toEqual([]);
  });

  it.each(['md:underline', 'sm:underline', 'dark:underline', '!underline',
    'underline!', 'md:!underline', '[text-decoration-line:underline]'])('rejects resting utility %s', token => {
    expect(bareUnderlines(`const a = "text-link ${token}";`)).toEqual([1]);
  });

  it.each(['hover:underline', 'group-hover:underline', 'focus:underline',
    'focus-visible:underline', 'hover:focus:underline', 'focus:!underline'])('allows interaction utility %s', token => {
    expect(bareUnderlines(`const a = "text-link ${token}";`)).toEqual([]);
  });

  it('keeps resting underlines in the shared CSS instead of component utilities', () => {
    const sources = import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const violations = Object.entries(sources)
      .filter(([path]) => !/\.spec\.[^.]+$/.test(path))
      .flatMap(([path, source]) => bareUnderlines(source).map(line => `${path}:${line}`));
    expect(violations).toEqual([]);
  });
});
