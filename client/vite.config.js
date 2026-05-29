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
  // Force esbuild to pre-bundle the CJS workspace package so Rollup receives
  // proper ESM named exports instead of a raw module.exports object. Linked
  // workspace packages are excluded from pre-bundling by default, which causes
  // Rollup's static analysis to fail with "X is not exported by …" errors.
  // See: https://vitejs.dev/config/dep-optimization-options#optimizedeps-include
  optimizeDeps: {
    include: ['@waves/lawn-cost-floor'],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
    // Ensure @rollup/plugin-commonjs also processes the linked CJS package
    // during production builds, complementing the optimizeDeps.include above.
    commonjsOptions: {
      include: [/lawn-cost-floor/, /node_modules/],
    },
  },
});
