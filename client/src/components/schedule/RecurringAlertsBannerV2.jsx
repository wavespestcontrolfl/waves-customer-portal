// client/src/components/schedule/RecurringAlertsBannerV2.jsx
// Monochrome V2 of RecurringAlertsBanner. Strict 1:1 on data and behavior:
//   - GET  /admin/schedule/recurring-alerts  (fetch list)
//   - POST /admin/schedule/recurring-alerts/:id/action { action, count: 4 }
//   - same 3 actions: extend (+4 visits), convert_ongoing, let_lapse
// Visual changes: banner uses alert-bg/alert-fg (these ARE alerts requiring
// action); warning emoji dropped; action buttons flatten to zinc+alert pattern.
import { useState, useEffect, useCallback } from 'react';
import { Button, cn } from '../ui';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  }).then(async (r) => {
    if (r.status === 401) { window.location.href = '/admin/login'; throw new Error('Session expired'); }
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(text || `${r.status} ${r.statusText}`);
    }
    return r.json();
  });
}

export default function RecurringAlertsBannerV2() {
  const [alerts, setAlerts] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await adminFetch('/admin/schedule/recurring-alerts');
      setAlerts(r.alerts || []);
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (row, action) => {
    setBusyId(row.id);
    try {
      await adminFetch(`/admin/schedule/recurring-alerts/${row.id}/action`, {
        method: 'POST',
        body: JSON.stringify({ action, count: 4 }),
      });
      await load();
    } catch (e) {
      window.alert('Failed: ' + e.message);
    }
    setBusyId(null);
  };

  if (!alerts.length) return null;

  return (
    <div className="bg-alert-bg border-hairline border-alert-fg/30 rounded-sm p-3 mb-3">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center justify-between u-focus-ring"
      >
        <span className="text-13 font-medium text-alert-fg">
          {alerts.length} recurring plan{alerts.length === 1 ? '' : 's'} ending soon
        </span>
        <span className="u-label text-alert-fg">{expanded ? 'Hide' : 'Review'}</span>
      </button>

      {expanded && (
        <div className="mt-3 flex flex-col gap-2">
          {alerts.map((a) => (
            <div
              key={a.id}
              className="bg-white border-hairline border-zinc-200 rounded-sm p-3 flex flex-wrap items-center gap-3"
            >
              <div className="flex-1 min-w-[200px]">
                <div className="text-13 font-medium text-ink-primary">{a.customerName || 'Customer'}</div>
                <div className="text-11 text-ink-secondary mt-0.5">
                  {a.serviceType} · {a.pattern} · last visit {a.lastVisitDate || '—'} · {a.remainingVisits ?? 0} pending
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busyId === a.id}
                  onClick={() => act(a, 'extend')}
                >
                  +4 visits
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busyId === a.id}
                  onClick={() => act(a, 'convert_ongoing')}
                >
                  Convert to ongoing
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyId === a.id}
                  onClick={() => act(a, 'let_lapse')}
                >
                  Let lapse
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
