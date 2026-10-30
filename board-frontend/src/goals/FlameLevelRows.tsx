import { Input, Label } from '../ui/kit';
import { Tip } from '../ui/Tip';
import { GoalFlame } from './GoalFlame';
import { mixPercent } from '../flow-strip/flow-strip.vm';
import { dayCellPaint } from '../flow-strip/DayGrid';
import './flame-level-rows.css';

const colours = ['Yellow', 'Red', 'Cyan'];
const levels = [1, 2, 3] as const;

type Props = {
  values: string[];
  editable: boolean;
  /** Why the levels are locked, shown as a tooltip on the disabled fields. */
  locked?: string;
  invalid: boolean;
  error: string | null;
  onChange: (index: number, value: string) => void;
  onSave: () => void;
};

function FlameIcon({ index }: { index: number }) {
  return <span className="flame-setting-icon"><GoalFlame level={levels[index]} /></span>;
}

function Cell({ count, thresholds }: { count: number; thresholds: number[] }) {
  const index = thresholds.filter(value => count >= value).length - 1;
  const pct = mixPercent(count, { nonZeroAscending: thresholds });
  return <span style={count === 0 ? { background: 'var(--surface)' } : dayCellPaint(pct)} className="flame-setting-cell" aria-label={`${count} issues closed, ${index < 0 ? 'no flame' : `${colours[index]} flame`}`}>
    {index >= 0 && <GoalFlame level={levels[index]} />}
    <span className={index >= 0 ? 'goal-count' : undefined}>{count}</span>
  </span>;
}

export function FlameLevelRows({ values, editable, locked, invalid, error, onChange, onSave }: Props) {
  const numbers = values.map(Number);
  const valid = numbers.every(n => Number.isInteger(n) && n > 0 && n <= 2147483647) && numbers[0] < numbers[1] && numbers[1] < numbers[2];
  const thresholds = valid ? numbers : [100, 200, 300];
  const input = (index: number) => <Input id={`flame-setting-${index}`} type="number" min={1} max={2147483647} step={1} required
    value={values[index]} disabled={!editable} aria-invalid={invalid} aria-describedby={error ? 'flame-levels-error' : undefined}
    onChange={event => onChange(index, event.target.value)} onBlur={onSave} className="flame-setting-input" />;
  const fields = <div className="flame-setting-fields" tabIndex={locked ? 0 : undefined}>
    {colours.map((colour, index) => <div key={colour} className="flame-setting-field">
      <Label htmlFor={`flame-setting-${index}`} className="flame-setting-label"><FlameIcon index={index} /><span>{colour}<span className="sr-only"> flame, issues closed per day</span></span></Label>
      {input(index)}
      <Cell count={thresholds[index]} thresholds={thresholds} />
    </div>)}
  </div>;
  return <div className="flame-level-rows">
    {locked ? <Tip label={locked}>{fields}</Tip> : fields}
    {invalid && <p className="text-[12.5px] text-dim">Preview uses 100, 200 and 300 until the levels are valid.</p>}
  </div>;
}
