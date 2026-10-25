import { useEffect, useState } from 'react';
import { adminFetch } from '../lib/adminFetch';

// null while the status request is pending, then true/false. Anything but true
// means the Payroll tab stays hidden, so it fails closed. Pass false for a
// non-admin: the route is admin only and nothing is requested.
export default function usePayrollAvailable(authenticated = true) {
  const [available, setAvailable] = useState(null);
  useEffect(() => {
    setAvailable(null);
    if (!authenticated) return undefined;
    const controller = new AbortController();
    adminFetch('/admin/payroll/status', { signal: controller.signal })
      .then(async response => {
        const payload = response.ok ? await response.json() : null;
        if (!controller.signal.aborted) setAvailable(payload?.enabled === true);
      }).catch(() => { if (!controller.signal.aborted) setAvailable(false); });
    return () => controller.abort();
  }, [authenticated]);
  return authenticated ? available : false;
}
