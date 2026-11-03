// Customer half of the hand-off bridge (Book at the Table). The Waves Admin app
// shows the secure card page in a separate, isolated web view and installs a
// restricted `wavesCustomer` message handler ONLY there. Its presence, with
// ?handoff=1 on the URL, is what puts the page into hand-off mode.
//
// The page cannot reach the signed-in admin page, so the app relays the one thing
// it needs. Page -> app (window.webkit.messageHandlers.wavesCustomer):
//
//   { type: 'acceptTerms', requestId, termsVersion, termsScope, consumerNoticeShown }
//
// and the app answers with a CustomEvent on window:
//
//   'waveshandoff:terms' { requestId, status: 'ok' | 'failed', message?, code? }
//
// termsScope ('plan' | 'base') is the scope of the terms the page showed; the server
// refuses the record with 409 terms_changed if the estimate's terms moved since.

export const TERMS_EVENT = 'waveshandoff:terms';
// The relay goes app -> admin page -> server and back; give up after this.
export const TERMS_TIMEOUT_MS = 30000;

// The server's 409 terms_changed text (the app forwards `message`, and `code` when it can).
export const TERMS_CHANGED_MESSAGE = 'The terms changed. Reload this page to see them.';

const NO_ANSWER = 'We could not record your acceptance. Please try again.';

/** True only in the app's isolated customer view (never in a browser or the admin view). */
export function hasCustomerHandoffBridge() {
  try { return Boolean(window.webkit?.messageHandlers?.wavesCustomer); } catch { return false; }
}

/** True when the URL asks for hand-off mode AND the app's customer handler exists. */
export function isHandoffMode(search) {
  return new URLSearchParams(search || '').get('handoff') === '1' && hasCustomerHandoffBridge();
}

function newRequestId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `terms-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Ask the app to record the customer's acceptance of the estimate terms.
 * Resolves { ok: true } on 'ok', else { ok: false, message }. Never rejects.
 */
export function requestTermsAcceptance({ termsVersion, termsScope, consumerNoticeShown }) {
  const requestId = newRequestId();
  return new Promise((resolve) => {
    let timer = null;
    const finish = (value) => {
      window.removeEventListener(TERMS_EVENT, onAnswer);
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    function onAnswer(event) {
      const detail = event?.detail || {};
      if (detail.requestId !== requestId) return;
      finish(detail.status === 'ok'
        ? { ok: true }
        : { ok: false, message: detail.message || NO_ANSWER, changed: detail.code === 'terms_changed' || detail.message === TERMS_CHANGED_MESSAGE });
    }
    window.addEventListener(TERMS_EVENT, onAnswer);
    timer = setTimeout(() => finish({ ok: false, message: NO_ANSWER }), TERMS_TIMEOUT_MS);
    try {
      window.webkit.messageHandlers.wavesCustomer.postMessage({
        type: 'acceptTerms',
        requestId,
        termsVersion,
        termsScope,
        consumerNoticeShown: consumerNoticeShown === true,
      });
    } catch {
      finish({ ok: false, message: NO_ANSWER });
    }
  });
}
