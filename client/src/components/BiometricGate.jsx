import { useState, useEffect, useCallback, useRef } from 'react';
import { isNativeApp, hasSessionToken } from '../native/platform';
import { authenticateBiometric } from '../native/biometric';
import { COLORS, FONTS } from '../theme-brand';
import '../glass/glass-theme.css';

// The lock overlay is a liquid-glass surface, but it deliberately does NOT call
// useGlassSurface: the shared scene mounts BEHIND #root, and a privacy overlay
// must be opaque (it hides account content from the iOS app-switcher snapshot).
// It also must not own the scene lifecycle — unlocking over a page that runs its
// own useGlassSurface would tear that page's scene down. So the overlay paints
// its own copy of the applyGlassScene('full') mesh + orbs (glass-engine.js —
// keep the two in sync), and the native launch image mirrors the same scene:
// client/resources/splash-2732x2732.png + capacitor.config.json backgroundColor.
const GLASS_SCENE_BG = [
  'radial-gradient(1100px 700px at 85% -10%, rgba(10,126,194,.40), transparent 60%)',
  'radial-gradient(900px 650px at -10% 30%, rgba(240,165,0,.16), transparent 55%)',
  'radial-gradient(1000px 900px at 75% 95%, rgba(6,90,140,.32), transparent 60%)',
  'radial-gradient(600px 400px at 40% 55%, rgba(56,170,225,.16), transparent 65%)',
  'radial-gradient(140% 120% at 50% 40%, rgba(255,255,255,0) 55%, rgba(4,57,94,.14) 100%)',
  'linear-gradient(180deg,#E0EEF9 0%,#F5FAFE 45%,#E5EFF7 100%)',
].join(',');

// Same orb spec as applyGlassScene('full').
const GLASS_ORBS = [
  ['10%', '6%', 380, 'rgba(10,126,194,.36)'],
  ['62%', '22%', 460, 'rgba(56,170,225,.34)'],
  ['22%', '62%', 420, 'rgba(240,165,0,.18)'],
  ['72%', '74%', 340, 'rgba(4,57,94,.28)'],
];

const LOCK_KEYFRAMES = `
@keyframes wavesLockLogoIn {
  from { opacity: 0; transform: scale(0.94); }
  to   { opacity: 1; transform: scale(1); }
}
@keyframes wavesLockFloat {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-8px); }
}
@keyframes wavesLockRise {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .waves-lock-anim { animation: none !important; }
}
`;

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
      setChecking(false);
      promptInFlightRef.current = false;
      // Only clear the lock on a success that finished with the app still in the
      // foreground. If a real background landed during the prompt, its visibility
      // listener has already re-locked — don't let a stale success overwrite that
      // newer lock and expose content on the next return.
      const stillForeground = typeof document === 'undefined' || document.visibilityState === 'visible';
      const unlocked = ok && stillForeground;
      setLocked(!unlocked);
      lockedRef.current = !unlocked;
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
    // A genuine background hides the webview document. The iOS biometric sheet does
    // NOT (the app stays foreground), so this fires only on a real background — making
    // it the authoritative signal that a fresh unlock is required on return, and it
    // can't be confused with the Face ID prompt's own resign/activate churn.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && isNativeApp() && hasSessionToken()) {
        setLocked(true);
        lockedRef.current = true;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
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
          // ALWAYS lock on resign (willResignActive) — even during a prompt's
          // suppression window — to cover the app-switcher snapshot.
          setLocked(true);
          lockedRef.current = true;
        }
      }))
      .then((l) => { listener = l; })
      .catch(() => {});
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      try { listener?.remove?.(); } catch { /* noop */ }
    };
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

  // Activate the shared glass theme (glass-theme.css) so the overlay's
  // data-glass surfaces render. Attribute-only, and only when no page has
  // already mounted a scene — the pages own their scene lifecycle, we must
  // never remove an attribute a page set (see the header comment).
  useEffect(() => {
    if (!locked) return undefined;
    const html = document.documentElement;
    if (html.hasAttribute('data-glass-theme')) return undefined;
    html.setAttribute('data-glass-theme', 'full');
    return () => html.removeAttribute('data-glass-theme');
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
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Waves is locked. Unlock with Face ID to view your account."
          style={{
            position: 'fixed', inset: 0, zIndex: 99999, overflow: 'hidden',
            background: GLASS_SCENE_BG,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            padding: 24, textAlign: 'center', fontFamily: FONTS.ui,
          }}
        >
          <style>{LOCK_KEYFRAMES}</style>
          {/* overlay-local copy of the glass scene orbs (the shared ones live
              behind #root and can't show through an opaque privacy overlay) */}
          {GLASS_ORBS.map(([left, top, size, color]) => (
            <div
              key={`${left}-${top}`}
              aria-hidden="true"
              style={{
                position: 'absolute', left, top, width: size, height: size,
                borderRadius: '50%', background: color, filter: 'blur(70px)',
                pointerEvents: 'none',
              }}
            />
          ))}
          <div
            className="waves-lock-anim"
            data-glass="modal"
            style={{
              position: 'relative',
              width: 'min(340px, 100%)',
              padding: '36px 28px 32px',
              borderRadius: 24,
              background: 'rgba(255,255,255,0.5)',
              border: '1px solid rgba(255,255,255,0.75)',
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              animation: 'wavesLockLogoIn 0.5s ease-out both',
            }}
          >
            <img
              src="/waves-logo.png"
              alt=""
              width={230}
              height={230}
              className="waves-lock-anim"
              style={{
                display: 'block', marginBottom: 20,
                filter: 'drop-shadow(0 16px 28px rgba(4, 57, 94, 0.28))',
                animation: 'wavesLockFloat 6s ease-in-out 0.5s infinite',
              }}
            />
            {/* entrance animation lives on the wrapper so its fill-mode can't
                override the button's own checking-state opacity */}
            <div
              className="waves-lock-anim"
              style={{ animation: 'wavesLockRise 0.5s ease-out 0.5s both', alignSelf: 'stretch' }}
            >
              <button
                type="button"
                ref={unlockBtnRef}
                onClick={attempt}
                disabled={checking}
                data-glass-accent=""
                style={{
                  position: 'relative', width: '100%', minHeight: 52,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  borderRadius: 999, border: 'none', cursor: 'pointer',
                  fontFamily: FONTS.ui, fontSize: 17, fontWeight: 600,
                  // fallbacks only — the data-glass-accent rules repaint these
                  background: COLORS.yellow, color: COLORS.blueDeeper,
                  opacity: checking ? 0.65 : 1,
                }}
              >
                {checking ? 'Unlocking…' : 'Unlock'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
