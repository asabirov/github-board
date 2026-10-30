import { useRef, useState } from 'react';
import { Button } from '../ui/kit';
import { PageHeading, PAGE_READING } from '../ui/PageHeading';
import { ACCOUNT_RAIL } from '../account/layout';
import { writeFailure } from '../auth/write-failure';
import { saveGoal, teamGoalPath, type Goal, type GoalLevels } from '../api/account';
import { useBoardRead } from '../cache/use-board-read';
import { FlameLevelRows } from './FlameLevelRows';

const fields = ['dailyGoal', 'level2Goal', 'level3Goal'] as const;

export function GoalEditor({ path, team = false }: { path: string; team?: boolean }) {
  const read = useBoardRead<Goal>(path);
  const goal = read.data;
  const [draft, setValue] = useState<Partial<Record<keyof GoalLevels, string>>>({});
  const values = fields.map(field => draft[field] ?? String(goal?.[field] ?? ''));
  const changed = fields.some((field, index) => values[index] !== String(goal?.[field]));
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const queued = useRef<string[] | null>(null);
  const inFlight = useRef<string[] | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(event?: React.FormEvent) {
    event?.preventDefault();
    if (!goal?.editable || (!saving.current && !changed)) return;
    const numbers = values.map(Number);
    if (numbers.some(n => !Number.isInteger(n) || n < 1 || n > 2147483647) || !(numbers[0] < numbers[1] && numbers[1] < numbers[2])) {
      queued.current = null;
      setInvalid(true);
      setError('Enter three positive whole numbers in increasing order.');
      return;
    }
    setInvalid(false); setError(null); setSaved(false);
    queued.current = values;
    if (saving.current) {
      if (values.every((value, index) => value === inFlight.current?.[index])) queued.current = null;
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      while (queued.current) {
        const committed = queued.current;
        inFlight.current = committed;
        queued.current = null;
        const [dailyGoal, level2Goal, level3Goal] = committed.map(Number);
        await saveGoal(path, { dailyGoal, level2Goal, level3Goal });
        // A response can only clear the draft values it actually saved.
        setValue(current => Object.fromEntries(Object.entries(current).filter(([field, value]) => value !== committed[fields.indexOf(field as keyof GoalLevels)])));
      }
      setSaved(true);
    } catch (failure) {
      queued.current = null;
      const reason = writeFailure(failure);
      setInvalid(false);
      setError(reason.serverSaid ?? 'Couldn’t save the flame levels. Reload to check their values before trying again.');
    } finally { saving.current = false; setBusy(false); }
  }

  if (read.isPending) return <p role="status" className="text-sm text-dim">Loading flame levels…</p>;
  if (!goal) return <div><p role="alert" className="mb-3 text-sm text-danger">Couldn’t read the flame levels. Try again.</p><Button variant="outline" onClick={() => void read.refetch()}>Try again</Button></div>;
  return (
    <form onSubmit={submit} aria-busy={busy} noValidate className="flex w-full max-w-md flex-col gap-3">
      <FlameLevelRows values={values} editable={goal.editable} locked={goal.editable ? undefined : team ? 'Admins only' : 'Editing unavailable'} invalid={invalid} error={error}
        onChange={(index, value) => { setValue(current => ({ ...current, [fields[index]]: value })); setSaved(false); setError(null); setInvalid(false); }} onSave={() => void submit()} />
      {error && <p id="flame-levels-error" role="alert" className="text-sm text-danger">{error}</p>}
      {saved && !changed && !error && <p role="status" className="text-sm text-dim">Flame levels saved.</p>}
    </form>
  );
}

export function OrganisationGoalsView({ org }: { org: string | null }) {
  return <div className={ACCOUNT_RAIL}><div className={PAGE_READING}>
    <div className="mb-6"><PageHeading>Organisation settings</PageHeading></div>
    {org ? <>
      <p className="mb-6 text-sm text-dim">{org}</p>
      <GoalEditor key={org} path={teamGoalPath(org)} team />
    </> : <p className="text-sm text-dim">Select an organisation in the sidebar.</p>}
  </div></div>;
}
