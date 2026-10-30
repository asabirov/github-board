/**
 * The one markdown renderer the issue surface has (#235, #340, #426, #468).
 *
 * It lived inside `IssuePage.tsx` until #693, which needed a second caller: a
 * comment composer's PREVIEW has to show exactly what the thread will show once
 * the comment is posted. A preview built on its own ReactMarkdown call would
 * agree on the day it was written and drift the first time a plugin, an override
 * or a `.pj-md` rule moved here and not there — so both draw through this one.
 *
 * The move changed nothing about what it renders. Styling stays the caller's:
 * this emits elements, and the `.pj-md` class on the wrapper decides how they
 * read.
 */
import { Children, cloneElement, isValidElement, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isTaskListItem, taskLineOf } from './body-tasks';
import { githubRefs, type RemarkPlugins, type RepoRef } from './github-refs';

/** A body checkbox toggle: the task's 1-based SOURCE LINE, its new checked state. */
export type ToggleTask = (line: number, checked: boolean) => void;

/** GitHub-flavored markdown, plus Github's reference preprocessing.
 *  react-markdown is CommonMark-only by default, so remark-gfm is what turns
 *  tables, task lists, strikethrough and autolinks from raw `| a | b |` text
 *  into real elements (#340); githubRefs adds what GFM has no notion of —
 *  `#123`, `owner/repo#123`, `@login` (#468), resolved against the issue's OWN
 *  repository. Styling lives in `.pj-md`. */
function usePlugins(here: RepoRef): RemarkPlugins {
  return useMemo(
    () => [remarkGfm, [githubRefs, { owner: here.owner, repo: here.repo }]],
    [here.owner, here.repo],
  );
}

export function Markdown({ children, here, onToggleTask }: {
  children: string; here: RepoRef; onToggleTask?: ToggleTask;
}) {
  const plugins = usePlugins(here);

  // Read-only render (comments, and the body for a reader): remark-gfm already
  // emits disabled checkboxes, styled as status glyphs by `.pj-md`.
  if (!onToggleTask) return <ReactMarkdown remarkPlugins={plugins}>{children}</ReactMarkdown>;

  // Writer's body (#426): make each task checkbox a live control, driven entirely
  // off react-markdown's OWN nodes so "what is a checkbox" is the renderer's
  // verdict, never a regex re-count. We override `li` (not `input`, whose node
  // carries no position): a task list-item's node gives the authoritative 1-based
  // SOURCE LINE, and its rendered checkbox child carries the GFM-parsed `checked`.
  // The fenced/indented `- [ ]` fakes never produce a task `li`, so they're never
  // wired; a `> - [ ]` blockquote task is a real `li` and IS wired — both matching
  // the render exactly.
  const components: Components = {
    li(props) {
      const line = isTaskListItem(props.node) ? taskLineOf(props.node) : null;
      if (line == null) return <li className={props.className}>{props.children}</li>;
      const kids = Children.map(props.children, (child) =>
        isValidElement<{ type?: string; checked?: boolean }>(child) && child.props.type === 'checkbox'
          ? cloneElement(child as React.ReactElement<Record<string, unknown>>, {
              // #439: key the input by its checked state so a toggle REMOUNTS a
              // fresh checkbox with the right initial `checked`, instead of
              // mutating a live controlled input — which could get stuck showing
              // the old state after an optimistic flip in some prod-build/browser
              // reconciliations (the write always persisted; only the box reverted).
              key: `task-${line}-${child.props.checked ? 'x' : 'o'}`,
              disabled: false,
              className: 'pj-task-editable',
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => onToggleTask(line, e.currentTarget.checked),
            })
          : child,
      );
      return <li className={props.className}>{kids}</li>;
    },
  };
  return <ReactMarkdown remarkPlugins={plugins} components={components}>{children}</ReactMarkdown>;
}
