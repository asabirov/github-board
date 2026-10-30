import { createContext, useContext } from 'react';
import type { Me } from './session-state';

/** Share App's opening identity without probing again when a page mounts. */
export const IdentityContext = createContext<Me | null>(null);
export const useIdentity = () => useContext(IdentityContext);
