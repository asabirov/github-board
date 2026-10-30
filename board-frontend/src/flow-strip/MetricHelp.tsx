import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/kit';
import { useId, useState, type ReactNode } from 'react';

/** Click keeps the explanation open on touch; focus and hover also reveal it. */
export function MetricHelp({ label = 'Metric details', children, align = 'right', compact = false }: { label?: string; children: ReactNode; align?: 'left' | 'right'; compact?: boolean }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
    <button type="button" aria-label={label} aria-expanded={open} aria-describedby={open ? id : undefined}
      className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[12px] text-muted focus-visible:outline-2"
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)}
      onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v1" /></svg></button>
    {open && <span id={id} role="tooltip" className={`absolute ${align === 'left' ? 'left-0' : 'right-0'} top-full z-50 ${compact ? 'w-max' : 'w-[260px]'} max-w-[75vw] rounded-md bg-elevated p-3 text-[12px] font-normal text-fg shadow-md`}>{children}</span>}
  </span>;
}

/** Figures expose their explanation without adding a separate info control. */
export function MetricFigure({ label, description, children }: {
  label: string;
  description: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} aria-expanded={open}
          className="inline-flex cursor-pointer items-baseline rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-strong"
          onClick={(event) => { event.preventDefault(); setOpen(true); }}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" collisionPadding={12}
        className="max-w-[min(260px,calc(100vw-24px))] whitespace-normal">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}
