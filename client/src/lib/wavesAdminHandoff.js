// Admin half of the hand-off bridge to the Waves Admin iPhone app (Book at the
// Table). The booked sheet asks what the app can do and, when it can open the
// hand-off, asks it to show the secure card page to the customer in a separate,
// isolated web view (no admin sign-in is reachable from it). Same message style
// as lib/tapToPay.js: a message to window.webkit.messageHandlers.wavesAdmin, and
// the app answers with a CustomEvent on window carrying the same requestId.
//
//   { type: 'capabilities', requestId } -> 'wavesadmin:capabilities'
//        { requestId, capabilities: ['handoffOpen', ...] }
//   { type: 'handoffOpen', requestId, url, firstName } -> 'wavesadmin:handoff'
//        { requestId, status: 'ended' | 'failed', message? }
//
// Older app builds and desktop browsers never answer; a missing answer to
// `capabilities` within CAPABILITIES_TIMEOUT_MS means "no capabilities".

import { isWavesAdminApp } from '../native/platform';

export const CAPABILITIES_TIMEOUT_MS = 800;
export const HANDOFF_OPEN = 'handoffOpen';

const CAPABILITIES_EVENT = 'wavesadmin:capabilities';
const HANDOFF_EVENT = 'wavesadmin:handoff';

function newRequestId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `handoff-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Post `message` and resolve with the matching answer's detail, or null when no
// answer arrives in `timeoutMs` (omit it to wait for as long as the app takes).
function ask(message, eventName, timeoutMs) {
  const requestId = newRequestId();
  return new Promise((resolve) => {
    let timer = null;
    const finish = (value) => {
      window.removeEventListener(eventName, onAnswer);
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    function onAnswer(event) {
      const detail = event?.detail || {};
      if (detail.requestId === requestId) finish(detail);
    }
    window.addEventListener(eventName, onAnswer);
    if (timeoutMs) timer = setTimeout(() => finish(null), timeoutMs);
    try {
      window.webkit.messageHandlers.wavesAdmin.postMessage({ ...message, requestId });
    } catch {
      finish(null);
    }
  });
}

/** What the hosting app can do for this page: [] outside the app or with no answer. */
export async function getAdminCapabilities() {
  if (!isWavesAdminApp()) return [];
  const detail = await ask({ type: 'capabilities' }, CAPABILITIES_EVENT, CAPABILITIES_TIMEOUT_MS);
  return Array.isArray(detail?.capabilities) ? detail.capabilities : [];
}

/**
 * Ask the app to show `url` to the customer. Resolves when the hand-off ends with
 * { status: 'ended' | 'failed', message? }. The admin tab never navigates.
 */
export async function openHandoff({ url, firstName }) {
  const detail = await ask({ type: 'handoffOpen', url, firstName: firstName || '' }, HANDOFF_EVENT);
  return { status: detail?.status === 'ended' ? 'ended' : 'failed', message: detail?.message || null };
}
