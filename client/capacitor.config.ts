import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config for the Waves customer iOS app.
 *
 * The customer portal is already a PWA (manifest.json + sw.js + web-push).
 * This wraps that same app in a native shell so it can ship on the App Store
 * and use APNs push instead of (iOS-gated) web push.
 *
 * Two load modes — pick one:
 *
 *   A) REMOTE (spike default): `server.url` loads the live portal directly.
 *      Fastest to stand up, matches the continuous-deploy model (web changes
 *      ship without an App Store resubmission). The webview is same-origin with
 *      the server, so the Bearer-JWT session (localStorage) + socket.io work
 *      unchanged. Downside: higher Apple Guideline 4.2 ("just a website")
 *      rejection risk and the app needs a network to cold-start (the SW offline
 *      page covers reconnects). Use this to prove the wrapper + push end-to-end.
 *
 *   B) BUNDLED (hardening step): delete the `server` block below. The native
 *      shell then loads the static `dist/` build from `capacitor://localhost`.
 *      Requires the client to call the API at an ABSOLUTE base
 *      (https://portal.wavespestcontrol.com) instead of relative `/api`, plus
 *      CORS for those cross-origin calls. Auth is a Bearer JWT in localStorage
 *      (per-origin), so there's no cookie/SameSite work. More effort than MODE A
 *      but the app works offline and reads as a real native app to Apple review.
 */
const config: CapacitorConfig = {
  appId: 'com.wavespestcontrol.portal',
  appName: 'Waves',
  webDir: 'dist',
  ios: {
    // Let the web content manage its own safe-area insets (the portal already
    // uses env(safe-area-inset-*) via the standalone PWA meta tags).
    contentInset: 'always',
    backgroundColor: '#0f1923',
  },
  server: {
    // --- MODE A (remote). Comment out this whole block for MODE B (bundled). ---
    url: 'https://portal.wavespestcontrol.com',
    cleartext: false,
  },
  plugins: {
    PushNotifications: {
      // Show banners/sound/badge even when the app is foregrounded.
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    SplashScreen: {
      launchShowDuration: 600,
      backgroundColor: '#0f1923',
      showSpinner: false,
    },
  },
};

export default config;
