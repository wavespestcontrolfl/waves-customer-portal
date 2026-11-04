// Customer half of the hand-off bridge (Book at the Table). The Waves Admin app shows
// the secure card page in a separate, isolated web view and installs a restricted
// `wavesCustomer` message handler ONLY there. Its presence, with ?handoff=1 on the
// URL, is what puts the page into hand-off mode. The estimate terms are recorded by the
// page's own POST /accept-terms. The only messages the page sends the app are for the Tap
// to Pay card save, and only when the server says the tap save is on (askHandoffCapabilities,
// requestTapSave). Each is answered once by a window event carrying the same requestId:
//
//   { type: 'capabilities', requestId } -> 'waveshandoff:capabilities'
//        { requestId, capabilities: ['saveCard'] }
//   { type: 'saveCard', requestId, consentTextVersion, agreed, feeDisclosedAmount,
//     disclosureVersion } -> 'waveshandoff:savecard'
//        { requestId, status: 'succeeded', card } | { status: 'failed', message }
//        | { status: 'canceled' }

// The server's 409 terms_changed text; the page offers Reload on it.
export const TERMS_CHANGED_MESSAGE = 'The terms changed. Reload this page to see them.';

/** True only in the app's isolated customer view (never in a browser or the admin view). */
export function hasCustomerHandoffBridge() {
  try { return Boolean(window.webkit?.messageHandlers?.wavesCustomer); } catch { return false; }
}

/** True when the URL asks for hand-off mode AND the app's customer handler exists. */
export function isHandoffMode(search) {
  return new URLSearchParams(search || '').get('handoff') === '1' && hasCustomerHandoffBridge();
}

export const SAVE_CARD_CAPABILITY = 'saveCard';
// An older app build never answers `capabilities`: no answer means no capabilities.
const CAPABILITIES_TIMEOUT_MS = 1500;
const CAPABILITIES_EVENT = 'waveshandoff:capabilities';
const SAVE_CARD_EVENT = 'waveshandoff:savecard';
const SAVE_CARD_FAILED = 'We could not save that card. Please try again.';

function newRequestId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `handoff-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Posts `message` to the app and resolves with the matching answer's detail, or null when
// no answer comes within `timeoutMs` (omit it to wait as long as the app takes: a tap does).
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
      window.webkit.messageHandlers.wavesCustomer.postMessage({ ...message, requestId });
    } catch {
      finish(null);
    }
  });
}

/** What the app can do for this page: [] with no answer. */
export async function askHandoffCapabilities() {
  const detail = await ask({ type: 'capabilities' }, CAPABILITIES_EVENT, CAPABILITIES_TIMEOUT_MS);
  return Array.isArray(detail?.capabilities) ? detail.capabilities.filter((c) => typeof c === 'string') : [];
}

/**
 * Asks the app to save the customer's tapped card. Resolves { status: 'succeeded' } |
 * { status: 'failed', message } | { status: 'canceled' }; never rejects.
 */
export async function requestTapSave({ consentTextVersion, agreed, feeDisclosedAmount, disclosureVersion }) {
  const detail = await ask(
    { type: 'saveCard', consentTextVersion, agreed, feeDisclosedAmount: feeDisclosedAmount ?? null, disclosureVersion: disclosureVersion ?? null },
    SAVE_CARD_EVENT,
  );
  if (detail?.status === 'succeeded') return { status: 'succeeded' };
  if (detail?.status === 'canceled') return { status: 'canceled' };
  return { status: 'failed', message: typeof detail?.message === 'string' && detail.message ? detail.message : SAVE_CARD_FAILED };
}
