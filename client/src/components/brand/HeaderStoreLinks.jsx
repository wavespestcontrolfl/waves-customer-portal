import React from 'react';
import { isNativeApp } from '../../native/platform';

// Header slot store links (owner spec 2026-07-06): the WavesShell top bar
// shows Apple + Google Play icon links to the live app listings where the
// phone CTA used to sit. Icon-only glyphs (shapes mirror the footer badge
// SVGs); hidden inside the native apps.
const APP_STORE_URL = 'https://apps.apple.com/us/app/waves-pest-control/id6782775654';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.wavespestcontrol.portal';

export default function HeaderStoreLinks({ tone = 'dark' }) {
  if (isNativeApp()) return null;
  const color = tone === 'light' ? 'rgba(255, 255, 255, 0.9)' : 'var(--text)';
  const link = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color,
    textDecoration: 'none',
    lineHeight: 1,
  };
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 14 }}>
      <a href={APP_STORE_URL} target="_blank" rel="noopener noreferrer" aria-label="Download on the App Store" title="App Store" style={link}>
        <svg viewBox="0 0 20 24" width={17} height={20} fill="currentColor" aria-hidden="true">
          <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
        </svg>
      </a>
      <a href={PLAY_STORE_URL} target="_blank" rel="noopener noreferrer" aria-label="Get it on Google Play" title="Google Play" style={link}>
        <svg viewBox="2 1 20 22" width={18} height={20} fill="currentColor" aria-hidden="true">
          <path d="M4 3 13 12 4 21Z M4 3 16.5 9.8 13 12Z M16.5 9.8 20.5 12 16.5 14.2Z M13 12 16.5 14.2 4 21Z" />
        </svg>
      </a>
    </div>
  );
}
