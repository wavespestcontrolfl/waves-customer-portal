import { useEffect, useState } from 'react';
import { getAdminAuthToken } from '../../lib/adminAuth';

const API = import.meta.env.VITE_API_URL || '';

// One call to the technician estimate tool (/api/tech/estimates). A refusal throws an Error that carries the
// server's own message plus `status` and `code`; a 404 `{ enabled: false }` has no message.
export async function techEstimateRequest(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}/api/tech/estimates${path}`, {
    method,
    headers: { Authorization: `Bearer ${getAdminAuthToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error || ''), { status: res.status, code: data?.code || null, enabled: data?.enabled });
  return data;
}

// GET /api/tech/estimates/setup, once for the field workspace. The server answers 404 { enabled: false } while the
// gate or this technician's switch is off; then (and on any failure) the answer is null and nothing of the tool
// shows. A setup with no service he may quote also reads as off.
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
