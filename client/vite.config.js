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
  '@capacitor/filesystem': shim('filesystem.js'),
  '@capacitor/push-notifications': shim('push.js'),
  '@capacitor/share': shim('share.js'),
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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Keep this gate on customer-app shell code with executable unit tests.
      // PortalPage remains a large mixed-responsibility module and its current
      // render tests do not justify a low, misleading repo-wide percentage.
      // Split that page before adding it here; lowering this floor to include
      // thousands of unexercised lines would turn the gate into theatre.
      include: [
        'src/components/BiometricGate.jsx',
        'src/components/InstallPrompt.jsx',
        'src/components/NotificationBell.jsx',
        'src/components/brand/CustomerDialogHost.jsx',
        'src/glass/glass-engine.js',
        'src/hooks/useAuth.jsx',
        'src/native/nativeLinks.js',
        'src/native/nativePush.js',
        'src/pages/LoginPage.jsx',
      ],
      // Re-measured 2026-07-17 after the #2788 UI-only revert restored the
      // pre-audit shell components (whose #2788-era tests left with the new
      // UI): 73.86 statements, 73.84 lines, 68.08 branches, 65.82 functions.
      // These rounded-down floors leave normal instrumentation variance
      // while preventing an untested regression from here.
      thresholds: {
        statements: 73,
        branches: 64,
        functions: 62,
        lines: 73,
      },
    },
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
        // Dev-only: browser DOCUMENT loads render the SPA estimate view
        // (EstimateViewPage) instead of proxying to the API server. The
        // server's use_v2_view fallthrough serves the SPA from client/dist,
        // which doesn't exist in dev, so proxied v2 estimates 404'd. The
        // page's /api/estimates/:token/data fetch still proxies normally.
        // To view the LEGACY server-HTML renderer in dev, hit the API
        // origin directly (e.g. localhost:3001/estimate/<token>).
        bypass(req) {
          if (req.headers.accept && req.headers.accept.includes('text/html')) return '/index.html';
        },
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
