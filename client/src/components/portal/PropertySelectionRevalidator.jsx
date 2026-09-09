import { useEffect } from 'react';
import { READ_TIMEOUT_MS, usePortalRefresh } from '../../hooks/usePortalRead';

// Saved-property scope (GATE_APP_PROPERTY_SCOPE): every portal refresh —
// pull-to-refresh, a return to the app, a reconnect — re-reads the property
// list, which carries the selection the SERVER honors. If the office retired
// the selected house, or the gate went dark, while Home (or any tab) was
// open, the refreshed schedule/tracking reads already fell back to the
// primary / customer-wide; the label and the picker must follow before those
// visits are acted on (codex #4207 r1h). Registered as one more reader of
// the shared refresh cycle, so it needs no per-tab wiring.
export default function PropertySelectionRevalidator({ active, refresh }) {
  const portal = usePortalRefresh();
  const register = portal?.enabled ? portal.register : null;
  useEffect(() => {
    if (!active || !register || typeof refresh !== 'function') return undefined;
    // Bounded like every usePortalRead reader (uncapped codex r1p P1): the
    // shared cycle awaits ALL readers, so an /auth/properties call that
    // stalls would otherwise pin `refreshing` and block every later pull,
    // focus and reconnect refresh. A timed-out re-read simply loses this
    // cycle; the next one tries again.
    return register(() => {
      let timer;
      return Promise.race([
        Promise.resolve(refresh()),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), READ_TIMEOUT_MS); }),
      ]).catch(() => false).finally(() => clearTimeout(timer));
    });
  }, [active, register, refresh]);
  return null;
}
