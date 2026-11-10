import { useEffect, useState, useSyncExternalStore } from 'react';
import { getAdminAuthToken } from '../../lib/adminAuth';

// The client's API base (utils/admin-fetch.js, utils/api.js, FieldLeadModal.jsx): it already ends in /api.
const API = import.meta.env.VITE_API_URL || '/api';

// One call to the technician estimate tool (/api/tech/estimates). A refusal throws an Error that carries the
// server's own message plus `status` and `code`; a 404 `{ enabled: false }` has no message.
export async function techEstimateRequest(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}/tech/estimates${path}`, {
    method,
    headers: { Authorization: `Bearer ${getAdminAuthToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error || ''), { status: res.status, code: data?.code || null, enabled: data?.enabled });
  return data;
}

// Estimates that are no longer his to send from this page: the text went, the office has it (an office-only refusal), or
// the app cannot tell whether the text went. The Send button (TechEstimateSend.jsx) sets the lock and hides itself while
// it holds, so every view of the sheet agrees (the saved screen, the list, the detail), also a view that stayed mounted
// in the other tab, and also after the sheet is closed and opened again. The server can still say "draft" for such an
// estimate, so its answer alone is not enough. The lock lasts until the page loads again.
const sendLocks = new Set();
const lockListeners = new Set();
let lockVersion = 0;
const lockChanged = () => { lockVersion += 1; lockListeners.forEach((listener) => listener()); };
export const lockSend = (id) => { if (!sendLocks.has(String(id))) { sendLocks.add(String(id)); lockChanged(); } };
export const sendLocked = (id) => sendLocks.has(String(id));
export const clearSendLocks = () => { sendLocks.clear(); lockChanged(); };
const subscribeLocks = (listener) => { lockListeners.add(listener); return () => lockListeners.delete(listener); };
// Draws the caller again when a lock changes; read the lock itself with sendLocked(id).
export const useSendLocks = () => useSyncExternalStore(subscribeLocks, () => lockVersion);

// GET /api/tech/estimates/setup, once for the field workspace. The server answers { enabled: false } (a plain 200, so
// the browser logs no failed request) while the gate or this technician's switch is off; then (and on any failure) the
// answer is null and nothing of the tool shows. A setup with no service he may quote also reads as off.
export default function useTechEstimateSetup() {
  const [setup, setSetup] = useState(null);
  useEffect(() => {
    let live = true;
    techEstimateRequest('/setup')
      .then((data) => {
        const services = Array.isArray(data?.services) ? data.services : [];
        if (live && data?.enabled === true && services.length > 0) {
          setSetup({ services, oneTimeHoldDollars: Number(data.oneTimeHoldDollars) || 1000 });
        }
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return setup;
}
