import { createContext, forwardRef, useContext, type ReactNode, type SVGProps } from 'react';
import { EmptyState as KitEmptyState, type EmptyStateProps as KitEmptyStateProps, cn } from './kit';
import { BLOCK } from './block';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  titleAs?: KitEmptyStateProps['titleAs'];
}

const IconContent = createContext<ReactNode>(null);

/** Existing callers supply 16px SVG nodes. The outer SVG supplies the kit's
 *  sizing and real SVG ref without changing those callers or casting their types. */
const BoardEmptyIcon: NonNullable<KitEmptyStateProps['icon']> = forwardRef<
  SVGSVGElement, SVGProps<SVGSVGElement> & { size?: number | string }
>(({ size = 24, ...props }, ref) => (
  <svg {...props} ref={ref} width={size} height={size} viewBox="0 0 16 16">
    {useContext(IconContent)}
  </svg>
));
BoardEmptyIcon.displayName = 'BoardEmptyIcon';

/** Keep Board's flat surface and caller-owned copy/actions around the native layout. */
export function EmptyState({ icon, title, description, action, className, titleAs }: EmptyStateProps) {
  return (
    <IconContent.Provider value={icon}>
      <KitEmptyState
        icon={icon ? BoardEmptyIcon : undefined}
        title={title}
        titleAs={titleAs}
        description={description}
        action={action}
        className={cn(BLOCK, className)}
      />
    </IconContent.Provider>
  );
}
