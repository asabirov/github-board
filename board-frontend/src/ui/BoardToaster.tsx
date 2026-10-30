import { Toaster } from './kit';
import { useTheme } from '../theme';

/** Keep open notifications in sync with the shown theme, also through an OS appearance change. */
export function BoardToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      theme={resolvedTheme}
      position="bottom-center"
      duration={1900}
      offset={28}
      mobileOffset={16}
    />
  );
}
