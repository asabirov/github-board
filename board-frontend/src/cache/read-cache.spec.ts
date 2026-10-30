import { beforeEach, expect, it } from 'vitest';
import { claimFor, forgetPayloads, setPayloadStore } from './payload-cache';
import { beginHintPreview, finishHintPreview } from '../auth/session-hint';
import { setResponseIdentity, tagResponse, copyResponseDeadline, responseExpired, subscribeResponseChanges } from '../auth/response-deadline';
import { readClient, rememberRead, readValue, readKey, forgetRead, clearSavedReads, persistableRead } from './read-cache';

beforeEach(() => {
  finishHintPreview(false);
  const data = new Map<string, string>();
  setPayloadStore({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); }, key: i => [...data.keys()][i] ?? null, get length() { return data.size; } });
  forgetPayloads();
  claimFor('alice@example.test', 'a'.repeat(64), 'scope');
  setResponseIdentity('scope', true);
});
const path = '/api/new-page/never-listed';
const headers = new Headers();
it('caches a new endpoint by default without adding a payload key', () => {
  rememberRead(path, { count: 7 }, headers);
  expect(readValue(readClient.getQueryData(readKey(path)))).toEqual({ count: 7 });
  expect(persistableRead(readClient.getQueryCache().find({ queryKey: readKey(path) })!)).toBe(true);
});
it('uses response no-store policy instead of an endpoint allowlist', () => {
  rememberRead(path, { count: 7 }, new Headers({ 'Cache-Control': 'private, no-store' }));
  expect(persistableRead(readClient.getQueryCache().find({ queryKey: readKey(path) })!)).toBe(false);
});
it('a different person, and a different session for the same person, wipe queries', () => {
  for (const [owner, hint] of [['bob@example.test', 'a'.repeat(64)], ['bob@example.test', 'b'.repeat(64)]] as const) {
    rememberRead(path, { count: 7 }, headers);
    claimFor(owner, hint, 'scope');
    expect(readClient.getQueryCache().getAll()).toHaveLength(0);
  }
});

/**
 * ARTUR'S DECISION ON #1395, recorded on the issue: when Github reports
 * different access for the SAME person, their own last answer stays on their own
 * screen until a live read refuses it.
 *
 * Both halves are here because the second is what makes the first safe. The
 * copy is drawn under the key it was really issued under — `supersedeVisibility`
 * records that one key, nothing is re-tagged and nothing is forged — and the
 * live read that follows carries its own authorization, so a refusal takes it.
 *
 * The browser guard drives the same sequence mounted, with the queue read held
 * for ten seconds (`scripts/check-session-hint.mjs`).
 */
