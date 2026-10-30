import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '../ui/kit';
import { workflowLabels } from './workflow-labels';
import { BoardView } from './BoardView';
import type { ViewerIssue } from './viewer-issue';

const labels = (...names: string[]) => names.map((name) => ({ name, color: 'ffffff' }));

describe('reporter-selected workflow labels', () => {
  it('recognizes the seven exact spellings and deduplicates equivalent badges', () => {
    expect(workflowLabels(labels('in-progress', 'in progress', 'agent-reviewing', 'pr:agent-reviewing', 'ready-to-merge', 'pr:ready-to-merge', 'pr:blocked')).map((s) => s.name))
      .toEqual(['In progress', 'Agent reviewing', 'Ready to merge', 'PR blocked']);
  });

  it('keeps source order rather than choosing a priority winner', () => {
    expect(workflowLabels(labels('pr:blocked', 'in-progress', 'ready-to-merge')).map((s) => s.key))
      .toEqual(['blocked', 'progress', 'ready']);
  });

  it('does not infer states from case, substrings, unknown labels or object keys', () => {
    expect(workflowLabels(labels('In-progress', 'not-in-progress', 'blocked', 'bug', '__proto__', 'constructor'))).toEqual([]);
  });

  it('keeps every raw label accessible while rendering each status once', () => {
    const issue: ViewerIssue = {
      repo: 'board', number: 954, title: 'Mark cards', htmlUrl: 'https://github.com/acme/board.example.com/issues/954',
      state: 'open', assignees: ['octocat'], projects: [], type: 'feature', createdAt: '2026-09-09T00:00:00Z',
      labels: labels('pr:agent-reviewing', 'agent-reviewing', 'bug', 'pr:blocked'),
    };
    const html = renderToStaticMarkup(<TooltipProvider><BoardView groups={[{ key: 'open', label: 'Open', tone: 'neutral', rows: [{ item: issue, depth: 0 }] }]} dim="openclosed" mayClose={false} mayAssign={false} /></TooltipProvider>);
    expect(html).toContain('aria-label="Mark cards; board#954; octocat; Labels: pr:agent-reviewing, agent-reviewing, bug, pr:blocked"');
    expect(html).toContain('title="Labels: pr:agent-reviewing, agent-reviewing, bug, pr:blocked"');
    expect(html.match(/>Agent reviewing</g)).toHaveLength(1);
    expect(html).toContain('PR blocked');
    expect(html).not.toContain('Close issue');
  });
});
