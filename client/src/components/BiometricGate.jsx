import { useState, useEffect, useCallback, useRef } from 'react';
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
  const contentRef = useRef(null);
  const unlockBtnRef = useRef(null);
  // Guards against the Face ID prompt looping: the iOS biometric sheet briefly sends
  // the app to the background and fires appStateChange(isActive:true) again when it
  // dismisses, which would otherwise re-trigger another prompt indefinitely.
  const promptInFlightRef = useRef(false); // a biometric prompt is currently showing
  const suppressStateRef = useRef(false);  // ignore app-state churn our own prompt causes
  const lockedRef = useRef(false);         // latest lock state for the stable listener closure
  const suppressTimerRef = useRef(null);   // pending timer that clears suppressStateRef

  const attempt = useCallback(async () => {
    if (!isNativeApp() || !hasSessionToken()) { setLocked(false); return; }
    // Never run two prompts at once — without this, the foreground event from the
    // biometric sheet's own dismissal re-enters attempt() and Face ID loops forever.
    if (promptInFlightRef.current) return;
    promptInFlightRef.current = true;
    // Cancel any pending suppression-clear from a previous prompt so its stale timer
    // can't flip suppression off while this new prompt's sheet is still showing.
    if (suppressTimerRef.current) { clearTimeout(suppressTimerRef.current); suppressTimerRef.current = null; }
    suppressStateRef.current = true;
    setChecking(true);
    setLocked(true);
    let ok = false;
    try {
      ok = await authenticateBiometric('Unlock Waves');
    } finally {
      setLocked(!ok);
      setChecking(false);
      promptInFlightRef.current = false;
      // Keep ignoring app-state changes briefly to swallow the trailing foreground
      // event the biometric sheet emits when it closes. Track the timer so a later
      // prompt cancels this one (above) rather than letting it clear suppression
      // while a newer sheet is still open.
      if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
      suppressTimerRef.current = setTimeout(() => {
        suppressStateRef.current = false;
        suppressTimerRef.current = null;
      }, 700);
    }
  }, []);

  // Keep lockedRef in sync so the (stable) appStateChange listener reads current state.
  useEffect(() => { lockedRef.current = locked; }, [locked]);

  useEffect(() => {
    if (!isNativeApp()) return undefined;
    attempt();
    let listener;
    import('@capacitor/app')
      .then(({ App }) => App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) {
          // Ignore ONLY the foreground event the biometric sheet emits when it
          // dismisses — that prompt-induced re-entry is what caused the loop.
          if (suppressStateRef.current) return;
          // Only (re)prompt when actually locked — a stray foreground while already
          // unlocked must never kick off another Face ID prompt.
          if (lockedRef.current) attempt();
        } else if (hasSessionToken()) {
          // ALWAYS lock on background — even during a prompt's suppression window —
          // to cover the app-switcher snapshot and ensure a real background here
          // can't leave content unlocked on the next foreground.
          setLocked(true);
          lockedRef.current = true;
        }
      }))
      .then((l) => { listener = l; })
      .catch(() => {});
    return () => { try { listener?.remove?.(); } catch { /* noop */ } };
  }, [attempt]);

  // While locked, fully gate the still-mounted content — not just visually. Mark
  // it `inert` (blocks pointer/keyboard/focus + hides from AT) and move focus to
  // the unlock control, so VoiceOver / hardware keyboard / a pre-background focus
  // can't reach account content behind the overlay.
  useEffect(() => {
    const el = contentRef.current;
    if (el) {
      try { el.inert = locked; } catch { /* very old webview without inert */ }
    }
    if (locked) {
      const id = setTimeout(() => { try { unlockBtnRef.current?.focus(); } catch { /* noop */ } }, 0);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [locked]);

  // Children stay mounted (route state preserved); the lock is an overlay on top.
  // The container is made inert while locked (see effect above) so the hidden
  // content is non-interactive and invisible to assistive tech, not just covered.
  return (
    <>
      <div ref={contentRef} aria-hidden={locked ? true : undefined}>
        {children}
      </div>
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
            ref={unlockBtnRef}
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
