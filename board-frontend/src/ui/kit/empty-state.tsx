import * as React from 'react';
import { cn } from './cn';

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  title: React.ReactNode;
  /** The tag the title emits. A page whose only text is an empty state names a heading level here. */
  titleAs?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p';
  description?: React.ReactNode;
  action?: React.ReactNode;
}

export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
  ({ icon: Icon, title, titleAs: TitleTag = 'p', description, action, className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col items-center px-4 py-10 text-center', className)} {...props}>
      {Icon && <Icon className="mb-3 size-6 text-muted" aria-hidden="true" />}
      <TitleTag className="text-sm text-dim">{title}</TitleTag>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  ),
);
EmptyState.displayName = 'EmptyState';
