import { useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/kit';

/** A focusable explanation that also opens on a tap. */
export function RepoHelp({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return <Tooltip open={open} onOpenChange={setOpen}>
    <TooltipTrigger asChild>
      <button type="button" aria-label={`${label} information`} aria-expanded={open} aria-description={text}
        onClick={(event) => { event.preventDefault(); setOpen(true); }}
        className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-[12px] text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"><svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v1" /></svg></button>
    </TooltipTrigger>
    <TooltipContent side="bottom"><span className="block max-w-[260px]">{text}</span></TooltipContent>
  </Tooltip>;
}
