import 'reflect-metadata';
import { expect, it } from 'vitest';
import { HEADERS_METADATA } from '@nestjs/common/constants';
import { IssuesMetricsController } from './issues-metrics.controller';
import { PeopleController } from '../people/people.controller';

const cacheHeader = (handler: object) => (Reflect.getMetadata(HEADERS_METADATA, handler) as { name: string; value: string }[])
  .find(header => header.name.toLowerCase() === 'cache-control')?.value;

it('permits private persistence of queue reads without shared caching', () => {
  for (const handler of [IssuesMetricsController.prototype.mine, IssuesMetricsController.prototype.all]) {
    expect(cacheHeader(handler)).toBe('private, no-cache');
  }
});
it('keeps the search index out of persistence', () => {
  expect(cacheHeader(IssuesMetricsController.prototype.searchIndex)).toBe('no-store');
});

it('keeps the full roster out of HTTP caches and permits only its redacted projection', () => {
  expect(cacheHeader(PeopleController.prototype.list)).toBe('no-store');
  expect(Reflect.getMetadata(HEADERS_METADATA, PeopleController.prototype.list)).toContainEqual({ name: 'X-Board-Persist', value: 'roster-without-aliases' });
});
