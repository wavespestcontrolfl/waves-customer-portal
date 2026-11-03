// Customer half of the hand-off bridge (Book at the Table). The Waves Admin app shows
// the secure card page in a separate, isolated web view and installs a restricted
// `wavesCustomer` message handler ONLY there. Its presence, with ?handoff=1 on the
// URL, is what puts the page into hand-off mode. The page sends the app nothing: the
// estimate terms are recorded by the page's own POST /accept-terms.

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
