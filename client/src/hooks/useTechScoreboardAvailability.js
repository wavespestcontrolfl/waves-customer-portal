import { useEffect, useState } from 'react';
import { adminFetch } from '../lib/adminFetch';

// Whether the Scoreboard tab shows (GATE_TECH_REWARDS_SCOREBOARD): the one light request the Staff page makes on every load.
// It reads no figures; the board itself loads only when the tab opens (useTechScoreboard). status is
// 'loading' | 'off' | 'ready' | 'error'. Anything but 'ready' hides the tab, so it fails closed.
export default function useTechScoreboardAvailability() {
  const [state, setState] = useState({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    adminFetch('/tech/rewards-scoreboard/availability', { signal: controller.signal })
      .then(async response => {
        if (controller.signal.aborted) return;
        const payload = await response.json().catch(() => ({}));
        if (controller.signal.aborted) return;
        if (!response.ok) { setState({ status: 'error' }); return; }
        setState({ status: payload.available === true ? 'ready' : 'off' });
      })
      .catch(() => { if (!controller.signal.aborted) setState({ status: 'error' }); });
    return () => controller.abort();
  }, []);
  return state;
}
