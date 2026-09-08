// Identity only: transcripts, customer data and confirmation credentials stay
// server-side. A request key isolates simultaneous requests; one logical
// request keeps its key until the server answers, so a dropped response is
// replayed as the saved task instead of running the request a second time.
function uuid() {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Without session storage every surface on the page still shares one
// session for the lifetime of the page, so saved tasks stay reachable.
let fallbackSession = null;

export function ibSessionId() {
  let actor = 'session';
  try { actor = JSON.parse(localStorage.getItem('waves_admin_user') || '{}').id || actor; } catch { /* unavailable */ }
  const key = `waves_ib_session:${actor}`;
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const id = uuid();
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    fallbackSession ||= uuid();
    return fallbackSession;
  }
}

// begin(request) hands out the identity for that serialized request body. The
// key survives a transport or server error, so resubmitting the same request
// replays the server's saved task; it changes only when the request changes
// or settle(identity) records a definitive answer for THAT identity. A stale
// request answered after a newer one began (navigation or Clear released the
// submit guard mid-flight) leaves the newer key in place, so a dropped
// response to the newer request still replays its saved task on retry.
export function createRequestIdentity(sessionId = ibSessionId()) {
  let pending = null;
  return {
    begin(request) {
      if (!pending || pending.request !== request) pending = { request, request_key: uuid() };
      return { session_id: sessionId, request_key: pending.request_key };
    },
    settle(identity) { if (pending && identity?.request_key === pending.request_key) pending = null; },
  };
}