it('keeps the same person’s sensitive answer when only the access check moved', () => {
  const value = tagResponse({ count: 7 }, { expiresAt: Date.now() + 60_000, visibilityKey: 'scope' });
  rememberRead(path, value, headers);
  claimFor('alice@example.test', 'a'.repeat(64), 'moved');
  setResponseIdentity('moved', true);
  expect(readValue(readClient.getQueryData(readKey(path))), 'drawn under the key it was issued under').toEqual({ count: 7 });
  expect(persistableRead(readClient.getQueryCache().find({ queryKey: readKey(path) })!), 'and still worth keeping').toBe(true);
});
it('and only one key back: a second move leaves the first behind', () => {
  const value = tagResponse({ count: 7 }, { expiresAt: Date.now() + 60_000, visibilityKey: 'scope' });
  rememberRead(path, value, headers);
  claimFor('alice@example.test', 'a'.repeat(64), 'moved');
  setResponseIdentity('moved', true);
  claimFor('alice@example.test', 'a'.repeat(64), 'moved-again');
  setResponseIdentity('moved-again', true);
  expect(readValue(readClient.getQueryData(readKey(path)))).toBeNull();
});
it('and a live refusal is what ends it', () => {
  const value = tagResponse({ count: 7 }, { expiresAt: Date.now() + 60_000, visibilityKey: 'scope' });
  rememberRead(path, value, headers);
  claimFor('alice@example.test', 'a'.repeat(64), 'moved');
  setResponseIdentity('moved', true);
  forgetRead(path);
  expect(readValue(readClient.getQueryData(readKey(path)))).toBeNull();
});
it('refusal clears a successful read instead of replacing it with a failure body', () => {
  rememberRead(path, { count: 7 }, headers);
  forgetRead(path);
  expect(readValue(readClient.getQueryData(readKey(path)))).toBeNull();
});
it('a downloaded answer survives its old deadline before and after the hint preview', () => {
  const value = tagResponse({ count: 7 }, { expiresAt: Date.now() - 1, visibilityKey: 'scope' });
  // A stored answer can outlive its lease; the preview is explicitly read-only.
  rememberRead(path, value, headers);
  const entry = readClient.getQueryData(readKey(path));
  expect(readValue(entry)).toEqual({ count: 7 });
  beginHintPreview({ hintId: 'a'.repeat(64) }, `board_session_hint=${encodeURIComponent(JSON.stringify({ id: 'a'.repeat(64), visibilityKey: 'scope' }))}`);
  expect(readValue(entry)).toEqual({ count: 7 });
  finishHintPreview(true);
  expect(readValue(entry)).toEqual({ count: 7 });
});
it('null is absence, not a cached zero or an empty successful result', () => {
  rememberRead(path, null, headers);
  expect(readValue(readClient.getQueryData(readKey(path)))).toBeNull();
  expect(readClient.getQueryCache().getAll()).toHaveLength(0);
});
it('does not write sensitive copies that a returning browser cannot preview', () => {
  claimFor('alice@example.test', undefined, 'scope');
  const value = tagResponse({ count: 7 }, { expiresAt: Date.now() + 60000, visibilityKey: 'scope' });
  rememberRead(path, value, headers);
  expect(persistableRead(readClient.getQueryCache().find({ queryKey: readKey(path) })!)).toBe(false);
  claimFor('alice@example.test', 'a'.repeat(64), 'scope');
  expect(persistableRead(readClient.getQueryCache().find({ queryKey: readKey(path) })!)).toBe(true);
});

it('a refusal invalidates held rows and derived copies, but not an unrelated response', () => {
  const lease = { expiresAt: Date.now() + 60_000, visibilityKey: 'scope' };
  const value = tagResponse({ projects: [{ name: 'Private board' }] }, lease);
  const held = value.projects[0];
  const derived = copyResponseDeadline(held, { label: held.name });
  const unrelated = tagResponse({ title: 'Other read' }, { ...lease });
  rememberRead(path, value, headers);
  let notified = false;
  const stop = subscribeResponseChanges(() => { notified = responseExpired(held); });
  try {
    forgetRead(path);
    expect(notified).toBe(true);
    expect(responseExpired(held)).toBe(true);
    expect(responseExpired(derived)).toBe(true);
    expect(responseExpired(unrelated)).toBe(false);
    const replacement = tagResponse({ projects: [] }, { ...lease });
    rememberRead(path, replacement, headers);
    expect(responseExpired(replacement)).toBe(false);
    expect(responseExpired(held)).toBe(true);
  } finally { stop(); }
});

it('removing saved fallbacks after a catalog refusal leaves an independent live rollup alone', () => {
  const lease = { expiresAt: Date.now() + 60_000, visibilityKey: 'scope' };
  const rollup = tagResponse({ projects: [{ name: 'Rollup' }] }, { ...lease });
  const catalog = tagResponse([{ title: 'Catalog' }], { ...lease });
  rememberRead('/api/projects', rollup, headers);
  rememberRead('/api/projects/preview', catalog, headers);
  forgetRead('/api/projects/preview');
  clearSavedReads();
  expect(responseExpired(catalog)).toBe(true);
  expect(responseExpired(rollup)).toBe(false);
  expect(readValue(readClient.getQueryData(readKey('/api/projects')))).toBeNull();
});
