import { useEffect, useState } from 'react';
import { adminFetch } from '../lib/adminFetch';

// The caller's own rewards scoreboard (GATE_TECH_REWARDS_SCOREBOARD). One request: a 404 means the gate is off, so the
// Scoreboard tab stays hidden. status is 'loading' | 'off' | 'ready' | 'error'. Anything but 'ready' hides the tab,
// so it fails closed.
export default function useTechScoreboard(enabled = true) {
  const [state, setState] = useState({ status: 'loading', scoreboard: null, error: '' });
  useEffect(() => {
    if (!enabled) { setState({ status: 'off', scoreboard: null, error: '' }); return undefined; }
    const controller = new AbortController();
    adminFetch('/tech/rewards-scoreboard', { signal: controller.signal })
      .then(async response => {
        if (controller.signal.aborted) return;
        if (response.status === 404) { setState({ status: 'off', scoreboard: null, error: '' }); return; }
        const payload = await response.json().catch(() => ({}));
        if (controller.signal.aborted) return;
        if (!response.ok || !payload.scoreboard) {
          setState({ status: 'error', scoreboard: null, error: payload.error || `Unable to load the scoreboard (${response.status}).` });
          return;
        }
        setState({ status: 'ready', scoreboard: payload.scoreboard, error: '' });
      })
      .catch(() => { if (!controller.signal.aborted) setState({ status: 'error', scoreboard: null, error: 'Unable to load the scoreboard.' }); });
    return () => controller.abort();
  }, [enabled]);
  return state;
}
