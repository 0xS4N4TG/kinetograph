import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// `vite dev` proxies the API and the WebSocket to a running `kinetograph studio` (default port 3000); the built files
// are served by that server itself, on the same origin.
const server = 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    proxy: {
      '/api': server,
      '/ws': { target: server, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    // Not `*.test.*`: the studio package's own vitest run would otherwise pick these up without jsdom or the alias.
    include: ['test/**/*.uitest.{ts,tsx}'],
    css: false,
  },
});
