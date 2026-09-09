import { useEffect } from 'react';
import { usePortalRefresh } from '../../hooks/usePortalRead';

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
    return register(() => Promise.resolve(refresh()).catch(() => false));
  }, [active, register, refresh]);
  return null;
}
