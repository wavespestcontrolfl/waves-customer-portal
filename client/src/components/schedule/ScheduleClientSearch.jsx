// Schedule client search — type a customer name to find their upcoming
// appointments from any schedule view, then jump straight to that day.
//
// Reuses the existing GET /admin/schedule/list endpoint, which filters by
// customer name and defaults to today-forward, so no server change is
// needed. Results are grouped by customer (a name like "Smith" can match
// several) and each row shows the service, date, and time window.
//
// ET-anchored: "from today" uses America/New_York (the business is in SW
// Florida) so a late-night search doesn't drop the current ET day.

import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { adminFetch } from '../../utils/admin-fetch';
import { etDateString, TIMEZONE } from '../../lib/timezone';
import { cn } from '../ui';

function parseHHMM(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return hh * 60 + mm;
}

function formatTimeLabel(mins) {
  if (mins == null) return '';
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ap = h24 < 12 ? 'AM' : 'PM';
  return m === 0 ? `${h12} ${ap}` : `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}

// "8–9 AM" when both ends are on the hour in the same meridiem; otherwise
// the full "8:00 AM – 9:30 AM" form.
function formatWindow(svc) {
  const startMins = parseHHMM(svc.windowStart);
  const endMins = parseHHMM(svc.windowEnd);
  if (startMins == null) return '';
  if (endMins == null) return formatTimeLabel(startMins);
  const startOnHour = startMins % 60 === 0;
  const endOnHour = endMins % 60 === 0;
  const sameMeridiem = startMins < 12 * 60 === endMins < 12 * 60;
  if (startOnHour && endOnHour && sameMeridiem) {
    const h24s = Math.floor(startMins / 60);
    const h24e = Math.floor(endMins / 60);
    const h12s = h24s % 12 === 0 ? 12 : h24s % 12;
    const h12e = h24e % 12 === 0 ? 12 : h24e % 12;
    const ap = h24s < 12 ? 'AM' : 'PM';
    return `${h12s}–${h12e} ${ap}`;
  }
  return `${formatTimeLabel(startMins)} – ${formatTimeLabel(endMins)}`;
}

function formatDateLabel(dateStr) {
  if (!dateStr) return '';
  if (dateStr === etDateString()) return 'Today';
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

// Group upcoming appointments by customer so a multi-match search ("Smith")
// reads as one block per person rather than a flat interleaved list. Results
// arrive already ordered by date from the endpoint; the grouping preserves
// that order within each customer and orders customers by their soonest appt.
function groupByCustomer(services) {
  const groups = new Map();
  services.forEach((svc) => {
    const key = svc.customerId || svc.customerName || svc.id;
    if (!groups.has(key)) {
      groups.set(key, { key, name: svc.customerName || 'Unknown customer', appts: [] });
    }
    groups.get(key).appts.push(svc);
  });
  return Array.from(groups.values());
}

export default function ScheduleClientSearch({ onSelect, className }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const inputRef = useRef(null);

  // Dismiss the results panel on an outside click/tap.
  useEffect(() => {
    const handle = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', handle, true);
    return () => document.removeEventListener('pointerdown', handle, true);
  }, []);

  // Debounced search. Omitting `status` lets the endpoint apply its default
  // (exclude cancelled/rescheduled) so only live upcoming appointments show.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      adminFetch(
        `/admin/schedule/list?search=${encodeURIComponent(q)}&from=${etDateString()}&limit=50`,
      )
        .then((d) => {
          if (cancelled) return;
          setResults(d.services || []);
          setError(null);
          setLoading(false);
        })
        .catch((e) => {
          if (cancelled) return;
          setError(e.message || 'Search failed');
          setResults([]);
          setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const clear = useCallback(() => {
    setQuery('');
    setResults([]);
    setError(null);
    inputRef.current?.focus();
  }, []);

  const handleSelect = useCallback(
    (svc) => {
      setOpen(false);
      onSelect?.(svc);
    },
    [onSelect],
  );

  const trimmed = query.trim();
  const showPanel = open && trimmed.length >= 2;
  const groups = groupByCustomer(results);

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div className="relative">
        <Search
          size={16}
          strokeWidth={1.75}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-tertiary pointer-events-none"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="text"
          inputMode="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search clients for upcoming appointments…"
          aria-label="Search clients for upcoming appointments"
          className="w-full h-11 md:h-10 pl-9 pr-9 text-16 md:text-13 rounded-sm bg-white border-hairline border-zinc-300 text-zinc-900 placeholder:text-ink-tertiary u-focus-ring"
        />
        {query && (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center h-7 w-7 text-ink-secondary hover:text-zinc-900 u-focus-ring rounded-xs"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        )}
      </div>

      {showPanel && (
        <div className="absolute left-0 right-0 top-full mt-1 z-40 bg-white border-hairline border-zinc-200 rounded-sm shadow-lg max-h-[60vh] overflow-y-auto">
          {loading && (
            <div className="px-3 py-3 text-13 text-ink-secondary">Searching…</div>
          )}
          {!loading && error && (
            <div className="px-3 py-3 text-13 text-alert-fg">{error}</div>
          )}
          {!loading && !error && results.length === 0 && (
            <div className="px-3 py-3 text-13 text-ink-secondary">
              No upcoming appointments for “{trimmed}”.
            </div>
          )}
          {!loading &&
            !error &&
            groups.map((group) => (
              <div
                key={group.key}
                className="border-b border-hairline border-zinc-100 last:border-b-0"
              >
                <div className="px-3 pt-2 pb-1 flex items-baseline justify-between gap-2">
                  <span className="text-13 font-medium text-zinc-900 truncate">
                    {group.name}
                  </span>
                  <span className="u-nums text-11 text-ink-tertiary whitespace-nowrap">
                    {group.appts.length} upcoming
                  </span>
                </div>
                {group.appts.map((svc) => (
                  <button
                    key={svc.id}
                    type="button"
                    onClick={() => handleSelect(svc)}
                    className="w-full text-left px-3 py-2 hover:bg-zinc-50 active:bg-zinc-100 u-focus-ring flex items-center justify-between gap-3"
                  >
                    <span className="text-13 text-zinc-700 truncate">
                      {svc.serviceType || 'Service'}
                    </span>
                    <span className="u-nums text-12 text-ink-secondary whitespace-nowrap">
                      {formatDateLabel(svc.scheduledDate)}
                      {formatWindow(svc) ? ` · ${formatWindow(svc)}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
