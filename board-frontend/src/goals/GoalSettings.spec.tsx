import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GoalEditor, OrganisationGoalsView } from './GoalSettings';
import { ACCOUNT_SECTIONS } from '../account/sections';
import { useBoardRead } from '../cache/use-board-read';

vi.mock('../cache/use-board-read', () => ({ useBoardRead: vi.fn() }));
const read = vi.mocked(useBoardRead);
beforeEach(() => {
  read.mockReset();
  read.mockReturnValue({ data: { dailyGoal: 123, level2Goal: 234, level3Goal: 345, editable: true }, isPending: false } as ReturnType<typeof useBoardRead>);
});
describe('goal settings scope', () => {
  it('keeps Preferences as the account settings entry without a separate goals section', () => {
    expect(ACCOUNT_SECTIONS.map(section => section.id)).toContain('preferences');
    expect(ACCOUNT_SECTIONS.map(section => section.label)).not.toContain('Personal goals');
  });
  it('shows loading and read failure before offering a goal field', () => {
    read.mockReturnValue({ isPending: true } as ReturnType<typeof useBoardRead>);
    expect(renderToStaticMarkup(<GoalEditor path="/api/goals/personal" />)).toContain('Loading flame levels…');
    read.mockReturnValue({ isPending: false } as ReturnType<typeof useBoardRead>);
    const html = renderToStaticMarkup(<GoalEditor path="/api/goals/personal" />);
    expect(html).toContain('Couldn’t read the flame levels. Try again.');
    expect(html).toContain('Try again</button>');
    expect(html).not.toContain('Save levels');
  });
  it('reads the sidebar organisation without an additional picker', () => {
    const html = renderToStaticMarkup(<OrganisationGoalsView org="second-team" />);
    expect(read).toHaveBeenCalledWith('/api/goals/organisations/second-team');
    expect(html).toContain('second-team');
    expect(html).toContain('value="123"');
    expect(html).not.toContain('<select');
  });
  it('makes no organisation request in all-organisations scope', () => {
    expect(renderToStaticMarkup(<OrganisationGoalsView org={null} />)).toContain('Select an organisation in the sidebar.');
    expect(read).not.toHaveBeenCalled();
  });
  it('disables the levels for readers and says why in a tooltip', () => {
    read.mockReturnValue({ data: { dailyGoal: 123, level2Goal: 234, level3Goal: 345, editable: false }, isPending: false } as ReturnType<typeof useBoardRead>);
    const html = renderToStaticMarkup(<OrganisationGoalsView org="acme" />);
    expect(html.match(/<input[^>]*disabled=""/g)).toHaveLength(3);
    expect(html).toContain('class="flame-setting-fields" tabindex="0"');
    expect(html).not.toContain('Save levels');
  });
  it('edits the personal goal through the shared editor', () => {
    const html = renderToStaticMarkup(<GoalEditor path="/api/goals/personal" />);
    expect(read).toHaveBeenCalledWith('/api/goals/personal');
    expect(html).not.toContain('Save levels');
    expect(html.match(/class="flame-setting-cell"/g)).toHaveLength(3);
  });
});

it('renders all three separately labelled thresholds from the saved settings', () => {
  const html = renderToStaticMarkup(<GoalEditor path="/api/goals/personal" />);
  expect(html.match(/type="number"/g)).toHaveLength(3);
  for (const value of [123, 234, 345]) expect(html).toContain(`value="${value}"`);
  for (const colour of ['Yellow', 'Red', 'Cyan']) expect(html).toContain(`${colour}<span class="sr-only"> flame, issues closed per day`);
  expect(html).not.toContain('aria-describedby');
});
