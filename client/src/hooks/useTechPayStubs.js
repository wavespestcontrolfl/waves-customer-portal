import { useCallback, useEffect, useState } from 'react';
import { adminFetch } from '../lib/adminFetch';

// The caller's own pay stubs. One request. status is 'loading' | 'ready' | 'error'. Anything but
// 'ready' hides the tab, so it fails closed.
export default function useTechPayStubs() {
  const [state, setState] = useState({ status: 'loading', checks: [], error: '' });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    adminFetch('/tech/payroll/checks', { signal: controller.signal })
      .then(async response => {
        if (controller.signal.aborted) return;
        const payload = await response.json().catch(() => ({}));
        if (controller.signal.aborted) return;
        if (!response.ok || !Array.isArray(payload.checks)) {
          setState({ status: 'error', checks: [], error: payload.error || `Unable to load pay stubs (${response.status}).` });
          return;
        }
        setState({ status: 'ready', checks: payload.checks, error: '' });
      })
      .catch(() => { if (!controller.signal.aborted) setState({ status: 'error', checks: [], error: 'Unable to load pay stubs.' }); });
    return () => controller.abort();
  }, [reload]);
  const refresh = useCallback(() => setReload(value => value + 1), []);
  return { ...state, refresh };
}
