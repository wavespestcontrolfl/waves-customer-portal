import { useCallback, useEffect, useState } from 'react';
import { getAdminAuthToken } from '../../lib/adminAuth';

const API = import.meta.env.VITE_API_URL || '';
export const TRUCK_KIT_OFF = { enabled: false };

// GET /api/tech/truck-check (GATE_TRUCK_KIT): the signed-in technician's truck,
// its kit, the last check and whether one is due. The gate off answers 404
// { enabled: false }; any other failure throws so a page can offer a retry.
export async function fetchTruckKit(signal) {
  const res = await fetch(`${API}/api/tech/truck-check`, {
    headers: { Authorization: `Bearer ${getAdminAuthToken()}` },
    signal,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 404 && data?.enabled === false) return TRUCK_KIT_OFF;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// "Last checked 9 days ago" for the card and the page; whole days are enough.
export function lastCheckedLabel(checkedAt, now = new Date()) {
  if (!checkedAt) return 'Never checked';
  const at = new Date(checkedAt).getTime();
  if (!Number.isFinite(at)) return 'Never checked';
  const days = Math.floor(Math.max(0, now.getTime() - at) / 86400000);
  if (days === 0) return 'Checked today';
  if (days === 1) return 'Checked yesterday';
  return `Last checked ${days} days ago`;
}

// The Today card and the Tools tile read this once per mount. A read that
// fails leaves `data` null: the card and the tile simply stay away (the
// truck check page shows the error and a retry).
export default function useTruckKit() {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const load = useCallback(async (signal) => {
    setState((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const data = await fetchTruckKit(signal);
      if (!signal?.aborted) setState({ loading: false, data, error: '' });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setState({ loading: false, data: null, error: err?.message || 'Could not load your truck' });
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  // Stable, so a page can fold it into its own route refresh without churn.
  const reload = useCallback(() => load(), [load]);
  return { ...state, reload };
}
