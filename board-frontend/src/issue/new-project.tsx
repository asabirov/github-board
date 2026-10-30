/** Project creation dialog with duplicate-name and failure recovery. */
import { useId, useRef, useState, type RefObject } from 'react';
import { Button, Input, Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/kit';
import { ApiError } from '../api/core';
import { ProjectCreateError, type MadeProject } from '../api/issues';
import type { ProjectCatalogEntry } from '../api/projects';
import type { Me } from '../use-me';
/** The Github App permission that covers an organization's Projects v2 boards. */
const ORG_PROJECTS = 'organization_projects';

/**
 * Whether the board's Github App, as installed on `owner`, may write that
 * owner's projects (#982). A person's write goes out on their own token through
 * that App (#892), so an installation granting less than `write` refuses every
 * create, and `/api/auth/me` already carries each installation's grants.
 *
 * It covers the create's READ as well as its write, and that was worth checking
 * rather than assuming (#1057): the service reads the owner's `projectsV2`
 * before it makes anything, which wants `organization_projects` at READ, and
 * `write` on a Github App installation is read and write. So the one grant this
 * asks about is the one both halves need, and there is no permission the read
 * wants that this does not see.
 *
 * It says no only on evidence. No session, no installation list (a service from
 * before #892 sends none), no installation on this owner, and a personal
 * account, which no App permission covers, all answer yes, and the capability
 * verdict and Github decide. In those it predicts nothing, and a refusal of that
 * read is what withdraws the entry — the service classifies it now, so the
 * registry learns it and the next `/api/auth/me` carries it.
 */
export function appMayWriteProjects(me: Me | null, owner: string): boolean {
  const install = me?.github?.installations?.find((i) => i.account.login.toLowerCase() === owner.toLowerCase());
  if (!install || install.account.type !== 'Organization') return true;
  // A suspended installation is a consent still held that grants nothing.
  if (install.suspended) return false;
  const grant = install.permissions[ORG_PROJECTS];
  return grant === 'write' || grant === 'admin';
}

/** The page's hint that the owner already has a board by `title`: the boards
 *  the catalog it holds lists, compared as the service compares, with case and
 *  the spaces round it ignored. The service decides, against Github's own
 *  search. A board with no owner recorded counts, because a service from before
 *  #697 sends none and every board there is the one org's. */
export function projectTitleTaken(
  title: string,
  catalog: readonly ProjectCatalogEntry[],
  owner: string,
): ProjectCatalogEntry | null {
  const wanted = title.trim().toLowerCase();
  if (!wanted) return null;
  const ours = (c: ProjectCatalogEntry) => !c.org || c.org.toLowerCase() === owner.toLowerCase();
  return catalog.find((c) => ours(c) && c.title.trim().toLowerCase() === wanted) ?? null;
}

/** Why a new project did not happen. */
export interface CreateFailure {
  sentence: string;
  /** The project the failure is about, where the service named one. */
  project: MadeProject | null;
  /** Whether putting the issue on `project` could work now: the name was taken
   *  by it, or Github could not be reached. After a refusal the same add is
   *  refused again, so the page links to the project instead. */
  retryAdd: boolean;
  /** Whether pressing Create again, with this name, could work. True only where
   *  the board could not reach Github, or read what it answered: those pass.
   *  False for everything a second identical press meets again — a refusal, a
   *  name this owner has taken, writes switched off, a name the board would not
   *  accept — and the button goes with it, because a sentence saying the board
   *  is not allowed to do this, over a button offering to do it again, is the
   *  page disagreeing with itself. Editing the name clears the failure and arms
   *  it, which is the way out of every one of them that has a way out. */
  retry: boolean;
}

const TRY_AGAIN = 'Couldn’t make the project. Try again.';
/** The project exists and the issue is not on it: the exact negation of
 *  `AT_REST`, which is what the same line said a moment earlier. */
const MADE_NOT_ADDED = 'The project was made, but this issue wasn’t added to it.';

/**
 * What a person reads when the create fails. Every failure the service names a
 * project in is said here in the page's own words, because the page has the
 * project: the service's sentence for those two carries an offer the button
 * below already makes, or a tail with no length to it (#1072). The rest read
 * the reason first and the status second, the order the close dialog reads them
 * in, for the reason it gives, and an answer this page has no sentence for
 * still prints what the service said.
 *
 * `onIssue` is the boards the issue is already on. A taken name that belongs to
 * one of them is not something to add the issue to.
 */
export function createFailure(err: unknown, owner: string, onIssue: readonly string[] = []): CreateFailure {
  const project = err instanceof ProjectCreateError ? err.project : null;
  const say = (sentence: string, retryAdd = false, retry = false): CreateFailure => ({ sentence, project, retryAdd, retry });
  // An answer the page could not read at all: nothing here says the press was
  // refused, so it is the one case a second press is still worth offering.
  if (!(err instanceof ApiError)) return say(TRY_AGAIN, false, true);
  if (project && err.status === 409 && onIssue.includes(project.id)) {
    return say(`${owner} already has a project called “${project.title}”, and this issue is on it. Choose another name.`);
  }
  // The same clash on a board this issue is NOT on, said in the page's own
  // words rather than the service's. The service's sentence ends "Choose
  // another name, or add this issue to that project", and the board draws
  // "Add this issue to it" under it, so the offer was made twice and the
  // prose half was what needed a third line of reserved room. This names the
  // clash and stops; the button carries the offer (#1072). It is the only
  // 409 on this route that names a project: the other one, a create already
  // in flight for the same name, carries no project, and the add after a
  // create never answers 409.
  if (project && err.status === 409) {
    return say(`${owner} already has a project called “${project.title}”.`, true);
  }
  // The project was made and the add after it failed. The service's own
  // sentence for this names the project and the owner and then APPENDS the
  // inner failure's message, so what reaches a screen has no length at all:
  // its own spec pins 175 characters for an 11-character title, and the tail
  // grows with whatever Github or the refusal classifier said. No reservation
  // holds that, and reserving for it costs every reader who never sees it. So
  // the page says this one itself, the way it says a taken name, and the
  // sentence quotes nothing: the name is still in the field above it and the
  // owner belongs to the issue. What was made is on offer below it, as the
  // add where that could work and as Github's page for it where it could not
  // (`FailureOffer`): the same offer, made once.
  //
  // The service's sentence is not thrown away. It is the only place the reason
  // the add failed is written down on this side, so it goes to the console for
  // whoever is looking at one.
  if (project && err.serverMessage) {
    console.warn(`new project: ${err.serverMessage}`);
    return say(MADE_NOT_ADDED, err.status === 409 || err.status === 502 || err.reason === 'try-again');
  }
  if (err.reason === 'not-permitted-yet') return say('This needs GitHub authorization before the board can make a project here.');
  if (err.reason === 'try-again') return say('Couldn’t reach GitHub. Try again in a moment.', false, true);
  // Two answers are 503: writes switched off, which the envelope says in so many
  // words, and a Github quota cooldown, which passes with time.
  if (err.status === 503) {
    const off = /writes are disabled/i.test(err.serverMessage ?? '');
    return say(
      off ? 'Issue writes are turned off right now.' : 'GitHub isn’t answering the board right now. Try again in a few minutes.',
      false,
      !off,
    );
  }
  // The route asks for two writes, so a refusal may be of either. This is true of both.
  if (err.status === 403) return say(`The board isn’t allowed to do this in ${owner}.`);
  if ((err.status === 400 || err.status === 409) && err.serverMessage) return say(err.serverMessage);
  if (err.status === 404) return say('GitHub couldn’t find this issue or its owner.');
  // A status nobody here has a sentence for. The sentence asks for another
  // press, so the button has to allow one.
  return say(TRY_AGAIN, false, true);
}

const NOTE = 'min-h-[2lh] max-sm:min-h-[3lh] text-[12px] leading-[1.5]';
const ACTION = 'cursor-pointer font-medium text-accent hover:underline';
const LINK = 'font-medium text-accent text-link';

/** A project as the add block's catalog holds a board. */
export const asEntry = (p: MadeProject): ProjectCatalogEntry => ({ id: p.id, number: p.number, title: p.title, org: p.owner });

/** What a failure offers after its sentence: the add, where it could work, or
 *  else Github's page for a project that exists and is not on the issue. */
function FailureOffer({
  failure,
  onIssue,
  onAdd,
}: {
  failure: CreateFailure;
  onIssue: readonly string[];
  onAdd: (entry: ProjectCatalogEntry) => void;
}) {
  const p = failure.project;
  if (!p || onIssue.includes(p.id)) return null;
  if (failure.retryAdd) {
    return (
      <>
        {' '}
        <button type="button" className={ACTION} onClick={() => onAdd(asEntry(p))}>
          Add this issue to it
        </button>
      </>
    );
  }
  if (!p.url) return null;
  return (
    <>
      {' '}
      <a href={p.url} target="_blank" rel="noreferrer" className={LINK}>
        Open it on GitHub
      </a>
    </>
  );
}

export const AT_REST = 'Made on GitHub, with this issue on it.';

export function createBlocked({
  title,
  taken,
  saving,
  failure,
}: {
  title: string;
  taken: ProjectCatalogEntry | null;
  saving: boolean;
  failure: CreateFailure | null;
}): boolean {
  // A failure that a second identical press would meet again disarms Create
  // (`CreateFailure.retry`). Typing clears the failure, which arms it back.
  return !title.trim() || taken != null || saving || failure?.retry === false;
}

export function NewProjectFields({
  owner,
  title,
  taken,
  failure,
  saving,
  inputId,
  noteId,
  formId,
  onIssue = [],
  onTitle,
  onSubmit,
  onCancel,
  onAdd,
}: {
  owner: string;
  title: string;
  /** A board of this owner that already has the name typed. */
  taken: ProjectCatalogEntry | null;
  failure: CreateFailure | null;
  saving: boolean;
  inputId: string;
  /** The status line describing the name field. */
  noteId: string;
  /** Ties the footer's Create to this form, so Enter in the field and the press
   *  are one submit. */
  formId: string;
  /** The boards the issue is already on, which are never offered to add it to. */
  onIssue?: readonly string[];
  onTitle: (title: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  /** Put the issue on a project that exists, through the add that is already there. */
  onAdd: (entry: ProjectCatalogEntry) => void;
}) {
  const blocked = createBlocked({ title, taken, saving, failure });
  return (
    <>
      <form
        id={formId}
        data-new-project=""
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked) onSubmit();
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Project name
        </label>
        <Input
          id={inputId}
          autoFocus
          aria-describedby={noteId}
          value={title}
          placeholder="Project name"
          disabled={saving}
          onChange={(e) => onTitle(e.currentTarget.value)}
        />
        {/* Keep status in one live region as the name or result changes. */}
        <p
          id={noteId}
          aria-live="polite"
          className={`${NOTE} ${failure ? 'text-danger' : 'text-dim'}`}
        >
          {taken && onIssue.includes(taken.id) ? (
            <>This issue is already on “{taken.title}”.</>
          ) : taken ? (
            <>
              {owner} already has a project called “{taken.title}”.{' '}
              <button type="button" className={ACTION} onClick={() => onAdd(taken)}>
                Add this issue to it
              </button>
            </>
          ) : failure ? (
            <>
              {failure.sentence}
              <FailureOffer failure={failure} onIssue={onIssue} onAdd={onAdd} />
            </>
          ) : (
            AT_REST
          )}
        </p>
      </form>
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" form={formId} disabled={blocked}>
          {saving ? 'Creating…' : 'Create project'}
        </Button>
      </div>
    </>
  );
}

/** Keep the name and recovery offers in the dialog when creation fails, and when a press lands outside it. */
export function NewProjectForm({ owner, catalog, onIssue, create, onAdd, onCancel, trigger }: {
  trigger: RefObject<HTMLButtonElement | null>;
  owner: string;
  catalog: readonly ProjectCatalogEntry[];
  onIssue: readonly string[];
  create: (title: string) => Promise<void>;
  onAdd: (entry: ProjectCatalogEntry) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<CreateFailure | null>(null);
  const sending = useRef(false);
  const id = useId();
  const submit = () => {
    if (sending.current) return;
    sending.current = true;
    setSaving(true);
    setFailure(null);
    create(title.trim()).catch((err: unknown) => {
      sending.current = false;
      setFailure(createFailure(err, owner, onIssue));
      setSaving(false);
    });
  };
  /*
   * A press outside does not dismiss this, so a half-typed name survives one.
   * The inline form this replaced kept the name through a stray click on
   * purpose, and #1094's acceptance row still asks for that. #1200 asked for
   * the form to live in a dialog; it did not ask
   * for typed work to be thrown away by a click that landed on the scrim.
   * Cancel, Escape and the corner mark dismiss it, and each of those three is a
   * press aimed at closing the thing.
   *
   * `onInteractOutside` is the one hook covering both ways Radix dismisses from
   * outside, the pointer press and focus leaving the layer, and the kit spreads
   * it straight onto `DialogPrimitive.Content`. Preventing it leaves the
   * overlay, the scroll lock and the focus trap as they are: what changes is
   * only whether a press on the scrim reads as an instruction to close.
   *
   * What the press does still do is move focus to `<body>`: the overlay takes
   * none, and Radix's focus scope leaves a press on an unfocusable thing alone
   * on purpose. Cancelling that as well was tried and does not work — for a
   * mouse pointer Chrome fires the compatibility `mousedown` whatever
   * `pointerdown` says, and it is that event which moves focus. The dialog is
   * still the only live layer: Escape and Tab both reach it, and the name is
   * still in the field. `check-new-project-modal.mjs` reads all three.
   */
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !sending.current) onCancel(); }}>
      <DialogContent showClose={!saving} aria-describedby={`${id}-note`}
        onInteractOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          if (!trigger.current) return;
          event.preventDefault();
          trigger.current.focus();
        }}
      >
        <DialogHeader><DialogTitle>New project</DialogTitle></DialogHeader>
        <NewProjectFields owner={owner} title={title}
          taken={projectTitleTaken(title, catalog, owner)} failure={failure} saving={saving}
          inputId={`${id}-name`} noteId={`${id}-note`} formId={`${id}-form`}
          onIssue={onIssue} onTitle={(next) => { setTitle(next); setFailure(null); }}
          onSubmit={submit} onCancel={onCancel} onAdd={onAdd}
        />
      </DialogContent>
    </Dialog>
  );
}
