import { useBoardRead } from '../cache/use-board-read';
import { personalGoalPath, teamGoalPath, type Goal } from '../api/account';
export { personalGoalPath, teamGoalPath } from '../api/account';

export function overviewGoalPath(org: string | null, filtered: boolean) {
  return org && !filtered ? teamGoalPath(org) : null;
}

export function useDailyGoal(path: string | null) {
  const read = useBoardRead<Goal>(path ?? personalGoalPath, path !== null);
  const failed = path !== null && read.isError;
  return {
    dailyGoal: path !== null && !failed ? read.data?.dailyGoal : null,
    level2Goal: path !== null && !failed ? read.data?.level2Goal : null,
    level3Goal: path !== null && !failed ? read.data?.level3Goal : null,
    goalNote: failed ? 'The flame levels couldn’t be read. Flames are unavailable.' : undefined,
  };
}

export function useOverviewGoal(org: string | null, filtered: boolean) {
  const goal = useDailyGoal(overviewGoalPath(org, filtered));
  return { ...goal, goalNote: org && filtered ? 'Clear the person filter to see flame levels.' : goal.goalNote };
}
