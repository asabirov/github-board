import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { toast } from './kit';
import { flash } from './flash';
import { copyToClipboard } from './clipboard';
import { BoardToaster } from './BoardToaster';
import { EmptyState } from './EmptyState';
import { BotIcon, KeyRoundIcon, MessageIcon } from '../icons';
import { ViewerControls } from '../issues-viewer/ViewerControls';
import { YearSwitch } from '../flow-strip/FlowStrip';

const state = vi.hoisted(() => ({
  resolvedTheme: 'dark',
  toaster: {} as Record<string, unknown>,
  group: {} as { value?: string; onValueChange?: (value: string) => void },
}));
vi.mock('../theme', () => ({ useTheme: () => state }));
vi.mock('./kit', async (original) => ({
  ...await original<typeof import('./kit')>(),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
  Toaster: (props: Record<string, unknown>) => { state.toaster = props; return null; },
  ToggleGroup: ({ children, ...props }: { children: ReactNode }) => {
    state.group = props; return <>{children}</>;
  },
  ToggleGroupItem: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('native toast adapter', () => {
  it('preserves repeated successes and error tone without collapsing calls', () => {
    flash('Copied link'); flash('Copied link'); flash('Denied', 'danger');
    expect(toast).toHaveBeenNthCalledWith(1, 'Copied link');
    expect(toast).toHaveBeenNthCalledWith(2, 'Copied link');
    expect(toast.error).toHaveBeenCalledWith('Denied');
  });
  it('keeps clipboard success and refusal feedback through the adapter', async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await copyToClipboard('url', 'Copied link');
    await copyToClipboard('url', 'Copied link');
    expect(toast).toHaveBeenCalledExactlyOnceWith('Copied link');
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Couldn’t copy');
  });
  it('reports an absent clipboard too', async () => {
    vi.stubGlobal('navigator', {});
    await copyToClipboard('url', 'Copied link');
    expect(toast.error).toHaveBeenCalledWith('Couldn’t copy');
  });
  it('follows the shown theme without replacing the native skin', () => {
    for (const resolvedTheme of ['light', 'dark']) {
      Object.assign(state, { resolvedTheme });
      renderToStaticMarkup(<BoardToaster />);
      expect(state.toaster.theme).toBe(resolvedTheme);
      expect(state.toaster.toastOptions).toBeUndefined();
    }
  });
});

describe('controlled native toggles', () => {
  it('keeps URL-owned view selected on repress and only forwards valid changes', () => {
    const onView = vi.fn();
    renderToStaticMarkup(<ViewerControls group="status" dims={['status']} view="board" showGroup={false} onGroup={() => {}} onView={onView} />);
    expect(state.group.value).toBe('board');
    state.group.onValueChange!('');
    state.group.onValueChange!('other');
    expect(onView).not.toHaveBeenCalled();
    state.group.onValueChange!('list');
    expect(onView).toHaveBeenCalledExactlyOnceWith('list');
  });
  it('encodes trailing year nonempty and rejects deselection or an unavailable year', () => {
    const onChange = vi.fn();
    renderToStaticMarkup(<YearSwitch value={null} years={[2026, 2025]} onChange={onChange} />);
    expect(state.group.value).toBe('trailing');
    for (const value of ['', '2000', 'no-year']) state.group.onValueChange!(value);
    expect(onChange).not.toHaveBeenCalled();
    state.group.onValueChange!('2025');
    state.group.onValueChange!('trailing');
    expect(onChange.mock.calls).toEqual([[2025], [null]]);
  });
});

describe('native empty state compatibility', () => {
  it.each([KeyRoundIcon, BotIcon, MessageIcon])('retains supplied SVG content, rich copy and the caller action', (Icon) => {
    const html = renderToStaticMarkup(<EmptyState icon={<Icon size={16} />} title="Nothing yet" description={<>Use <code>Board</code> to begin</>} action={<button>Start</button>} />);
    expect(html).toContain('viewBox="0 0 16 16"');
    expect(html).toMatch(/<(path|circle|rect)\b/);
    expect(html).toContain('<code>Board</code>');
    expect(html).toContain('<button>Start</button>');
  });
  it('does not invent an icon or action for an iconless state', () => {
    const html = renderToStaticMarkup(<EmptyState title="Not available" description="Choose another scope" />);
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<button');
    expect(html).toContain('Choose another scope');
  });
});
