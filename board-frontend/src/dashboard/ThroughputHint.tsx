import { useState, type ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/kit';
import { HINT } from '../ui/chart-pointer';

/** Only Throughput follows its marked datum; other charts retain ChartHint. */
export function ThroughputHint({ label, x, y, open, onHold, onDismiss, children }: {
  label: string;
  x: number;
  y: number;
  open: boolean;
  onHold: () => void;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const [boundary, setBoundary] = useState<HTMLDivElement | null>(null);
  // Removing the readout can expose another week under a stationary pointer.
  // Reopen on a new gesture, not on that synthetic week change.
  const [dismissed, setDismissed] = useState(false);
  return (
    <div
      ref={setBoundary}
      className="relative h-full w-full"
      onPointerMove={() => setDismissed(false)}
      onFocusCapture={() => setDismissed(false)}
    >
      {children}
      <Tooltip open={open && !dismissed}>
        <TooltipTrigger asChild>
          <span aria-hidden="true" className="pointer-events-none absolute" style={{ left: `${x}%`, top: `${y}%` }} />
        </TooltipTrigger>
        <TooltipContent
          side="top"
          collisionBoundary={boundary}
          collisionPadding={0}
          onPointerEnter={onHold}
          onPointerLeave={onDismiss}
          onEscapeKeyDown={() => setDismissed(true)}
        >
          <span className={HINT}>{label}</span>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
