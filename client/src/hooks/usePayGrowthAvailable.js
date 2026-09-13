import { useEffect, useState } from 'react';
import { adminFetch } from '../lib/adminFetch';

// null while the availability request is pending, then true/false. Every
// consumer must treat anything but true as unavailable so the feature fails closed.
export default function usePayGrowthAvailable(authenticated = true) {
  const [available, setAvailable] = useState(null);
  useEffect(() => {
    setAvailable(null);
    if (!authenticated) return undefined;
    const controller = new AbortController();
    adminFetch('/tech/pay-growth/availability', { signal: controller.signal })
      .then(async response => {
        const payload = response.ok ? await response.json() : null;
        if (!controller.signal.aborted) setAvailable(payload?.available === true);
      }).catch(() => { if (!controller.signal.aborted) setAvailable(false); });
    return () => controller.abort();
  }, [authenticated]);
  return authenticated ? available : false;
}
