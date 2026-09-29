import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { isNativeApp, hasSessionToken } from '../native/platform';
import { authenticateBiometric } from '../native/biometric';
import { NATIVE_PICKER_EVENT } from '../native/camera';
import { COLORS, FONTS } from '../theme-brand';
import '../glass/glass-theme.css';

export const BiometricLockContext = createContext(false);

export function useBiometricLock() {
  return useContext(BiometricLockContext);
}

// The lock overlay is a liquid-glass surface, but it deliberately does NOT call
// useGlassSurface: the shared scene mounts BEHIND #root, and a privacy overlay
// must be opaque (it hides account content from the iOS app-switcher snapshot).
// It also must not own the scene lifecycle — unlocking over a page that runs its
// own useGlassSurface would tear that page's scene down. So the overlay paints
// its own copy of the applyGlassScene() mesh + orbs (glass-engine.js —
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

// Same orb spec as applyGlassScene().
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

// How long a camera / photo picker the app opened may excuse a hidden document if
// it never reports back (older iOS has no `cancel` event).
const PICKER_GRACE_MS = 3 * 60 * 1000;

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
  // Our own camera / photo picker (the native camera sheet or an <input type="file">,
  // e.g. Photo ID) covers the
  // webview with a native sheet. That hides the document, which looked like a real
  // background: the app locked under the camera, and every Face ID success was then
  // discarded as "not foreground" (the camera still hid the page), so the prompt
  // re-fired every few seconds. While a picker we opened is up (until its close
  // signal: the input's change/cancel or the native camera's close event), a hidden
  // document is not leaving the app. A real app switch still resigns the app, and
  // that always locks (appStateChange below) — the picker only excuses the hidden
  // document.
  const pickerOpenUntilRef = useRef(0);
  // A real app switch while a picker was open: Face ID waits until the picker has
  // closed and the page is visible, so the normal "still foreground" check judges it
  // (a prompt under the camera can't tell the Face ID sheet's own resign from a real
  // one, and an iPad popover picker can stay open on a visible page).
  const unlockAfterPickerRef = useRef(false);
  // Older iOS may send neither change nor cancel; a full-screen picker's own
  // hidden → visible round trip then closes it. Only a hide with no real resign
  // since the picker opened counts (a real switch resigns before it hides).
  const pickerHidPageRef = useRef(false);
  const resignedSincePickerRef = useRef(false);
  const pickerOpen = () => Date.now() < pickerOpenUntilRef.current;

  const attempt = useCallback(async () => {
    if (!isNativeApp() || !hasSessionToken()) { setLocked(false); return; }
    // Never run two prompts at once — without this, the foreground event from the
    // biometric sheet's own dismissal re-enters attempt() and Face ID loops forever.
    if (promptInFlightRef.current) return;
    promptInFlightRef.current = true;
    unlockAfterPickerRef.current = false; // this prompt is the deferred one, or replaces it
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
    const unlockAfterPicker = () => {
      if (!unlockAfterPickerRef.current || pickerOpen() || document.visibilityState !== 'visible') return;
      unlockAfterPickerRef.current = false;
      if (lockedRef.current) attempt();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (pickerOpen() && pickerHidPageRef.current) { pickerDone(); return; }
        unlockAfterPicker();
        return;
      }
      if (pickerOpen()) {
        if (!resignedSincePickerRef.current) pickerHidPageRef.current = true;
        return;
      }
      if (document.visibilityState === 'hidden' && isNativeApp() && hasSessionToken()) {
        setLocked(true);
        lockedRef.current = true;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    const isFileInput = (el) => el?.tagName === 'INPUT' && el.type === 'file';
    // Older iOS sends no `cancel`: when the cap lapses, run any deferred prompt.
    let graceTimer = null;
    const pickerOpened = () => {
      pickerOpenUntilRef.current = Date.now() + PICKER_GRACE_MS;
      pickerHidPageRef.current = false;
      resignedSincePickerRef.current = false;
      clearTimeout(graceTimer);
      graceTimer = setTimeout(unlockAfterPicker, PICKER_GRACE_MS + 50);
    };
    // A pick/cancel can land while the sheet is still hiding the page: the deferred
    // unlock then waits for the page to become visible.
    const pickerDone = () => {
      pickerOpenUntilRef.current = 0;
      pickerHidPageRef.current = false;
      clearTimeout(graceTimer);
      unlockAfterPicker();
    };
    const onPickerOpen = (e) => { if (isFileInput(e.target)) pickerOpened(); };
    const onPickerDone = (e) => { if (isFileInput(e.target)) pickerDone(); };
    const onNativePicker = (e) => { if (e.detail?.open) pickerOpened(); else pickerDone(); };
    // Capture phase: the picker's input is usually hidden and clicked from code, and
    // `cancel` doesn't bubble.
    document.addEventListener('click', onPickerOpen, true);
    document.addEventListener('change', onPickerDone, true);
    document.addEventListener('cancel', onPickerDone, true);
    document.addEventListener(NATIVE_PICKER_EVENT, onNativePicker);
    let listener;
    import('@capacitor/app')
      .then(({ App }) => App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) {
          // Ignore ONLY the foreground event the biometric sheet emits when it
          // dismisses — that prompt-induced re-entry is what caused the loop.
          if (suppressStateRef.current) return;
          // Only (re)prompt when actually locked — a stray foreground while already
          // unlocked must never kick off another Face ID prompt.
          if (!lockedRef.current) return;
          // A picker is still open, or closed with the page not yet visible: the
          // prompt runs from unlockAfterPicker() instead.
          if (pickerOpen() || unlockAfterPickerRef.current) return;
          attempt();
        } else if (hasSessionToken()) {
          // ALWAYS lock on resign (willResignActive) — even during a prompt's
          // suppression window or while our own picker is up — to cover the
          // app-switcher snapshot.
          setLocked(true);
          lockedRef.current = true;
          if (pickerOpen()) {
            unlockAfterPickerRef.current = true;
            resignedSincePickerRef.current = true;
          }
        }
      }))
      .then((l) => { listener = l; })
      .catch(() => {});
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('click', onPickerOpen, true);
      document.removeEventListener('change', onPickerDone, true);
      document.removeEventListener('cancel', onPickerDone, true);
      document.removeEventListener(NATIVE_PICKER_EVENT, onNativePicker);
      clearTimeout(graceTimer);
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
  // never remove an attribute a page set (see the header comment). The value
  // 'lock' styles identically to 'full' (only "pro" has value-specific CSS)
  // but marks ownership: if a lazy page's useGlassSurface mounts while the
  // lock is up, applyGlassScene overwrites the value, and cleanup sees the
  // attribute is no longer ours and leaves the page's theme in place.
  useEffect(() => {
    if (!locked) return undefined;
    const html = document.documentElement;
    if (html.hasAttribute('data-glass-theme')) return undefined;
    html.setAttribute('data-glass-theme', 'lock');
    return () => {
      if (html.getAttribute('data-glass-theme') === 'lock') {
        html.removeAttribute('data-glass-theme');
      }
    };
  }, [locked]);

  // Children stay mounted (route state preserved); the lock is an overlay on top.
  // The container is made inert while locked (see effect above) so the hidden
  // content is non-interactive and invisible to assistive tech, not just covered.
  return (
    <BiometricLockContext.Provider value={locked}>
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
          {/* layout-only wrapper — no data-glass surface, no box chrome: the logo
              floats directly on the scene (owner request: no card around the logo) */}
          <div
            className="waves-lock-anim"
            style={{
              position: 'relative',
              width: 'min(340px, 100%)',
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
                  background: COLORS.yellow, color: COLORS.glassNavy,
                  opacity: checking ? 0.65 : 1,
                }}
              >
                {checking ? 'Unlocking…' : 'Unlock'}
              </button>
            </div>
          </div>
        </div>
      )}
    </BiometricLockContext.Provider>
  );
}
