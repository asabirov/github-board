/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Auto-refresh interval in ms for the data surfaces (#375). Blank → 120000
   *  (2 min); 0 disables the periodic poll (focus refetch stays). */
  readonly VITE_AUTO_REFRESH_MS?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** The kit's token sheets are CSS that vite bundles, so they have no types (#1450). */
declare module '@apliteni/apliteni-ui/tokens';
declare module '@apliteni/apliteni-ui/accents';
