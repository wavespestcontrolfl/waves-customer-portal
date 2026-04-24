// Full-screen picker shown from MobileCheckoutSheet's "Add Service" button.
// Mirrors the Jobber-style "Add Service" reference: X-close header, search
// bar, scrollable list of services with thumbnail + duration + price.
//
// onSelect(service) is called with the chosen service object. The caller is
// responsible for prompting for a price when pricing_type is variable/quoted.

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
    ...opts,
  }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

function formatDuration(m) {
  const n = Number(m || 0);
  if (!n) return '';
  if (n === 60) return '1 hr';
  if (n % 60 === 0) return `${n / 60} hr`;
  if (n < 60) return `${n} min`;
  return `${Math.floor(n / 60)} hr ${n % 60} min`;
}

function formatPrice(s) {
  if (s.pricing_type === 'variable' || s.pricing_type === 'quoted') return 'Variable';
  const p = Number(s.base_price || 0);
  return p ? `$${p.toFixed(0)}` : 'Variable';
}

export default function MobileServicePickerSheet({ onClose, onSelect }) {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    adminFetch('/admin/services?is_active=true&limit=500')
      .then((d) => { setServices(d.services || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const q = query.trim().toLowerCase();
  const list = services
    .filter((s) => !q || (s.name || '').toLowerCase().includes(q))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return (
    <div className="fixed inset-0 z-[110] bg-white overflow-y-auto md:hidden">
      <div
        className="sticky top-0 bg-white border-b border-hairline border-zinc-200 flex items-center px-3"
        style={{ height: 56, paddingTop: 'env(safe-area-inset-top, 0)' }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex items-center justify-center h-11 w-11 u-focus-ring text-zinc-900"
        >
          <X size={22} strokeWidth={1.75} />
        </button>
        <div className="flex-1 text-center font-medium text-zinc-900" style={{ fontSize: 16 }}>
          Add Service
        </div>
        <div className="w-11" />
      </div>

      <div className="px-4 pt-4 pb-10 mx-auto" style={{ maxWidth: 640 }}>
        <div className="relative mb-3">
          <span aria-hidden className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-tertiary" style={{ fontSize: 14 }}>⌕</span>
          <input
            type="search"
            inputMode="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search All Services"
            className="block w-full bg-white text-14 text-ink-primary border border-hairline border-zinc-200 rounded-sm h-12 pl-10 pr-4 focus:outline-none focus:ring-2 focus:ring-zinc-900"
          />
        </div>

        {loading ? (
          <div className="p-10 text-center text-ink-secondary" style={{ fontSize: 13 }}>Loading…</div>
        ) : list.length === 0 ? (
          <div className="p-10 text-center text-ink-secondary" style={{ fontSize: 13 }}>No services</div>
        ) : (
          <div className="flex flex-col">
            {list.map((s) => {
              const duration = formatDuration(s.default_duration_minutes);
              const price = formatPrice(s);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onSelect?.(s)}
                  className="flex items-center gap-3 py-3 border-b border-hairline border-zinc-200 cursor-pointer hover:bg-zinc-50 text-left u-focus-ring"
                >
                  <div
                    className="flex items-center justify-center rounded-sm shrink-0"
                    style={{ width: 56, height: 56, background: s.color || '#BFDBFE' }}
                    aria-hidden
                  >
                    <img src="/waves-logo.png" alt="" className="w-10 h-10 object-contain" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-ink-primary truncate" style={{ fontSize: 15 }}>{s.name}</div>
                    {duration && (
                      <div className="text-ink-tertiary truncate" style={{ fontSize: 12, marginTop: 2 }}>{duration}</div>
                    )}
                  </div>
                  <div className="u-nums font-medium text-ink-primary shrink-0" style={{ fontSize: 14 }}>{price}</div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
