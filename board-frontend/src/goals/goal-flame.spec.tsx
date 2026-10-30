import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DayGrid } from '../flow-strip/DayGrid';
import { flameLevel, shadeScale } from '../flow-strip/flow-strip.vm';
import { overviewGoalPath, personalGoalPath, teamGoalPath } from './goals';
// @ts-expect-error node:fs is available in the test runtime.
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8');

describe('days over the applicable goal', () => {
  it('uses configured thresholds and suppresses flames without a known positive first level', () => {
    for (const [count, expected] of [[49, 0], [50, 1], [174, 1], [175, 2], [599, 2], [600, 3]] as const) {
      expect(flameLevel(count, 50, 175, 600)).toBe(expected);
    }
    for (const goal of [null, undefined, 0, -1, NaN, 1.5]) expect(flameLevel(300, goal, 200, 300)).toBe(0);
    expect(flameLevel(null, 100, 200, 300)).toBe(0);
  });
  it('keeps counts and names the exceeded goal above the burning cell', () => {
    const markup = renderToStaticMarkup(<DayGrid weeks={[[99, 100, 101]]} scale={shadeScale([99, 100, 101])} endsOn={Date.UTC(2026, 8, 23)} label="Closed issues" dailyGoal={100} />);
    expect(markup.match(/data-goal-flame/g)).toHaveLength(2);
    expect(markup).toContain('at or over level 1 (100 closed)');
    expect(markup).toContain('class="goal-count">101</span>');
    expect(markup).toContain('viewBox="0 0 40 44"');
    expect(markup).toContain('class="goal-flame" aria-hidden="true"');
  });
  it('uses the chosen cyan for level three in both themes', () => {
    expect(css).toMatch(/:root\s*\{ --goal-flame-level-3: #22d3ee; \}/);
    expect(css).toMatch(/\[data-theme="light"\]\s*\{ --goal-flame-level-3: #087e96; \}/);
    expect(css).toContain('.goal-flame[data-flame-level="3"] { color: var(--goal-flame-level-3); }');
  });
  it('uses the selected 3.6-second ease-in-out cycle with the existing motion range', () => {
    expect(css).toMatch(/animation: goal-burn 3600ms ease-in-out 3;/);
    expect(css).toMatch(/0%, 100% \{ transform: scaleY\(\.93\); \}/);
    expect(css).toMatch(/50% \{ transform: scaleY\(1\.08\); \}/);
  });
  it('resolves Overview goals for all organisations, one organisation, and Crew filters', () => {
    expect(overviewGoalPath(null, false)).toBeNull();
    expect(overviewGoalPath('acme', false)).toBe(teamGoalPath('acme'));
    expect(overviewGoalPath(null, true)).toBeNull();
    expect(overviewGoalPath('acme', true)).toBeNull();
  });
  it('separates personal and organisation reads and removes motion on request', () => {
    expect(personalGoalPath).toBe('/api/goals/personal');
    expect(teamGoalPath('acme')).toBe('/api/goals/organisations/acme');
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*\.goal-flame\s*\{ animation: none;/);
  });
});

it('shows the highest reached level, including exact thresholds, and no flame below level one', () => {
  const markup = renderToStaticMarkup(<DayGrid weeks={[[99, 100, 199, 200, 299, 300, 450]]}
    scale={shadeScale([99, 100, 199, 200, 299, 300, 450])} endsOn={Date.UTC(2026, 8, 23)}
    label="Closed issues" dailyGoal={100} level2Goal={200} level3Goal={300} />);
  expect(markup.match(/data-goal-flame=/g)).toHaveLength(6);
  for (const level of [1, 2, 3]) {
    expect(markup.match(new RegExp(`data-flame-level="${level}"`, 'g'))).toHaveLength(2);
    expect(markup).toContain(`at or over level ${level}`);
  }
});
