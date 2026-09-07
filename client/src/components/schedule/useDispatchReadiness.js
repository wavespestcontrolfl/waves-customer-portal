import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const PENDING = { issues: [{ kind: 'readiness', status: 'unknown', label: 'Checking readiness…' }] };
const UNAVAILABLE = { issues: [{ kind: 'readiness', status: 'unknown', label: 'Check unavailable' }] };

// One reader at the page boundary, shared by the desktop grid and phone list.
// Batches stay small; old dates, assignments and late responses never carry
// their checks into the next schedule snapshot. Nothing is persisted locally.
export default function useDispatchReadiness({ services, date, active }) {
  const [snapshot, setSnapshot] = useState(null);

  useEffect(() => {
    setSnapshot(null);
    if (!active || !services?.length) return;
    const ids = [...new Set(services.filter(service =>
      ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'].includes(service.status),
    ).map(service => service.id))];
    if (!ids.length) return;
    let cancelled = false;
    let enabled = false;
    let controller;
    let timer;

    async function refresh() {
      clearTimeout(timer);
      controller?.abort();
      const request = new AbortController();
      controller = request;
      const visits = Object.fromEntries(ids.map(id => [id, PENDING]));
      const publish = () => {
        if (!cancelled && !request.signal.aborted) setSnapshot({ services, date, enabled, visits: { ...visits } });
      };
      publish();
      for (let offset = 0; offset < ids.length; offset += 6) {
        const batch = ids.slice(offset, offset + 6);
        const timeout = setTimeout(() => request.abort(), 30000);
        try {
          const response = await fetch(`${API_BASE}/admin/protocols/job-card/readiness?serviceIds=${batch.join(',')}`, {
            signal: request.signal,
            headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
            cache: 'no-store',
          });
          if (!response.ok) throw new Error('Readiness unavailable');
          const body = await response.json();
          if (cancelled || request.signal.aborted) return;
          enabled = body.enabled === true;
          if (!enabled) { publish(); return; }
          const returned = new Map((body.visits || []).map(visit => [visit.serviceId, visit]));
          for (const id of batch) visits[id] = returned.get(id) || UNAVAILABLE;
          publish();
        } catch {
          if (cancelled || controller !== request) return;
          for (const id of ids.slice(offset)) visits[id] = UNAVAILABLE;
          // A timed-out signal cannot publish via the normal success path.
          setSnapshot({ services, date, enabled, visits: { ...visits } });
          break;
        } finally {
          clearTimeout(timeout);
        }
      }
      if (!cancelled) timer = setTimeout(() => {
        if (document.visibilityState !== 'hidden') void refresh();
      }, 60000);
    }

    const onVisible = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    void refresh();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      cancelled = true;
      controller?.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [services, date, active]);

  return active && snapshot?.services === services && snapshot.date === date && snapshot.enabled
    ? snapshot.visits
    : null;
}
