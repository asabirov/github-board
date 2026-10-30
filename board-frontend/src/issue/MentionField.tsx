import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import type { Actor, IssueEditOptions } from '../api/issues';
import { useBoardRead } from '../cache/use-board-read';
import { usePeople } from '../people-ctx';
import { Avatar } from '../ui/avatar';
import { insertMention, mentionAt, mentionCandidates } from './mentions';
import type { RepoRef } from './github-refs';

export function MentionField({ value, onChange, disabled, className, placeholder, label = placeholder, here, participants }: {
  value: string; onChange: (value: string) => void; disabled: boolean;
  className: string; placeholder: string; label?: string; here: RepoRef; participants: (Actor | null)[];
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const people = usePeople();
  const [selection, setSelection] = useState<[number, number]>([0, 0]);
  const [dismissed, setDismissed] = useState(false);
  const [composing, setComposing] = useState(false);
  const [active, setActive] = useState(0);
  const [requested, request] = useState(false);
  const { data: options } = useBoardRead<IssueEditOptions>(
    `/api/issues/edit-options/${encodeURIComponent(here.owner)}/${encodeURIComponent(here.repo)}`, requested,
  );
  const token = mentionAt(value, ...selection);
  const candidates = mentionCandidates(participants, options?.assignablePeople ?? options?.assignableLogins.map(login => ({ login, name: null })) ?? [], people, token?.query);
  const open = !!token && !dismissed && !composing && !disabled && candidates.length > 0;
  const index = Math.min(active, candidates.length - 1);

  useEffect(() => {
    if (token) request(true);
  }, [!!token]);
  useEffect(() => {
    if (open) list.current?.children[index]?.scrollIntoView({ block: 'nearest' });
  }, [open, index]);

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const caret = pendingCaret.current;
    pendingCaret.current = null;
    field.current?.focus();
    field.current?.setSelectionRange(caret, caret);
    setSelection([caret, caret]);
  }, [value]);

  function updateSelection(target: HTMLTextAreaElement) {
    setSelection([target.selectionStart, target.selectionEnd]);
  }
  function pick(person: Actor) {
    if (!token) return;
    const next = insertMention(value, token, person.login);
    pendingCaret.current = next.caret;
    onChange(next.value);
    setDismissed(true);
  }

  return (
    <div className="relative">
      <textarea
        ref={field} className={className} rows={8} value={value} placeholder={placeholder}
        aria-label={label} autoFocus disabled={disabled}
        role="combobox" aria-autocomplete="list" aria-expanded={open} aria-haspopup="listbox"
        aria-controls={open ? id : undefined} aria-activedescendant={open ? `${id}-${index}` : undefined}
        onChange={e => { onChange(e.currentTarget.value); updateSelection(e.currentTarget); setDismissed(false); setActive(0); }}
        onSelect={e => updateSelection(e.currentTarget)}
        onBlur={() => setDismissed(true)}
        onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing || composing || !open) return;
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(true); }
          else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((index + (e.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length);
          } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
            e.preventDefault(); pick(candidates[index]);
          }
        }}
      />
      {open && (
        <ul ref={list} id={id} role="listbox" aria-label="Mention suggestions"
          className="absolute bottom-full left-0 z-30 mb-1 max-h-60 w-80 max-w-full overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-lg">
          {candidates.map((person, i) => (
            <li key={person.login} id={`${id}-${i}`} role="option" aria-selected={i === index}
              onMouseDown={e => e.preventDefault()} onClick={() => pick(person)} onMouseMove={() => setActive(i)}
              className={`flex min-h-10 cursor-default items-center gap-2 rounded px-2 py-1.5 text-[13px] ${i === index ? 'bg-elevated text-fg' : 'text-dim'}`}>
              <Avatar login={person.login} name={person.name} px={32} showTitle={false} />
              <span className="shrink-0 font-medium">{person.login}</span>
              {person.name && <span className="min-w-0 truncate text-dim">{person.name}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
