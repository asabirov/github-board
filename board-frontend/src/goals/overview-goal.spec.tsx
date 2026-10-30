import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useBoardRead } from '../cache/use-board-read';
import { DayGrid } from '../flow-strip/DayGrid';
import { ColumnSpark } from '../flow-strip/FlowStrip';
import { shadeScale } from '../flow-strip/flow-strip.vm';
import { personalGoalPath, teamGoalPath, useDailyGoal, useOverviewGoal } from './goals';

vi.mock('../cache/use-board-read', () => ({ useBoardRead: vi.fn() }));
const read = vi.mocked(useBoardRead);
beforeEach(() => {
  read.mockReset();
  read.mockReturnValue({ data: { dailyGoal: 100, level2Goal: 200, level3Goal: 300 }, isError: false } as ReturnType<typeof useBoardRead>);
});

function OverviewGoals({ org, filtered = false }: { org: string | null; filtered?: boolean }) {
  const goal = useOverviewGoal(org, filtered);
  return <>
    <DayGrid weeks={[[100, 200, 300]]} scale={shadeScale([100, 200, 300])} endsOn={Date.UTC(2026, 8, 23)} label="Issues closed" {...goal} />
    <ColumnSpark series={[100, 200, 300]} mark={null} title="Daily closures" dailyGoal={goal.dailyGoal} />
  </>;
}

it('hides both indicators and disables the goal read for All GitHub orgs, even with cached goals', () => {
  const html = renderToStaticMarkup(<OverviewGoals org={null} />);
  expect(html).not.toContain('data-goal-flame');
  expect(html).not.toContain('data-daily-goal');
  expect(read).toHaveBeenCalledWith(personalGoalPath, false);
});

it('reads the selected organisation and retains all three flame levels and the goal line', () => {
  const html = renderToStaticMarkup(<OverviewGoals org="acme" />);
  expect(read).toHaveBeenCalledWith(teamGoalPath('acme'), true);
  for (const level of [1, 2, 3]) expect(html).toContain(`data-flame-level="${level}"`);
  expect(html).toContain('data-daily-goal="100"');
});

it('keeps person-filtered Overview goals disabled', () => {
  const html = renderToStaticMarkup(<OverviewGoals org="acme" filtered />);
  expect(html).not.toContain('data-goal-flame');
  expect(html).not.toContain('data-daily-goal');
  expect(useOverviewGoal('acme', true).goalNote).toBe('Clear the person filter to see flame levels.');
  expect(read).toHaveBeenCalledWith(personalGoalPath, false);
});

it('shows no flame note for All GitHub orgs with a person filter', () => {
  const html = renderToStaticMarkup(<OverviewGoals org={null} filtered />);
  expect(useOverviewGoal(null, true).goalNote).toBeUndefined();
  expect(html).not.toContain('data-goal-flame');
  expect(html).not.toContain('data-daily-goal');
  expect(read).toHaveBeenCalledWith(personalGoalPath, false);
});

it('keeps the personal goal read available to My work', () => {
  expect(useDailyGoal(personalGoalPath)).toMatchObject({ dailyGoal: 100, level2Goal: 200, level3Goal: 300 });
  expect(read).toHaveBeenCalledWith(personalGoalPath, true);
});
