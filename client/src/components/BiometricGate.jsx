import { useState, useEffect, useCallback } from 'react';
import { isNativeApp, hasSessionToken } from '../native/platform';
import { authenticateBiometric } from '../native/biometric';

/**
 * Face ID / Touch ID app-lock for the native shell.
 *
 * When a session token exists, requires biometric unlock on launch and on every
 * return to the foreground. The lock is rendered as a full-screen overlay over
 * still-mounted children, so an in-progress route (a request/payment form) keeps
 * its state across a background→unlock cycle. It also locks immediately on
 * background so the iOS app-switcher snapshot shows the lock, not the content.
 *
 * Pass-through on the web and when logged out (no session token), so public
 * token pages (/pay, /report, …) are never gated.
 */
export default function BiometricGate({ children }) {
  const [locked, setLocked] = useState(() => isNativeApp() && hasSessionToken());
  const [checking, setChecking] = useState(false);

  const attempt = useCallback(async () => {
    if (!isNativeApp() || !hasSessionToken()) { setLocked(false); return; }
    setChecking(true);
    setLocked(true);
    const ok = await authenticateBiometric('Unlock Waves');
    setLocked(!ok);
    setChecking(false);
  }, []);

  useEffect(() => {
    if (!isNativeApp()) return undefined;
    attempt();
    let listener;
    import('@capacitor/app')
      .then(({ App }) => App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) {
          attempt();
        } else if (hasSessionToken()) {
          // Cover the app-switcher snapshot taken on background.
          setLocked(true);
        }
      }))
      .then((l) => { listener = l; })
      .catch(() => {});
    return () => { try { listener?.remove?.(); } catch { /* noop */ } };
  }, [attempt]);

  // Children stay mounted (route state preserved); the lock is an overlay on top.
  return (
    <>
      {children}
      {locked && (
        <div style={{
          position: 'fixed', inset: 0, background: '#0f1923', color: '#e2e8f0',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: 24, textAlign: 'center', zIndex: 99999,
        }}>
          <div style={{
            width: 64, height: 64, borderRadius: 16, marginBottom: 20,
            background: 'linear-gradient(135deg,#0ea5e9,#38bdf8)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: 30, color: '#fff',
          }}>W</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Waves is locked</div>
          <div style={{ fontSize: 13, color: '#94a3b8', maxWidth: 300, lineHeight: 1.5, marginBottom: 22 }}>
            Unlock with Face ID to view your account.
          </div>
          <button
            type="button"
            onClick={attempt}
            disabled={checking}
            style={{
              padding: '11px 26px', background: '#0ea5e9', color: '#fff', border: 0,
              borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
              opacity: checking ? 0.6 : 1,
            }}
          >
            {checking ? 'Unlocking…' : 'Unlock'}
          </button>
        </div>
      )}
    </>
  );
}
