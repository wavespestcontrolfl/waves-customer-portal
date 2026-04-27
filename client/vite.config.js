import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/estimate': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // Socket.io needs ws: true for the upgrade handshake. Without
      // this, the client connects to localhost:5173/socket.io/ and
      // never reaches the backend in dev. Codex P2 on PR #296.
      '/socket.io': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
