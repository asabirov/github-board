import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSearch, subscribeToHistory } from './location-search';

const add = vi.fn();
const remove = vi.fn();

beforeEach(() => {
  add.mockClear();
  remove.mockClear();
  (globalThis as unknown as { window: unknown }).window = {
    location: { pathname: '/team', search: '?assignee=octocat' },
    addEventListener: add,
    removeEventListener: remove,
  };
});
afterEach(() => { delete (globalThis as unknown as { window?: unknown }).window; });

describe('the URL as a render-time read (#461)', () => {
  it('reads the search off `location` rather than off anything held', () => {
    expect(readSearch()).toBe('?assignee=octocat');
    (globalThis as unknown as { window: { location: { search: string } } }).window.location.search = '';
    expect(readSearch()).toBe('');
  });

  it('subscribes to popstate and unsubscribes the SAME listener — a subscriber whose '
    + 'identity changed per render would resubscribe on every keystroke in the '
    + 'queue’s search box', () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeToHistory(onChange);
    expect(add).toHaveBeenCalledWith('popstate', onChange);
    unsubscribe();
    expect(remove).toHaveBeenCalledWith('popstate', onChange);
  });

  it('hands back a teardown that really unsubscribes — a no-op returned from here '
    + 'would leave a listener behind on every unmount, and nothing else in the app '
    + 'would ever notice', () => {
    const first = vi.fn();
    const second = vi.fn();
    subscribeToHistory(first)();
    subscribeToHistory(second);
    expect(remove.mock.calls).toEqual([['popstate', first]]);
    expect(add.mock.calls).toEqual([['popstate', first], ['popstate', second]]);
  });
});
