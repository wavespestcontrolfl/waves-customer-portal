import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './styles/brand-tokens.css';
import App from './App';
import { initNativePush } from './native/nativePush';
import { initNativeLinks } from './native/nativeLinks';

// Stale-chunk healing for tabs that live across a deploy: Vite's dependency
// preloader throws a plain Error that lazyWithRetry's chunk-message regex never
// sees, so an open tab whose hashed chunks 404 after a release crashed straight
// to the error screen (2026-07-23: /admin/dispatch chunk 404s post-deploy).
// Vite emits vite:preloadError for exactly this case — reuse lazyWithRetry's
// one-shot sessionStorage guard (App.jsx clears it on a successful load) so a
// genuine outage still surfaces instead of reload-looping.
window.addEventListener('vite:preloadError', (event) => {
  try {
    if (sessionStorage.getItem('chunk-reload-attempted')) return;
    sessionStorage.setItem('chunk-reload-attempted', '1');
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Native (iOS Capacitor) APNs registration. No-op on the web — see
// client/src/native/nativePush.js.
initNativePush();

// Universal/App Link → in-app navigation. No-op on the web — see
// client/src/native/nativeLinks.js.
initNativeLinks();

// Register PWA service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js?v=20260525-admin-activation-stable')
      .then(reg => console.log('SW registered:', reg?.scope || 'scope unavailable'))
      .catch(err => console.error('SW failed:', err));
  });
}
// rebuild 1775255633
