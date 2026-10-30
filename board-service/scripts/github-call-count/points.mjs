// Github's published GraphQL cost of one document: every connection asked for
// with `first` or `last` costs the product of the page sizes above it, the sum
// is divided by 100 and rounded, and the least a document costs is 1. It prices
// what a document could return, not what came back. The calculator in
// `src/projects/github-projects.source.spec.ts` is the same rule and is checked
// there against the 60 points the old rollup was known to cost; this one also
// reads a page size passed as a variable.
export function points(query, variables = {}) {
  let total = 0;
  const multipliers = [1];
  const selection = /(?:\.\.\.\s*on\s+)?([A-Za-z_]\w*)\s*(?::\s*([A-Za-z_]\w*)\s*)?(?:\(([^()]*)\))?\s*\{|\}/g;
  for (let m = selection.exec(query); m; m = selection.exec(query)) {
    if (m[0] === '}') { multipliers.pop(); continue; }
    const above = multipliers[multipliers.length - 1];
    const field = m[2] ?? m[1];
    // The operation's own variable list can declare `$first`; it is not a connection.
    const page = field !== 'query' && field !== 'mutation' && m[3] && /\b(?:first|last)\s*:\s*(\$?\w+)/.exec(m[3]);
    const size = page ? Number(page[1].startsWith('$') ? variables[page[1].slice(1)] ?? 100 : page[1]) : NaN;
    if (Number.isFinite(size)) total += above;
    multipliers.push(Number.isFinite(size) ? above * size : above);
  }
  return Math.max(1, Math.round(total / 100));
}
