import { restoreReads } from './cache/read-cache';
import { cachedOwner } from './cache/payload-cache';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { BoardToaster } from './ui/BoardToaster';
import { startTheme } from './theme';
// The kit tokens and accents load before app.css. The board's theme blocks have the same
// specificity as the kit's, so the later sheet wins (#1450). The font faces are separate
// imports, because the kit tokens name the families and ship no faces.
import '@apliteni/apliteni-ui/tokens';
import '@apliteni/apliteni-ui/accents';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import './app.css';

// The theme and the accent are on `<html>` before the first render. index.html paints the
// same choice before this script loads. See theme.ts for the dark-first seed and the carry.
startTheme();

// Give saved reads 400 ms to arrive before choosing the route's initial state.
// Slow or unavailable storage must not prevent the shell from mounting.
const restored = restoreReads().catch(() => {});
if (cachedOwner()) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    restored,
    new Promise<void>(resolve => { timeout = setTimeout(resolve, 400); }),
  ]);
  clearTimeout(timeout);
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <BoardToaster />
  </StrictMode>,
);
