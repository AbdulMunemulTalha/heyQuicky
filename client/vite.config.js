import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The dashboard is served by Express at /app. In development, `npm run dev:client`
// serves it with hot reload and forwards API calls to the Express server on :3000.
const backend = 'http://localhost:3000';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/app/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/auth': backend,
      '/socket.io': { target: backend, ws: true },
      '/privacy': backend,
      '/terms': backend,
      '/data-deletion': backend,
    },
  },
});
