// Mobile-only scrollable list view for Dispatch.
//
// Replaces the mobile time-grid calendar. Two modes:
//   mode="day"   → single section, today's appointments.
//                  Services come from the parent (already fetched by the
//                  Dispatch page from /admin/schedule?date=).
//   mode="week"  → 7 segments starting Monday of the week `date` falls in.
//                  Fetches /admin/schedule/week?start=<ET-monday>.
//
// ET-anchored: "today," week anchoring, and section headers all compute
// against America/New_York — the business is in SW Florida. No UTC.

import { useEffect, useMemo, useState } from 'react';
import { Leaf, ShieldCheck, Truck } from 'lucide-react';
import { Badge } from '../ui';
import { serviceColor } from '../../lib/service-colors';
import { TIMEZONE, etDateString, etParts, isETToday, addETDays } from '../../lib/timezone';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
  }).then(async (r) => {
    if (!r.ok) throw new Error(await r.text().catch(() => `${r.status}`));
    return r.json();
  });
}

// Monday of the ET week that contains `dateStr` ('YYYY-MM-DD'). Returned
// as the same 'YYYY-MM-DD' shape so it can go straight into the API call.
function mondayOfETWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const { dayOfWeek } = etParts(d);
  const offset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek; // Sun → back 6, else back to Mon
  return etDateString(addETDays(d, offset));
}

function parseHHMM(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return hh * 60 + mm;
}

function formatTimeLabel(hhmm) {
  const mins = parseHHMM(hhmm);
  if (mins == null) return '';
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ap = h24 < 12 ? 'AM' : 'PM';
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}

function formatWindow(svc) {
  const start = formatTimeLabel(svc.windowStart);
  const end = formatTimeLabel(svc.windowEnd);
  if (!start) return '—';
  if (!end) return start;
  return `${start} – ${end}`;
}

function sortByWindow(services) {
  return [...services].sort((a, b) => {
    const ax = parseHHMM(a.windowStart);
    const bx = parseHHMM(b.windowStart);
    if (ax == null && bx == null) return 0;
    if (ax == null) return 1;
    if (bx == null) return -1;
    return ax - bx;
  });
}

function canMarkEnRoute(service) {
  return ['pending', 'confirmed', 'rescheduled'].includes(service?.status);
}

function isLawnService(service) {
  return String(service?.serviceType || '').toLowerCase().includes('lawn');
}

// Human section header for each day segment.
// Today / Tomorrow / else weekday + month-day.
function headerLabel(dateStr) {
  if (isETToday(dateStr)) return 'Today';
  const tomorrow = etDateString(addETDays(new Date(), 1));
  if (dateStr === tomorrow) return 'Tomorrow';
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

function AppointmentRow({ service, onEdit, onEnRoute, onTreatmentPlan, onViewAudit }) {
  const name = String(service.customerName || '').trim();
  const customerMissing = !name;
  const needsAttention =
    service.status === 'skipped' || !service.technicianId || customerMissing;

  const accent = needsAttention
    ? '#C0392B'
    : service.status === 'completed'
    ? '#A1A1AA'
    : serviceColor(service.serviceType).bg;

  const displayName = customerMissing ? 'Unassigned' : name;
  const techInitial = service.technicianName
    ? service.technicianName.trim().charAt(0).toUpperCase()
    : '';

  return (
    <div
      className="flex items-stretch gap-2 bg-white border-b border-hairline border-zinc-200"
      style={{ padding: '12px 14px 12px 0' }}
    >
      <span
        aria-hidden
        style={{ width: 4, background: accent, borderRadius: 2, flexShrink: 0 }}
      />
      <button
        type="button"
        onClick={() => onEdit?.(service)}
        className="flex-1 min-w-0 flex items-center gap-3 bg-white active:bg-zinc-50 u-focus-ring text-left"
      >
        <span className="flex-1 min-w-0">
          <span className="flex items-baseline gap-2">
            <span
              className="font-medium text-zinc-900 truncate"
              style={{ fontSize: 15 }}
            >
              {displayName}
            </span>
            {service.tier && <Badge tone="neutral">{service.tier}</Badge>}
          </span>
          {service.serviceType && (
            <span
              className="block truncate text-ink-secondary"
              style={{ fontSize: 13, marginTop: 1 }}
            >
              {service.serviceType}
            </span>
          )}
          <span
            className="block u-nums text-ink-tertiary"
            style={{ fontSize: 12, marginTop: 3 }}
          >
            {formatWindow(service)}
          </span>
        </span>
      </button>
      {techInitial && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onEdit?.(service); }}
          className="inline-flex items-center justify-center h-11 w-11 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800 shrink-0 self-center font-medium"
          style={{ fontSize: 13 }}
          title={service.technicianName}
          aria-label={`Technician: ${service.technicianName}`}
        >
          {techInitial}
        </button>
      )}
      {isLawnService(service) && onTreatmentPlan && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onTreatmentPlan(service); }}
          className="inline-flex items-center justify-center h-11 w-11 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800 shrink-0 self-center"
          title="Treatment plan"
          aria-label="Treatment plan"
        >
          <Leaf size={18} strokeWidth={1.75} />
        </button>
      )}
      {service.status === 'completed' && onViewAudit && (service.customerId || service.customer_id) && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onViewAudit(service); }}
          className="inline-flex items-center justify-center h-11 w-11 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800 shrink-0 self-center"
          title="View completion audit"
          aria-label="View completion audit"
        >
          <ShieldCheck size={18} strokeWidth={1.75} />
        </button>
      )}
      {onEnRoute && canMarkEnRoute(service) && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onEnRoute(service); }}
          className="inline-flex items-center justify-center h-11 w-11 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800 shrink-0 self-center"
          title="Tech En Route"
          aria-label="Tech En Route"
        >
          <Truck size={18} strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}

