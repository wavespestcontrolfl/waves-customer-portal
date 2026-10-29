import { useCallback, useEffect, useState } from 'react';
import { adminFetch } from '../lib/adminFetch';

// The caller's own pay stubs (GATE_TECH_PAY_STUBS). One request: a 404 means the gate is off, so the Pay stubs
// tab stays hidden and nothing else is asked. status is 'loading' | 'off' | 'ready' | 'error'. Anything but
// 'ready' hides the tab, so it fails closed.
export default function useTechPayStubs(enabled = true) {
  const [state, setState] = useState({ status: 'loading', checks: [], error: '' });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!enabled) { setState({ status: 'off', checks: [], error: '' }); return undefined; }
    const controller = new AbortController();
    adminFetch('/tech/payroll/checks', { signal: controller.signal })
      .then(async response => {
        if (controller.signal.aborted) return;
        if (response.status === 404) { setState({ status: 'off', checks: [], error: '' }); return; }
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
  }, [enabled, reload]);
  const refresh = useCallback(() => setReload(value => value + 1), []);
  return { ...state, refresh };
}
