// client/src/components/portal/MovingEntry.jsx
// "Take WaveGuard with you" in the customer app (moving PR 2a, dark behind
// GATE_MOVING_PORTAL). The button opens the customer's own moving page, the
// same /moving/<token> page the office's moving link opens, where the customer
// checks the new address and gives the move dates. Nothing is sent and no plan
// changes here. While the gate is dark the server answers { enabled: false }
// and nothing renders.
import { useEffect, useState } from 'react';
import api from '../../utils/api';
import { showCustomerAlert } from '../brand/CustomerDialogHost';

// The live cancel-card promise (cancellation-resolution templates.js moving_transfer).
export const MOVING_HEADLINE = 'Take WaveGuard with you';
export const MOVING_BODY = 'Your history and your WaveGuard level come along, with no setup fee at the new place.';

// Opens the customer's moving page. Returns false when it could not.
export async function openMovingPage() {
  try {
    const { path } = await api.startMove();
    if (!path || !String(path).startsWith('/moving/')) throw new Error('No moving page');
    window.location.assign(path);
    return true;
  } catch (err) {
    showCustomerAlert(err?.message || 'We could not open the moving page. Please try again, or call us.');
    return false;
  }
}

// Whether the server offers the button (one read per mount).
export function useMovingEntry() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    // Inside the promise chain, so a missing method also just hides the button.
    Promise.resolve().then(() => api.getMovingEntry())
      .then((res) => { if (live) setEnabled(res?.enabled === true); })
      .catch(() => { /* optional: a failed read leaves the button hidden */ });
    return () => { live = false; };
  }, []);
  return enabled;
}

// variant 'section': the Account Options row (headline, one line, button).
// variant 'link': one button under the cancel flow's Moving reason.
export default function MovingEntry({ enabled, variant = 'section', styles = {} }) {
  const [busy, setBusy] = useState(false);
  if (!enabled) return null;
  const open = async () => {
    setBusy(true);
    const opened = await openMovingPage();
    if (!opened) setBusy(false);
  };
  if (variant === 'link') {
    return (
      <button type="button" onClick={open} disabled={busy} className="waves-focus-ring" style={styles.smallLinkButton} data-testid="moving-entry-link">
        {busy ? 'Opening…' : `${MOVING_HEADLINE} instead`}
      </button>
    );
  }
  return (
    <div data-testid="moving-entry" style={{ marginBottom: 16 }}>
      <div style={{ ...styles.muted, fontWeight: 600 }}>Moving?</div>
      <div style={{ ...styles.subtle, marginTop: 2 }}>{MOVING_BODY}</div>
      <button type="button" onClick={open} disabled={busy} className="waves-focus-ring" style={{ ...styles.secondaryButton, marginTop: 10 }}>
        {busy ? 'Opening…' : MOVING_HEADLINE}
      </button>
    </div>
  );
}
