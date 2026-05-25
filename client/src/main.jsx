import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './styles/brand-tokens.css';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register PWA service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js?v=20260525-admin-activation-stable')
      .then(reg => console.log('SW registered:', reg?.scope || 'scope unavailable'))
      .catch(err => console.error('SW failed:', err));
  });
}
// rebuild 1775255633
