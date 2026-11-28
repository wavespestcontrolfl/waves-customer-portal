import { useEffect, useState } from 'react';
import { adminFetch } from '../lib/adminFetch';

// Read the deployment gate once at the Staff/Tech page boundary.
// Returns null while loading (when authenticated), true when enabled, false when off or failed.
export default function useStaffDocumentsAvailable(authenticated = true) {
  const [available, setAvailable] = useState(authenticated ? null : false);
  useEffect(() => {
    if (!authenticated) {
      setAvailable(false);
      return undefined;
    }
    setAvailable(null);
    const controller = new AbortController();
    adminFetch('/tech/staff-documents/availability', { signal: controller.signal })
      .then(async response => {
        const payload = response.ok ? await response.json() : null;
        if (!controller.signal.aborted) setAvailable(payload?.available === true);
      }).catch(() => { if (!controller.signal.aborted) setAvailable(false); });
    return () => controller.abort();
  }, [authenticated]);
  return authenticated ? available : false;
}
