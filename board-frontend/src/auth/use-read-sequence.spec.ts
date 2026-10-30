import { expect, it } from 'vitest';
import { createReadSequence } from './use-read-sequence';

it('accepts a slow authorized response while its replacement is still pending', () => {
  const reads = createReadSequence();
  const slow = reads.begin();
  const replacement = reads.begin();
  expect(slow()).toBe(true);
  expect(replacement()).toBe(true);
});

it('a newer settlement prevents an older success from restoring data', () => {
  const reads = createReadSequence();
  const old = reads.begin();
  const newer = reads.begin();
  expect(newer()).toBe(true);
  expect(old()).toBe(false);
  expect(newer()).toBe(false);
});

it('never revives callbacks after leaving and returning to the same scope', () => {
  const firstVisit = createReadSequence();
  const old = firstVisit.begin();
  firstVisit.dispose();
  const secondVisit = createReadSequence();
  expect(secondVisit.begin()()).toBe(true);
  expect(old()).toBe(false);
});

it('keeps independently served health and row responses independent', () => {
  const rows = createReadSequence();
  const health = createReadSequence();
  const slowHealth = health.begin();
  expect(rows.begin()()).toBe(true);
  expect(rows.begin()()).toBe(true);
  expect(slowHealth()).toBe(true);
});
