// Identity only: transcripts, customer data and confirmation credentials stay
// server-side. A fresh request key isolates simultaneous requests and retries.
export function ibSessionId() {
  let actor = 'session';
  try { actor = JSON.parse(localStorage.getItem('waves_admin_user') || '{}').id || actor; } catch { /* unavailable */ }
  const key = `waves_ib_session:${actor}`;
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
    return id;
  } catch { return crypto.randomUUID(); }
}

export function ibRequestIdentity() {
  return { session_id: ibSessionId(), request_key: crypto.randomUUID() };
}
