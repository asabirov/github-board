import type { IssueLabel } from '../api/types';

const PROGRESS = { key: 'progress', name: 'In progress', className: 'text-accent bg-accent-fill' };
const REVIEW = { key: 'review', name: 'Agent reviewing', className: 'text-warn bg-warn-fill' };
const READY = { key: 'ready', name: 'Ready to merge', className: 'text-success bg-success-fill' };
const BLOCKED = { key: 'blocked', name: 'PR blocked', className: 'text-danger bg-danger-fill' };

const MATCHES = new Map([
  ['in-progress', PROGRESS], ['in progress', PROGRESS],
  ['agent-reviewing', REVIEW], ['pr:agent-reviewing', REVIEW],
  ['ready-to-merge', READY], ['pr:ready-to-merge', READY],
  ['pr:blocked', BLOCKED],
]);

/** Exact reporter-selected aliases, in source order. Aliases share one badge. */
export function workflowLabels(labels: readonly IssueLabel[]) {
  const seen = new Set<string>();
  return labels.flatMap(({ name }) => {
    const match = MATCHES.get(name);
    if (!match || seen.has(match.key)) return [];
    seen.add(match.key);
    return [match];
  });
}
