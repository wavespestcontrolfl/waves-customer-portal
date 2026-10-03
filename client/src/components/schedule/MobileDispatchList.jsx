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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Leaf, MapPin, ShieldCheck } from 'lucide-react';
import WavesMark from '../brand/WavesMark';
import { Badge } from '../ui';
import { serviceColor } from '../../lib/service-colors';
import { TIMEZONE, etDateString, etParts, isETToday, addETDays } from '../../lib/timezone';
import InlineTechPicker from './InlineTechPicker';
import QuickActionMenu from './QuickActionMenu';
import DispatchReadinessStrip from './DispatchReadinessStrip';
import { openHoursForDay, hourToHHMM, formatOpenHour } from './openHours';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
  }).then(async (r) => {
    if (!r.ok) throw new Error(await r.text().catch(() => `${r.status}`));
    return r.json();
  });
}

function serviceDisplayName(service) {
  return service?.serviceTypeDisplay || service?.serviceType || '';
}

function googleMapsDirectionsUrl(address) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address || '')}&travelmode=driving`;
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

function formatTimeLabel(hhmm, { compact = false } = {}) {
  const mins = parseHHMM(hhmm);
  if (mins == null) return '';
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ap = h24 < 12 ? 'AM' : 'PM';
  if (compact && m === 0) return `${h12} ${ap}`;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}

// Compact window: "8–9 AM" when both ends are on the hour in the same meridiem;
// otherwise fall back to the full "8:00 AM – 9:30 AM" form.
function formatWindow(svc) {
  const startMins = parseHHMM(svc.windowStart);
  const endMins = parseHHMM(svc.windowEnd);
  if (startMins == null) return '—';
  if (endMins == null) return formatTimeLabel(svc.windowStart);
  const startOnHour = startMins % 60 === 0;
  const endOnHour = endMins % 60 === 0;
  const sameMeridiem = Math.floor(startMins / 60) < 12 === Math.floor(endMins / 60) < 12;
  if (startOnHour && endOnHour && sameMeridiem) {
    const h24s = Math.floor(startMins / 60);
    const h24e = Math.floor(endMins / 60);
    const h12s = h24s % 12 === 0 ? 12 : h24s % 12;
    const h12e = h24e % 12 === 0 ? 12 : h24e % 12;
    const ap = h24s < 12 ? 'AM' : 'PM';
    return `${h12s}–${h12e} ${ap}`;
  }
  return `${formatTimeLabel(svc.windowStart)} – ${formatTimeLabel(svc.windowEnd)}`;
}

// Tie-proximity display order (server, GATE_SCHEDULE_TIE_PROXIMITY):
// `displayOrder` is a 0-based index within ONE technician's day. This list
// can mix techs, so a pairwise "use displayOrder if same tech" comparator
// would be non-transitive. Instead each stop gets one fixed key: walking a
// tech's stops in displayOrder, its effective start is the max of its own
// windowStart and the previous stop's effective start. That key never
// decreases along a tech's order, so sorting by (effective start, then
// displayOrder) keeps each tech's proximity order and interleaves techs by
// time. Absent displayOrder (gate off) = plain windowStart order.
function effectiveStarts(services) {
  const eff = new Map();
  const byTech = new Map();
  services.forEach((s) => {
    if (!s.technicianId || s.displayOrder == null || parseHHMM(s.windowStart) == null) return;
    if (!byTech.has(s.technicianId)) byTech.set(s.technicianId, []);
    byTech.get(s.technicianId).push(s);
  });
  byTech.forEach((list) => {
    let prev = -Infinity;
    [...list].sort((a, b) => a.displayOrder - b.displayOrder).forEach((s) => {
      prev = Math.max(prev, parseHHMM(s.windowStart));
      eff.set(s, prev);
    });
  });
  return eff;
}

// Full lexicographic key (start, displayOrder, original index): a total
// order, so another tech's equal-time row sitting between two of one tech's
// stops can't shield that pair from being put in displayOrder.
function sortByWindow(services) {
  const eff = effectiveStarts(services);
  return services
    .map((s, i) => ({
      s,
      i,
      start: eff.has(s) ? eff.get(s) : parseHHMM(s.windowStart),
      order: eff.has(s) ? s.displayOrder : Infinity,
    }))
    .sort((a, b) => {
      if (a.start == null && b.start == null) return a.i - b.i;
      if (a.start == null) return 1;
      if (b.start == null) return -1;
      if (a.start !== b.start) return a.start - b.start;
      if (a.order !== b.order) return a.order < b.order ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.s);
}

function canMarkEnRoute(service) {
  return ['pending', 'confirmed', 'rescheduled'].includes(service?.status);
}

function isLawnService(service) {
  return /lawn|turf/.test(String(service?.serviceType || '').toLowerCase());
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

function AppointmentRow({ service, onEdit, onEnRoute, onProtocol, onTreatmentPlan, onViewAudit, owesCompletion, technicians, onQuickAction, onRefresh }) {
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

  const [showTechPicker, setShowTechPicker] = useState(false);
  const [showQuickMenu, setShowQuickMenu] = useState(false);
  const techBtnRef = useRef(null);
  const longPressTimer = useRef(null);
  const longPressTriggered = useRef(false);

  const handlePointerDown = useCallback(() => {
    longPressTriggered.current = false;
    if (!onQuickAction) return;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      setShowQuickMenu(true);
    }, 500);
  }, [onQuickAction]);
  const handlePointerUp = useCallback(() => {
    clearTimeout(longPressTimer.current);
  }, []);
  const handlePointerCancel = useCallback(() => {
    clearTimeout(longPressTimer.current);
  }, []);

  const showTreatmentPlan = isLawnService(service) && Boolean(onTreatmentPlan);
  const showProtocol = Boolean(onProtocol);
  const showAudit =
    service.status === 'completed' &&
    Boolean(onViewAudit) &&
    Boolean(service.customerId || service.customer_id);
  const showEnRoute = Boolean(onEnRoute) && canMarkEnRoute(service);
  const showNavigate = Boolean(service.address);
  const canAssignTechnician = (technicians || []).length > 0 || Boolean(service.technicianId);
  const hasActions =
    canAssignTechnician || showTreatmentPlan || showProtocol || showAudit || showEnRoute || showNavigate;

  const actionBtnClass =
    'inline-flex items-center justify-center h-11 flex-1 min-w-0 border-hairline border-zinc-300 rounded-xs text-zinc-700 bg-white hover:bg-zinc-50 active:bg-zinc-100 font-medium';
  const primaryBtnClass =
    'inline-flex items-center justify-center h-11 flex-1 min-w-0 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800 font-medium';

  return (
    <div
      className="flex items-stretch bg-white border-b border-hairline border-zinc-200"
    >
      <span
        aria-hidden
        style={{ width: 4, background: accent, borderRadius: 2, flexShrink: 0 }}
      />
      <div className="flex-1 min-w-0" style={{ padding: '12px 14px' }}>
        <button
          type="button"
          onClick={() => { if (!longPressTriggered.current) onEdit?.(service); }}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onContextMenu={(e) => e.preventDefault()}
          className="block w-full text-left bg-white active:bg-zinc-50 u-focus-ring"
        >
          <span className="flex items-baseline gap-2 flex-wrap">
            <span className="font-medium text-zinc-900" style={{ fontSize: 15 }}>
              {displayName}
            </span>
            {service.tier && <Badge tone="neutral">{service.tier}</Badge>}
            {owesCompletion?.(service) && (
              // Completed but the closeout (invoice / report / text) is still
              // owed — tapping the row reopens the completion panel to resume.
              <Badge tone="alert">Closeout owed</Badge>
            )}
            {service.prepaidAmount != null && Number(service.prepaidAmount) > 0 && (
              <span
                className="inline-flex items-center rounded-full uppercase tracking-label font-medium"
                style={{
                  height: 18,
                  padding: '0 8px',
                  background: '#DCFCE7',
                  color: '#166534',
                  fontSize: 10,
                }}
                title={service.prepaidSeriesContext?.totalCoveredVisits > 1
                  ? `Visit ${service.prepaidSeriesContext.visitNumber || '?'} of ${service.prepaidSeriesContext.totalVisitsInSeries} on a prepaid plan`
                  : 'Prepaid'}
              >
                Paid
              </span>
            )}
          </span>
          {service.address && (
            <span
              className="block text-ink-secondary"
              style={{ fontSize: 13, marginTop: 2, wordBreak: 'break-word' }}
            >
              {service.address}
            </span>
          )}
          {serviceDisplayName(service) && (
            <span
              className="block text-ink-secondary"
              style={{ fontSize: 13, marginTop: 1 }}
            >
              {serviceDisplayName(service)}
            </span>
          )}
          <span
            className="block u-nums text-ink-tertiary"
            style={{ fontSize: 12, marginTop: 3 }}
          >
            {formatWindow(service)}
          </span>
        </button>
        <DispatchReadinessStrip readiness={service.readiness} onOpen={onProtocol ? () => onProtocol(service) : null} className="mt-2" />
        {hasActions && (
          <div className="flex items-stretch gap-2 flex-wrap" style={{ marginTop: 10 }}>
            {canAssignTechnician && (
              <div className="relative flex flex-1 min-w-0" ref={techBtnRef}>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setShowTechPicker(!showTechPicker); }}
                  className={primaryBtnClass}
                  style={{ fontSize: 13 }}
                  title={service.technicianName
                    ? `${service.technicianName} — tap to reassign`
                    : 'Assign technician'}
                  aria-label={service.technicianName
                    ? `Technician: ${service.technicianName}`
                    : 'Assign technician'}
                >
                  {techInitial || 'Assign'}
                </button>
                {showTechPicker && (
                  <InlineTechPicker
                    serviceId={service.id}
                    currentTechId={service.technicianId}
                    technicians={technicians || []}
                    onAssigned={() => { onRefresh?.(); }}
                    onClose={() => setShowTechPicker(false)}
                    anchorRect={techBtnRef.current?.getBoundingClientRect()}
                  />
                )}
              </div>
            )}
            {showTreatmentPlan && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onTreatmentPlan(service); }}
                className={actionBtnClass}
                title="Treatment plan"
                aria-label="Treatment plan"
              >
                <Leaf size={16} strokeWidth={1.75} />
              </button>
            )}
            {showProtocol && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  e.currentTarget.focus({ preventScroll: true });
                  onProtocol(service);
                }}
                className={actionBtnClass}
                title="Protocol"
                aria-label="Protocol"
              >
                <BookOpen size={16} strokeWidth={1.75} />
              </button>
            )}
            {showAudit && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onViewAudit(service); }}
                className={actionBtnClass}
                title="View completion audit"
                aria-label="View completion audit"
              >
                <ShieldCheck size={16} strokeWidth={1.75} />
              </button>
            )}
            {showEnRoute && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onEnRoute(service); }}
                className={actionBtnClass}
                title="Tech En Route"
                aria-label="Tech En Route"
              >
                <WavesMark size={16} fill="#009CDE" title="Waves logo" />
              </button>
            )}
            {showNavigate && (
              <a
                href={googleMapsDirectionsUrl(service.address)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className={primaryBtnClass}
                title="Open in Google Maps"
                aria-label={`Open ${service.address} in Google Maps`}
              >
                <MapPin size={16} strokeWidth={1.75} />
              </a>
            )}
          </div>
        )}
      </div>
      {showQuickMenu && onQuickAction && (
        <QuickActionMenu
          service={service}
          isMobile
          onReschedule={(svc) => onQuickAction('reschedule', svc)}
          onCancel={(svc) => onQuickAction('cancel', svc)}
          onMarkPrepaid={(svc) => onQuickAction('markPrepaid', svc)}
          onClose={() => setShowQuickMenu(false)}
        />
      )}
    </div>
  );
}

// An empty hour in the day list: tapping it opens New appointment with the
// day and hour filled in.
function OpenHourRow({ hour, onBook }) {
  return (
    <div className="bg-zinc-50 border-b border-hairline border-zinc-200" style={{ padding: '6px 10px' }}>
      <button
        type="button"
        onClick={onBook}
        className="flex items-center w-full text-left rounded-xs border border-dashed border-zinc-300 bg-zinc-50 hover:border-zinc-900 hover:bg-white active:bg-white u-focus-ring"
        style={{ height: 44, padding: '0 12px', gap: 12 }}
        aria-label={`Book open hour ${formatOpenHour(hour)}`}
      >
        <span className="u-nums font-medium text-zinc-900" style={{ fontSize: 14, minWidth: 92 }}>
          {formatOpenHour(hour)}
        </span>
        <span className="text-ink-tertiary" style={{ fontSize: 14 }}>Open</span>
        <span className="ml-auto font-medium text-ink-secondary" style={{ fontSize: 13 }}>+ Book</span>
      </button>
    </div>
  );
}

// Appointments in list order with each open hour placed before the first
// visit that starts after it.
function withOpenHours(sorted, openHours) {
  const rows = [];
  const pending = [...openHours];
  sorted.forEach((svc) => {
    const start = parseHHMM(svc.windowStart);
    while (pending.length && start != null && pending[0] * 60 < start) {
      rows.push({ hour: pending.shift() });
    }
    rows.push({ svc });
  });
  pending.forEach((hour) => rows.push({ hour }));
  return rows;
}

function DaySegment({ dateStr, services, rainChance, onEdit, onEnRoute, onProtocol, onTreatmentPlan, onViewAudit, owesCompletion, technicians, onQuickAction, onRefresh, onCreateSlot }) {
  const sorted = useMemo(() => sortByWindow(services || []), [services]);
  const openHours = useMemo(
    () => (onCreateSlot ? openHoursForDay(dateStr, services || []) : []),
    [onCreateSlot, dateStr, services],
  );
  const rows = useMemo(() => withOpenHours(sorted, openHours), [sorted, openHours]);
  // One tech on the roster: the open hour is theirs.
  const soleTechId = (technicians || []).length === 1 ? technicians[0].id : undefined;
  const today = isETToday(dateStr);
  return (
    <section>
      <header
        className="sticky top-0 z-10 bg-white border-b border-hairline border-zinc-200 flex items-center justify-between"
        style={{ padding: '8px 14px', height: 36 }}
      >
        <span className="flex items-center" style={{ gap: 8 }}>
          <span
            className={
              'uppercase tracking-label font-medium ' +
              (today ? 'text-zinc-900' : 'text-ink-secondary')
            }
            style={{ fontSize: 11 }}
          >
            {headerLabel(dateStr)}
          </span>
          {/* Exception-based rain chip: only at ≥40% (amber), ≥50 alert-red —
              same thresholds as the week grids / dispatch weather bar. */}
          {rainChance != null && rainChance >= 40 && (
            <span
              className={
                'u-nums font-medium ' +
                (rainChance >= 50 ? 'text-alert-fg' : 'text-amber-700')
              }
              style={{ fontSize: 11 }}
              title={`${rainChance}% chance of rain`}
            >
              {rainChance}% rain
            </span>
          )}
        </span>
        <span className="u-nums text-ink-tertiary" style={{ fontSize: 11 }}>
          {sorted.length} {sorted.length === 1 ? 'appt' : 'appts'}
          {openHours.length > 0 && (
            <span className="text-zinc-900 font-medium"> · {openHours.length} open</span>
          )}
        </span>
      </header>
      {rows.length === 0 ? (
        <div
          className="text-ink-tertiary italic"
          style={{ padding: '14px', fontSize: 13 }}
        >
          No appointments
        </div>
      ) : (
        rows.map(({ svc, hour }) => (svc ? (
          <AppointmentRow
            key={svc.id}
            service={svc}
            onEdit={onEdit}
            onEnRoute={onEnRoute}
            onProtocol={onProtocol}
            onTreatmentPlan={onTreatmentPlan}
            onViewAudit={onViewAudit}
            owesCompletion={owesCompletion}
            technicians={technicians}
            onQuickAction={onQuickAction}
            onRefresh={onRefresh}
          />
        ) : (
          <OpenHourRow
            key={`open-${hour}`}
            hour={hour}
            onBook={() => onCreateSlot({
              date: dateStr,
              windowStart: hourToHHMM(hour),
              windowEnd: hourToHHMM(hour + 1),
              techId: soleTechId,
            })}
          />
        )))
      )}
    </section>
  );
}

export default function MobileDispatchList({ mode, date, services, rainChance, refreshKey, onEdit, onEnRoute, onProtocol, onTreatmentPlan, onViewAudit, owesCompletion, technicians, onQuickAction, onRefresh, onCreateSlot }) {
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
    // refreshKey bumps when a parent mutation (e.g. a rain-out that moves a
    // stop to another day) invalidates the cached week list.
  }, [mode, weekStart, refreshKey]);

  const handleEnRoute = useCallback(async (service) => {
    const succeeded = await onEnRoute?.(service);
    if (mode !== 'week' || succeeded === false) return;
    setWeekData((previous) => {
      if (!previous) return previous;
      return {
        ...previous,
        days: (previous.days || []).map((day) => ({
          ...day,
          services: (day.services || []).map((item) =>
            item.id === service.id ? { ...item, status: 'en_route' } : item,
          ),
        })),
      };
    });
  }, [mode, onEnRoute]);

  if (mode === 'day') {
    return (
      <div className="bg-white">
        <DaySegment
          dateStr={date}
          services={services || []}
          rainChance={rainChance}
          onEdit={onEdit}
          onEnRoute={onEnRoute ? handleEnRoute : undefined}
          onProtocol={onProtocol}
          onTreatmentPlan={onTreatmentPlan}
          onViewAudit={onViewAudit}
          owesCompletion={owesCompletion}
          technicians={technicians}
          onQuickAction={onQuickAction}
          onRefresh={onRefresh}
          onCreateSlot={onCreateSlot}
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
          rainChance={d.rainChance}
          onEdit={onEdit}
          onEnRoute={onEnRoute ? handleEnRoute : undefined}
          onProtocol={onProtocol}
          onTreatmentPlan={onTreatmentPlan}
          onViewAudit={onViewAudit}
          owesCompletion={owesCompletion}
          technicians={technicians}
          onQuickAction={onQuickAction}
          onRefresh={onRefresh}
          onCreateSlot={onCreateSlot}
        />
      ))}
    </div>
  );
}
