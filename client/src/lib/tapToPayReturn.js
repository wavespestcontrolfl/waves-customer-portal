// Tap-to-Pay return helper.
//
// When an admin taps "Tap to Pay", launchTapToPay sets window.location.href
// to the WavesPay deep link. iOS switches apps; when the admin returns,
// Safari frequently evicts the tab from memory and reloads it from scratch,
// so React Router starts at the default route and the admin loses their
// place (ends up on the section Home screen instead of the invoice detail
// or schedule list they came from).
//
// Fix: snapshot the current URL into sessionStorage before the deep-link
// redirect. On next app mount, if there's a fresh snapshot, navigate to it
// exactly once. Session storage survives iOS's backgrounding + tab eviction;
// localStorage would work too but session is cleaner and auto-clears when
// the tab finally closes.
//
//   snapshotForHandoff()        — call immediately before window.location.href=…
//   consumeSnapshotOnMount(nav) — call once from the top of the admin tree
//   clearSnapshot()             — defensive clear, for tests or manual reset
//
// 5-minute expiry balances "Stripe Terminal can take a while if signal
// is bad" against "don't hijack a legitimate home-button click hours later".

const KEY = 'waves-taptopay-return';
const EXPIRY_MS = 5 * 60 * 1000;

export function snapshotForHandoff() {
  try {
    const snap = {
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
      scrollY: window.scrollY,
      savedAt: Date.now(),
    };
    sessionStorage.setItem(KEY, JSON.stringify(snap));
  } catch {
    // Session storage can throw in privacy modes. Not worth crashing over.
  }
}

export function clearSnapshot() {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}

// Consume the snapshot exactly once. If the saved path differs from where
// we landed (typical — the reload dropped us at the default), navigate the
// admin to the saved URL via the supplied react-router `navigate` function.
// Returns true if a restore was performed, false otherwise.
export function consumeSnapshotOnMount(navigate) {
  let raw;
  try { raw = sessionStorage.getItem(KEY); } catch { raw = null; }
  if (!raw) return false;
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }

  let snap;
  try { snap = JSON.parse(raw); } catch { return false; }
  if (!snap || typeof snap.pathname !== 'string') return false;
  if (Date.now() - (snap.savedAt || 0) > EXPIRY_MS) return false;

  const here = window.location.pathname + window.location.search;
  const target = snap.pathname + (snap.search || '');
  if (here === target) return false; // already where we were

  // Router navigate — defers to react-router so React state stays in sync.
  try {
    navigate(target + (snap.hash || ''), { replace: true });
    // Restore scroll on next frame after the route renders.
    if (typeof snap.scrollY === 'number') {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => window.scrollTo(0, snap.scrollY));
      });
    }
    return true;
  } catch {
    return false;
  }
}
