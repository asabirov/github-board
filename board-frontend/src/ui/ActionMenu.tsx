/**
 * The board's one action-menu shell (#446, generalised in #472). It draws a list
 * of actions TWICE — into the right-click `ContextMenu` and into a hover-…
 * `DropdownMenu` — around whatever it wraps, so a surface gets both paths from
 * one component and the two can never drift.
 *
 * It knows nothing about issues. `IssueActions` composes it with the issue action
 * list and the close-confirm; the Repos map composes it with a repo's one action.
 * Anything else that grows a row menu should compose it too rather than reach for
 * the Radix primitives again.
 *
 * Layout is the caller's job, because "where does the … go" means something
 * different per surface: `className` styles the wrapper (which is also the
 * right-click target and the hover `group`), `handleClassName` places the …
 * inside it. Callers reserve the control’s footprint, so no appearance shifts on hover.
 */
import { Fragment, type ComponentType, type ReactNode, type Ref } from 'react';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from './kit';
import { DotsGlyph } from '../icons';
import { HANDLE, HANDLE_MENU, type HandleAppearance } from './action-handle';

/** One row of the menu. `run` is fired on select; `danger` puts it after a
 *  separator in the danger tone (a write that changes existing state).
 *
 *  `separator` is the rule WITHOUT the tone (#752). The issue menu's read
 *  actions and its assign actions differ in kind — one group leaves the issue
 *  untouched, the other changes who owns it — and with the menu's only rule
 *  before `Close issue…`, the assign pair welded onto the copy group and read as
 *  a third copy action on first pass. A group boundary is not a danger warning,
 *  so it does not borrow `danger` to draw one. */
export interface MenuAction {
  key: string;
  label: string;
  danger?: boolean;
  separator?: boolean;
  run: () => void;
}

export function ActionMenu({
  items,
  handle = true,
  handleLabel = 'Actions',
  handleRef,
  menuOpen,
  onMenuOpenChange,
  className = '',
  handleClassName = '',
  appearance = 'quiet',
  children,
}: {
  items: MenuAction[];
  /** Render the hover-… handle. Off leaves right-click as the only path — what a
   *  surface wants when a visible handle on every row would be noise. */
  handle?: boolean;
  /** Accessible name for the … button. */
  handleLabel?: string;
  /** The … button itself, for a caller that has to put focus back on it. The
   *  issue menu's `Assign to…` raises a dialog a frame after this menu has
   *  closed, so Radix's own restore has nothing to give back (#1077 review,
   *  S3); the dialog is handed this and returns the reader here. */
  handleRef?: Ref<HTMLButtonElement>;
  /** Whether the … menu is open. Lifted so the wrapper's children can react to
   *  it (the board card fades its avatar out while the menu covers that corner).
   *
   *  Omit it — do NOT pass `false` — when the caller doesn't need to know: this
   *  is Radix's controlled/uncontrolled switch, so a hard `false` here pins the
   *  menu shut and the … stops responding to click and to Enter/Space, while
   *  right-click still works because that is a different menu. It used to default
   *  to `false`, which made every uncontrolled caller silently dead; the first one
   *  (#462's stat tiles) found it. Undefined = uncontrolled, which is the default
   *  a component like this should have. */
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
  /** Classes for the wrapper — the right-click target and the hover group. */
  className?: string;
  /** Classes that place the … within the wrapper (reserved cell, or absolute). */
  handleClassName?: string;
  /** Which member of the family: `quiet` reserves 24px, `solid` and
   *  `standalone` 44px. `standalone` is a handle with no row around it. */
  appearance?: HandleAppearance;
  children: ReactNode;
}) {
  // How the handle, its chip and the menu look is `action-handle.ts`'s: one
  // table, so the callers cannot drift apart.
  const look = HANDLE[appearance];
  const render = (
    Item: ComponentType<{ onSelect?: (e: Event) => void; className?: string; children: ReactNode }>,
    Separator: ComponentType,
  ) =>
    items.map((it) => (
      <Fragment key={it.key}>
        {(it.separator || it.danger) && <Separator />}
        <Item className={`focus:ring-0 ${it.danger ? 'text-danger focus:bg-danger-fill focus:text-danger' : ''}`} onSelect={() => it.run()}>
          {it.label}
        </Item>
      </Fragment>
    ));

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={`group relative ${className}`}>
          {children}
          {handle && (
            <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  ref={handleRef}
                  aria-label={handleLabel}
                  onClick={(e) => e.stopPropagation()}
                  className={`${look.button} ${handleClassName}`}
                >
                  <span className={look.chip}><DotsGlyph dot={look.dot} pitch={look.pitch} /></span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={HANDLE_MENU}>
                {render(DropdownMenuItem, DropdownMenuSeparator)}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className={HANDLE_MENU}>
        {render(ContextMenuItem, ContextMenuSeparator)}
      </ContextMenuContent>
    </ContextMenu>
  );
}
