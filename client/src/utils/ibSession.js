// Identity only: transcripts, customer data and confirmation credentials stay
// server-side. A fresh request key isolates simultaneous requests and retries.
import { v4 as uuid } from 'uuid';

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
