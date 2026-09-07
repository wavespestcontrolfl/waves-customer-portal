// Identity only: transcripts, customer data and confirmation credentials stay
// server-side. A fresh request key isolates simultaneous requests and retries.
function uuid() {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
  } catch { return uuid(); }
}

export function ibRequestIdentity(sessionId = ibSessionId()) {
  return { session_id: sessionId, request_key: uuid() };
}
