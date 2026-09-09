import { useEffect, useState } from 'react';
import { adminFetch } from '../lib/adminFetch';

// Read the deployment gate once at the Staff/Tech page boundary.
export default function useStaffDocumentsAvailable(authenticated = true) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    setAvailable(false);
    if (!authenticated) return undefined;
    const controller = new AbortController();
    adminFetch('/tech/staff-documents/availability', { signal: controller.signal })
      .then(async response => {
        const payload = response.ok ? await response.json() : null;
        if (!controller.signal.aborted) setAvailable(payload?.available === true);
      }).catch(() => { if (!controller.signal.aborted) setAvailable(false); });
    return () => controller.abort();
  }, [authenticated]);
  return authenticated && available;
}
