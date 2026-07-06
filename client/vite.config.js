import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:3001';

// Opt-in DEV-ONLY shim (CAP_SHIM=1): alias the native Capacitor plugins to tiny
// web stubs so the full app boots in a checkout that lacks the native deps. Never
// affects `vite build` / the native iOS bundle (which uses the real, installed
// plugins) — this only activates when the env flag is set for the dev server.
const capShim = process.env.CAP_SHIM === '1';
const shim = (p) => new URL(`./src/native/_capWebShim/${p}`, import.meta.url).pathname;
const capShimAlias = capShim ? {
  '@capacitor/core': shim('core.js'),
  '@capacitor/app': shim('app.js'),
  '@capacitor/camera': shim('camera.js'),
  '@capacitor/push-notifications': shim('push.js'),
  '@aparajita/capacitor-biometric-auth': shim('biometric.js'),
} : {};

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { ...capShimAlias } },
  // Vitest reads this block. The global setup shims window.matchMedia (jsdom
  // omits it) so tests can mount the liquid-glass scene, which now renders on
  // every customer surface.
  test: {
    setupFiles: ['./src/test-setup.js'],
  },
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
