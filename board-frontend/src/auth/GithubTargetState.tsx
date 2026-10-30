import { Button } from '../ui/kit';
import { useEffect, useRef } from 'react';
import { ErrorIcon } from './AuthScreen';
import { gotoPath, routePath, walkedHere, type Route } from '../route';
import { boardLinkProps } from '../repos/repo-page-parts';
import { EmptyState } from '../ui/EmptyState';
import { PAGE_H1, PAGE_RAIL } from '../ui/PageHeading';
import { targetRefusal } from './github-target';

export function GithubTargetState({ route, failure }: { route: Route; failure: string }) {
  const state = targetRefusal(route, failure);
  const content = useRef<HTMLElement>(null);
  useEffect(() => {
    const heading = content.current?.querySelector('h1');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }, [state.heading]);
  return (
    <main ref={content} className={`${PAGE_RAIL} py-10`} aria-label="Link unavailable">
      <EmptyState
        className="mx-auto max-w-2xl py-12 [&_h1]:outline-none"
        icon={<ErrorIcon size={16} />}
        titleAs="h1"
        title={<span className={PAGE_H1}>{state.heading}</span>}
        description={state.reason}
        action={
          <div className="flex flex-wrap justify-center gap-3">
            <Button onClick={() => gotoPath('/repos')}>Find a repository</Button>
            <Button variant="outline" onClick={() => walkedHere(window.history.state) ? window.history.back() : gotoPath('/overview')}>Go back</Button>
          </div>
        }
      />
      {state.candidates.length > 0 && (
        <section className="mx-auto mt-6 max-w-2xl" aria-labelledby="github-target-candidates">
          <h2 id="github-target-candidates" className="text-sm font-medium text-dim">Repositories with this name</h2>
          <ul className="mt-2">
            {state.candidates.map(repo => {
              const [owner, name] = repo.full_name.split('/');
              return <li key={repo.id}><a {...boardLinkProps(routePath({ tab: 'repo', repo: { owner, name }, repositoryId: repo.id }))} className="flex min-h-11 items-center break-all py-2 text-sm text-accent text-link">{repo.full_name}</a></li>;
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
