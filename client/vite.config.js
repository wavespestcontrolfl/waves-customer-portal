import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
      '/estimate': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
      // Socket.io needs ws: true for the upgrade handshake. Without
      // this, the client connects to localhost:5173/socket.io/ and
      // never reaches the backend in dev. Codex P2 on PR #296.
      '/socket.io': {
        target: apiProxyTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
});
