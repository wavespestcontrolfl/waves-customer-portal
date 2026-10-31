// Shared launcher for Stripe Tap-to-Pay on iPhone.
//
// Calls POST /stripe/terminal/handoff to mint a 60-second signed JWT bound to
// invoice_id + amount + tech_user_id. In Safari it then follows the returned
// deep link into the WavesPay iOS app. Inside that same app (Waves Admin, which
// shows these staff pages in a web view) it hands the link to the app instead,
// so the payment never leaves the page. Either way the app validates the token,
// burns the jti, and drives the card_present PaymentIntent via Stripe Terminal.
//
// Never hand-roll a waves-tap:// or wavespay:// URL directly — the iOS app
// only accepts links carrying a live signed token.

import { adminFetch } from './adminFetch';
import { snapshotForHandoff } from './tapToPayReturn';
import { isWavesAdminApp } from '../native/platform';

// The app's one answer per request (ios/WavesPay/Sources/PortalView.swift):
// detail = { requestId, status: 'succeeded' | 'failed' | 'canceled',
//            invoiceId?, paymentIntentId?, message? }.
const IN_APP_RESULT_EVENT = 'wavesadmin:taptopay';

function collectInApp(deepLink) {
  const requestId = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `ttp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const onResult = (event) => {
      const detail = event?.detail || {};
      if (detail.requestId !== requestId) return;
      window.removeEventListener(IN_APP_RESULT_EVENT, onResult);
      resolve({
        inApp: true,
        status: detail.status,
        paymentIntentId: detail.paymentIntentId || null,
        message: detail.message || null,
      });
    };
    window.addEventListener(IN_APP_RESULT_EVENT, onResult);
    window.webkit.messageHandlers.wavesAdmin.postMessage({ type: 'tapToPay', requestId, deepLink });
  });
}

function isIPhoneLikeDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  return /iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// Safari: resolves with the handoff once WavesPay opens. Waves Admin: resolves
// when the payment ends, with { inApp: true, status, paymentIntentId, message }.
export async function launchTapToPay(invoiceId) {
  if (!isIPhoneLikeDevice()) {
    throw new Error('Tap to Pay requires WavesPay on an iPhone. Use Copy Link or Add payment here.');
  }

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

  if (isWavesAdminApp()) return collectInApp(data.deep_link);

  // Snapshot the current route so we can restore it if iOS evicts the tab
  // while the user is in WavesPay. See lib/tapToPayReturn.js.
  snapshotForHandoff();

  window.location.href = data.deep_link;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
    };
    const resolveOpened = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') resolveOpened();
    };
    const onPageHide = () => resolveOpened();

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('WavesPay did not open. Use Copy Link or Add payment.'));
    }, 1800);
  });
}
