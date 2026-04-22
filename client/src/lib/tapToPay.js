// Shared launcher for Stripe Tap-to-Pay on iPhone.
//
// Calls POST /stripe/terminal/handoff to mint a 60-second signed JWT bound to
// invoice_id + amount + tech_user_id, then follows the returned deep link into
// the native iOS shell. The native app validates the token, burns the jti, and
// drives the card_present PaymentIntent via Stripe Terminal SDK.
//
// Never hand-roll a waves-tap:// or wavespay:// URL directly — the iOS app
// only accepts links carrying a live signed token.

import { adminFetch } from './adminFetch';
import { snapshotForHandoff } from './tapToPayReturn';

export async function launchTapToPay(invoiceId) {
  const r = await adminFetch('/stripe/terminal/handoff', {
    method: 'POST',
    body: { invoice_id: invoiceId },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => `${r.status}`);
    throw new Error(text || `Handoff failed (${r.status})`);
  }
  const data = await r.json();
  if (!data.deep_link) throw new Error('Handoff returned no deep link');

  // Snapshot the current route so we can restore it if iOS evicts the tab
  // while the user is in WavesPay. See lib/tapToPayReturn.js.
  snapshotForHandoff();

  window.location.href = data.deep_link;
  return data;
}
