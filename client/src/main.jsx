import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './styles/brand-tokens.css';
import App from './App';
import { initNativePush } from './native/nativePush';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Native (iOS Capacitor) APNs registration. No-op on the web — see
// client/src/native/nativePush.js.
initNativePush();

// Register PWA service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js?v=20260525-admin-activation-stable')
      .then(reg => console.log('SW registered:', reg?.scope || 'scope unavailable'))
      .catch(err => console.error('SW failed:', err));
  });
}
// rebuild 1775255633
