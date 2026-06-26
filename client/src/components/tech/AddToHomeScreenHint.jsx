import { useEffect, useState } from 'react';
import { isNativeApp } from '../../native/platform';

/**
 * iOS "Add to Home Screen" onboarding hint for the field-tech portal.
 *
 * iOS Safari exposes no programmatic install prompt (`beforeinstallprompt` is
 * Chrome/Android only), so the only way to get techs onto the home-screen PWA
 * is to tell them to tap Share → Add to Home Screen. This banner does exactly
 * that — shown once, only where it's actionable:
 *   - iOS Safari (other iOS browsers can't add to the home screen)
 *   - not already running standalone (already installed)
 *   - not inside the native Capacitor shell
 * Dismissed state is remembered so it never nags.
 */

const DARK = {
  card: '#1e293b',
  border: '#334155',
  teal: '#0ea5e9',
  text: '#e2e8f0',
  muted: '#94a3b8',
};

const DISMISS_KEY = 'tech_a2hs_dismissed';

function isIosSafari() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIosDevice =
    /iPhone|iPod|iPad/.test(ua) ||
    // iPadOS 13+ reports a desktop Safari UA; detect it via touch support.
    (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
  if (!isIosDevice) return false;
  // Chrome/Firefox/Edge/Opera on iOS can't "Add to Home Screen" — only Safari.
  const isOtherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|mercury/i.test(ua);
  return !isOtherBrowser;
}

function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.navigator?.standalone === true ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches)
  );
}

export default function AddToHomeScreenHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isNativeApp()) return;
    if (isStandalone()) return;
    if (!isIosSafari()) return;
    try {
      if (localStorage.getItem(DISMISS_KEY) === '1') return;
    } catch {
      /* localStorage unavailable — show anyway */
    }
    setShow(true);
  }, []);

  if (!show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
    setShow(false);
  };

  return (
    <div
      role="note"
      style={{
        position: 'relative',
        background: DARK.card,
        border: `1px solid ${DARK.border}`,
        borderRadius: 12,
        padding: '14px 16px',
        marginBottom: 16,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          flexShrink: 0,
          width: 36,
          height: 36,
          borderRadius: 10,
          background: `linear-gradient(135deg, ${DARK.teal}, #2563eb)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 18,
        }}
      >
        📲
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 700,
            fontFamily: "'Montserrat', sans-serif",
            color: DARK.text,
            marginBottom: 4,
          }}
        >
          Install Field Tools on your phone
        </div>
        <div style={{ fontSize: 13, color: DARK.muted, lineHeight: 1.5 }}>
          Tap the Share button{' '}
          <ShareGlyph />
          {' '}in Safari, then choose{' '}
          <span style={{ color: DARK.text, fontWeight: 600 }}>
            “Add to Home Screen.”
          </span>{' '}
          You’ll sign in once inside the app and it stays logged in.
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        style={{
          flexShrink: 0,
          background: 'none',
          border: 'none',
          color: DARK.muted,
          fontSize: 20,
          lineHeight: 1,
          cursor: 'pointer',
          padding: 4,
          marginTop: -2,
        }}
      >
        ×
      </button>
    </div>
  );
}

/** Inline rendition of the iOS Safari share icon (square + up arrow). */
function ShareGlyph() {
  return (
    <svg
      width="14"
      height="16"
      viewBox="0 0 14 16"
      fill="none"
      stroke={DARK.teal}
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ verticalAlign: '-2px', display: 'inline' }}
    >
      <path d="M7 1.5v8" />
      <path d="M4 4l3-3 3 3" />
      <path d="M3 7H1.8v7h10.4V7H11" />
    </svg>
  );
}
