import { afterEach, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { installTargets, resolveRouteTarget } from './github-target';
import { GithubTargetState } from './GithubTargetState';
import { parseRoute } from '../route';

afterEach(() => installTargets(undefined));
const owners = [{ id: 7, login: 'one' }, { id: 8, login: 'two' }];
function render(path: string, query: string) {
  const route = parseRoute(path, query);
  let failure = '';
  try { resolveRouteTarget(route); } catch (error) { failure = (error as Error).message; }
  expect(failure).not.toBe('');
  return renderToStaticMarkup(<GithubTargetState route={route} failure={failure} />);
}
it('explains ambiguous names and offers only visible candidates with stable links', () => {
  installTargets({ owners, repositories: [{ id: 42, full_name: 'one/docs' }, { id: 99, full_name: 'two/docs' }] });
  const html = render('/overview', '?repo=docs');
  expect(html).toContain('This link is ambiguous');
  expect(html).toContain('href="/repo/one/docs?repositoryId=42"');
  expect(html).toContain('href="/repo/two/docs?repositoryId=99"');
  expect(html).toContain('Find a repository');
  expect(html).toContain('Go back');
  expect(html).toContain('<h1');
});
it('explains reused names without suggesting the new holder as the old destination', () => {
  installTargets({ owners, repositories: [{ id: 42, full_name: 'one/docs' }] });
  installTargets({ owners, repositories: [{ id: 99, full_name: 'one/docs' }] });
  const html = render('/repo/one/docs', '');
  expect(html).toContain('This name has been reused');
  expect(html).not.toContain('repositoryId=99');
});
it('explains unavailable IDs without leaking or offering a replacement', () => {
  installTargets({ owners, repositories: [{ id: 99, full_name: 'one/docs' }] });
  const html = render('/repo/one/docs', '?repositoryId=42');
  expect(html).toContain('This link is no longer available');
  expect(html).not.toContain('repositoryId=99');
});
it('offers ambiguous repository candidates when a stable owner ID bypasses a reused name', () => {
  const repositories = [{ id: 42, full_name: 'new/docs' }, { id: 99, full_name: 'two/docs' }];
  installTargets({ owners, repositories });
  installTargets({ owners: [{ id: 7, login: 'new' }, { id: 8, login: 'two' }, { id: 9, login: 'one' }], repositories });
  const html = render('/one', '?ownerId=7&repo=docs');
  expect(html).toContain('This link is ambiguous');
  expect(html).toContain('href="/repo/new/docs?repositoryId=42"');
  expect(html).toContain('href="/repo/two/docs?repositoryId=99"');
  expect(html).not.toContain('This name has been reused');
});
it('explains unmatched legacy names in plain words without offering another repository', () => {
  installTargets({ owners, repositories: [{ id: 42, full_name: 'one/docs' }] });
  const html = render('/repo/one/nothere', '');
  expect(html).toContain('This link no longer points anywhere you can open');
  expect(html).not.toContain('repositoryId=42');
});
