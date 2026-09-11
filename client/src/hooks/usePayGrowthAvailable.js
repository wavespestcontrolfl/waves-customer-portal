import { useEffect, useState } from 'react';
import { adminFetch } from '../lib/adminFetch';

export default function usePayGrowthAvailable(authenticated = true) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    setAvailable(false);
    if (!authenticated) return undefined;
    const controller = new AbortController();
    adminFetch('/tech/pay-growth/availability', { signal: controller.signal })
      .then(async response => {
        const payload = response.ok ? await response.json() : null;
        if (!controller.signal.aborted) setAvailable(payload?.available === true);
      }).catch(() => { if (!controller.signal.aborted) setAvailable(false); });
    return () => controller.abort();
  }, [authenticated]);
  return authenticated && available;
}