function DaySegment({ dateStr, services, onEdit, onEnRoute, onTreatmentPlan, onViewAudit }) {
  const sorted = useMemo(() => sortByWindow(services || []), [services]);
  const today = isETToday(dateStr);
  return (
    <section>
      <header
        className="sticky top-0 z-10 bg-white border-b border-hairline border-zinc-200 flex items-center justify-between"
        style={{ padding: '8px 14px', height: 36 }}
      >
        <span
          className={
            'uppercase tracking-label font-medium ' +
            (today ? 'text-zinc-900' : 'text-ink-secondary')
          }
          style={{ fontSize: 11 }}
        >
          {headerLabel(dateStr)}
        </span>
        <span className="u-nums text-ink-tertiary" style={{ fontSize: 11 }}>
          {sorted.length} {sorted.length === 1 ? 'appt' : 'appts'}
        </span>
      </header>
      {sorted.length === 0 ? (
        <div
          className="text-ink-tertiary italic"
          style={{ padding: '14px', fontSize: 13 }}
        >
          No appointments
        </div>
      ) : (
        sorted.map((svc) => (
          <AppointmentRow
            key={svc.id}
            service={svc}
            onEdit={onEdit}
            onEnRoute={onEnRoute}
            onTreatmentPlan={onTreatmentPlan}
            onViewAudit={onViewAudit}
          />
        ))
      )}
    </section>
  );
}

export default function MobileDispatchList({ mode, date, services, onEdit, onEnRoute, onTreatmentPlan, onViewAudit }) {
  const [weekData, setWeekData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const weekStart = useMemo(
    () => (mode === 'week' ? mondayOfETWeek(date) : null),
    [mode, date],
  );

  useEffect(() => {
    if (mode !== 'week') return;
    setLoading(true);
    setError(null);
    adminFetch(`/admin/schedule/week?start=${weekStart}`)
      .then((j) => {
        setWeekData(j);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message || 'Failed to load week');
        setLoading(false);
      });
  }, [mode, weekStart]);

  if (mode === 'day') {
    return (
      <div className="bg-white">
        <DaySegment
          dateStr={date}
          services={services || []}
          onEdit={onEdit}
          onEnRoute={onEnRoute}
          onTreatmentPlan={onTreatmentPlan}
          onViewAudit={onViewAudit}
        />
      </div>
    );
  }

  if (loading && !weekData) {
    return (
      <div className="py-10 text-center text-13 text-ink-secondary">
        Loading week…
      </div>
    );
  }
  if (error) {
    return (
      <div className="py-10 text-center text-13 text-alert-fg">{error}</div>
    );
  }

  const days = weekData?.days || [];
  return (
    <div className="bg-white">
      {days.map((d) => (
        <DaySegment
          key={d.date}
          dateStr={d.date}
          services={d.services || []}
          onEdit={onEdit}
          onEnRoute={onEnRoute}
          onTreatmentPlan={onTreatmentPlan}
          onViewAudit={onViewAudit}
        />
      ))}
    </div>
  );
}
