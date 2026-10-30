import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // proxy API calls to the board-service so the SPA can use same-origin /api.
      // The target takes an env override so two checkouts of this repo can run
      // side by side: `--port` already moves the SPA, and nothing moved the
      // service it talks to. Unset, it is the number it always was.
      '/api': { target: `http://localhost:${process.env.BOARD_API_PORT ?? 4000}`, changeOrigin: true },
    },
  },
});
