import * as React from 'react';
import { cn } from './cn';

export const Skeleton = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('motion-safe:animate-pulse rounded-md bg-surface-3', className)} {...props} />
));
Skeleton.displayName = 'Skeleton';
