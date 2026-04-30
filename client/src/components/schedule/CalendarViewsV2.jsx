/**
 * CalendarViewsV2.jsx
 * client/src/components/schedule/CalendarViewsV2.jsx
 *
 * Monochrome Week/Month calendar views for the redesigned Dispatch (V2) page.
 * Strict 1:1 with V1 CalendarViews on:
 *   - endpoints (/admin/schedule/week, /admin/schedule/month)
 *   - slice counts (5 services/day in Week, 3/day in Month)
 *   - summary stats (total, completed, pending, unique + byCategory + byTech)
 *   - click behavior (onDateClick switches back to day view)
 *
 * Visual differences vs V1:
 *   - Zinc palette, no teal/amber/purple accents
 *   - Hairline borders, no colored tinted backgrounds
 *   - Category dots collapse to zinc-900 / zinc-300 (status-based), not color-coded
 *   - Uppercase labels via .u-label, tabular numerals via .u-nums
 *   - No emoji icons
 */

import { useState, useEffect, useCallback } from 'react';
import { Card, CardBody, cn } from '../ui';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  pointerWithin,
} from '@dnd-kit/core';
import RescheduleConfirmModal from './RescheduleConfirmModal';
import { etDateString } from '../../lib/timezone';

function formatDayLabel(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function minutesToLabelMonth(min) {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ap = h24 < 12 ? 'AM' : 'PM';
  return m === 0 ? `${h12} ${ap}` : `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}

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
      throw new Error(text || `HTTP ${r.status}`);
    }
    return r.json();
  });
}

function parseHHMM(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function minutesToHHMM(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}


// ─── VIEW MODE SELECTOR ──────────────────────────────────────────

const ALL_MODES = [
  { id: 'day', label: 'Day' },
  { id: '5day', label: '5-Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
];

export function ViewModeSelectorV2({ viewMode, onViewModeChange, allowed }) {
  const modes = allowed
    ? ALL_MODES.filter((m) => allowed.includes(m.id))
    : ALL_MODES;

  // Newsletter-style separate-pill buttons (Dashboard / Compose / History
  // pattern from NewsletterPage.jsx) — gap between each, hairline border
  // that flips to a solid black pill when active.
  return (
    <div className="inline-flex flex-wrap gap-1.5">
      {modes.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onViewModeChange(m.id)}
          className={cn(
            'h-8 px-3 text-11 uppercase font-medium tracking-label rounded-sm border-hairline u-focus-ring transition-colors',
            viewMode === m.id
              ? 'bg-zinc-900 text-white border-zinc-900'
              : 'bg-white text-zinc-700 border-zinc-300 hover:bg-zinc-50',
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}


// ─── WEEK VIEW ───────────────────────────────────────────────────

export function WeekViewV2({ startDate, onDateClick }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const d = new Date(startDate + 'T12:00:00');
    const day = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    const mondayStr = etDateString(monday);

    adminFetch(`/admin/schedule/week?start=${mondayStr}`)
      .then((res) => { setData(res); setLoading(false); })
      .catch(() => setLoading(false));
  }, [startDate]);

  if (loading) return <div className="py-10 text-center text-13 text-ink-secondary">Loading week…</div>;
  if (!data?.days) return null;

  const today = etDateString(new Date());
  const totalServices = data.days.reduce((sum, d) => sum + d.count, 0);
  const completedServices = data.days.reduce(
    (sum, d) => sum + d.services.filter((s) => s.status === 'completed').length,
    0
  );

  return (
    <div>
      {/* Week grid — horizontal scroll on mobile (≤768px); 7 equal cols on desktop */}
      <div className="-mx-4 md:mx-0 overflow-x-auto mb-4">
        <div className="grid grid-cols-7 gap-2 px-4 md:px-0 min-w-[700px]">
        {data.days.map((day) => {
          const isToday = day.date === today;
          const isSelected = day.date === startDate;
          const isWeekend = new Date(day.date + 'T12:00:00').getDay() % 6 === 0;
          const dim = isWeekend && day.count === 0;

          return (
            <button
              key={day.date}
              onClick={() => onDateClick(day.date)}
              className={cn(
                'text-left bg-white rounded-md p-3 transition-colors u-focus-ring min-h-[140px]',
                'border-hairline',
                isToday
                  ? 'border-zinc-900 ring-1 ring-zinc-900'
                  : isSelected
                    ? 'border-zinc-900'
                    : 'border-zinc-200 hover:bg-zinc-50',
                dim && 'opacity-60'
              )}
            >
              {/* Day header */}
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="u-label text-ink-secondary">{day.dayOfWeek}</div>
                  <div className="u-nums text-22 font-medium tracking-tight mt-0.5 text-zinc-900 leading-none">
                    {day.dayNum}
                  </div>
                </div>
                {day.count > 0 && (
                  <span className="u-nums text-12 font-medium text-zinc-900">
                    {day.count}
                  </span>
                )}
              </div>

              {/* Service list (compact) */}
              <div className="space-y-0.5">
                {day.services.slice(0, 5).map((s) => (
                  <div
                    key={s.id}
                    className={cn(
                      'text-11 truncate',
                      s.status === 'completed' ? 'line-through text-ink-tertiary' : 'text-ink-primary'
                    )}
                  >
                    {s.customerName?.split(' ')[0] || '—'}
                  </div>
                ))}
              </div>
              {day.count > 5 && (
                <div className="text-11 text-ink-tertiary mt-1">
                  +{day.count - 5} more
                </div>
              )}

              {/* Zone dots — all zinc, count signals density not category */}
              {Object.keys(day.zones || {}).length > 0 && (
                <div className="flex gap-1 mt-2 flex-wrap">
                  {Object.entries(day.zones).map(([zone, count]) => (
                    <span
                      key={zone}
                      title={`${zone}: ${count}`}
                      className="u-dot u-dot--filled"
                    />
                  ))}
                </div>
              )}
            </button>
          );
        })}
        </div>
      </div>

      {/* Week summary bar */}
      <Card>
        <CardBody className="py-3 px-5 flex items-center justify-center gap-6 text-12 text-ink-secondary">
          <span>
            <strong className="u-nums text-zinc-900 font-medium">{totalServices}</strong>{' '}
            services this week
          </span>
          <span className="u-hairline w-px h-4 bg-zinc-200" aria-hidden />
          <span>
            <strong className="u-nums text-zinc-900 font-medium">{completedServices}</strong>{' '}
            completed
          </span>
        </CardBody>
      </Card>
    </div>
  );
}


// ─── MONTH VIEW ──────────────────────────────────────────────────

// Flat-blue month-cell chip: solid pill with "time · customer" stacked
// across the row. Mirrors the appointment-block palette in
// TimeGridDay/TimeGridDays so the calendar reads as one visual system.
function MonthServiceChip({ service }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `msvc-${service.id}`,
    data: { service },
  });
  const startMin = parseHHMM(service.windowStart);
  const time = startMin != null ? minutesToLabelMonth(startMin) : '';
  const completed = service.status === 'completed';
  const fill = completed
    ? null                    // bg-zinc-200 via class — faded done state
    : service.status === 'en_route'
      ? '#1E40AF'             // deeper blue — actively heading
      : service.status === 'on_site'
        ? '#18181B'           // black — active here
        : service.status === 'skipped'
          ? null              // class handles alert-bg/alert-fg
          : '#3B82F6';        // default scheduled / confirmed fill

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        'text-11 truncate leading-tight cursor-grab active:cursor-grabbing select-none px-1.5 py-0.5 rounded-xs',
        completed && 'bg-zinc-200 text-zinc-500 line-through',
        service.status === 'skipped' && 'bg-alert-bg text-alert-fg',
        !completed && service.status !== 'skipped' && 'text-white',
        isDragging && 'opacity-60'
      )}
      style={{
        background: fill || undefined,
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        zIndex: isDragging ? 50 : undefined,
      }}
      title={`${service.customerName} · ${service.serviceType || ''} · ${service.windowStart || ''}${service.techName ? ' · ' + service.techName : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      {time && <span className="font-medium mr-1">{time}</span>}
      <span>{service.customerName || '—'}</span>
    </div>
  );
}

function MonthDayCell({ day, di, onDateClick }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `mday-${day.date}`,
    data: { date: day.date },
  });
  return (
    <div
      ref={setNodeRef}
      role="button"
      tabIndex={0}
      onClick={() => onDateClick(day.date)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDateClick(day.date); }
      }}
      className={cn(
        'text-left min-h-[56px] md:min-h-[120px] p-1 md:p-1.5 transition-colors u-focus-ring cursor-pointer',
        day.isToday ? 'bg-zinc-50' : 'bg-white hover:bg-zinc-50',
        !day.isCurrentMonth && 'opacity-40',
        isOver && 'bg-zinc-100 ring-1 ring-zinc-400 ring-inset'
      )}
      style={di < 6 ? { borderRight: '1px solid #E4E4E7' } : undefined}
    >
      {/* Day number */}
      <div className="flex items-center justify-between mb-1">
        <span
          className={cn(
            'u-nums text-13',
            day.isToday
              ? 'font-medium text-white bg-zinc-900 rounded-full w-6 h-6 inline-flex items-center justify-center'
              : 'text-ink-primary'
          )}
        >
          {day.dayNum}
        </span>
        {day.count > 0 && (
          <span className="u-nums text-11 font-medium text-ink-tertiary">
            {day.count}
          </span>
        )}
      </div>

      {/* Flat-blue chip stack — desktop only; mobile cells keep just the
          day number + total. Chips show time + customer name on a solid
          blue pill, mirroring the swimlane block palette. */}
      <div className="hidden md:block space-y-1">
        {day.services.slice(0, 6).map((s) => (
          <MonthServiceChip key={s.id} service={s} />
        ))}
      </div>
      {day.count > 6 && (
        <div className="hidden md:block text-11 text-ink-tertiary mt-1">
          +{day.count - 6} more
        </div>
      )}
    </div>
  );
}

export function MonthViewV2({ date, onDateClick }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [optimistic, setOptimistic] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);

  const yearMonth = date.slice(0, 7); // "2026-04"

  const reload = useCallback(() => {
    setOptimistic(null);
    return adminFetch(`/admin/schedule/month?month=${yearMonth}`)
      .then((res) => { setData(res); setLoading(false); return res; })
      .catch(() => setLoading(false));
  }, [yearMonth]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const onDragEnd = useCallback((event) => {
    const { active, over } = event;
    if (!over) return;
    const svc = active.data.current?.service;
    const drop = over.data.current;
    if (!svc || !drop?.date) return;

    const weeks = (optimistic?.weeks || data?.weeks || []);
    let fromDate = null;
    for (const w of weeks) {
      for (const d of w) {
        if (d.services?.some((s) => s.id === svc.id)) { fromDate = d.date; break; }
      }
      if (fromDate) break;
    }
    const toDate = drop.date;
    if (!fromDate || fromDate === toDate) return;

    const startMin = parseHHMM(svc.windowStart);
    const dur = svc.duration || 30;
    const newWindow = startMin != null
      ? `${minutesToHHMM(startMin)}-${minutesToHHMM(startMin + dur)}`
      : '08:00-09:00';

    const source = optimistic || data;
    const nextWeeks = source.weeks.map((w) => w.map((d) => {
      if (d.date === fromDate) {
        const filtered = d.services.filter((s) => s.id !== svc.id);
        return { ...d, services: filtered, count: filtered.length };
      }
      if (d.date === toDate) {
        const added = [...d.services, svc];
        return { ...d, services: added, count: added.length };
      }
      return d;
    }));
    setOptimistic({ ...source, weeks: nextWeeks });

    setPending({
      svc,
      toDate,
      newWindow,
      fromDate,
      fromMinutes: startMin,
      toDateLabel: toDate,
      toMinutes: startMin,
    });
  }, [data, optimistic]);

  const commitReschedule = useCallback(async ({ notificationType, scope }) => {
    if (!pending) return;
    const { svc, toDate, newWindow } = pending;
    setBusy(true);
    try {
      await adminFetch(`/admin/dispatch/${svc.id}/reschedule`, {
        method: 'POST',
        body: JSON.stringify({
          newDate: toDate,
          newWindow,
          reasonCode: 'dispatch_drag',
          reasonText: 'Rescheduled via drag-and-drop on month grid',
          notifyCustomer: notificationType === 'sms',
          scope: scope || 'this_only',
        }),
      });
      await reload();
      setPending(null);
    } catch (err) {
      alert('Reschedule failed: ' + err.message);
      setOptimistic(null);
      setPending(null);
    } finally {
      setBusy(false);
    }
  }, [pending, reload]);

  const cancelReschedule = useCallback(() => {
    setOptimistic(null);
    setPending(null);
  }, []);

  const viewData = optimistic || data;

  if (loading) return <div className="py-10 text-center text-13 text-ink-secondary">Loading calendar…</div>;
  if (!viewData?.weeks) return null;

  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const { summary } = viewData;

  const SUMMARY_STATS = [
    { label: 'Total Services', value: summary.totalServices },
    { label: 'Completed', value: summary.completed },
    { label: 'Pending', value: summary.pending },
    { label: 'Unique Customers', value: summary.uniqueCustomers },
  ];

  return (
    <div>
      {/* Month summary stats — desktop only; mobile goes straight to the grid */}
      <div className="hidden md:grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {SUMMARY_STATS.map((stat) => (
          <Card key={stat.label}>
            <CardBody className="p-4 text-center">
              <div className="u-nums text-22 font-medium tracking-tight text-zinc-900 leading-none">
                {stat.value}
              </div>
              <div className="u-label text-ink-secondary mt-2">{stat.label}</div>
            </CardBody>
          </Card>
        ))}
      </div>

      {/* Category breakdown (monochrome chips) — desktop only */}
      {Object.keys(summary.byCategory || {}).length > 0 && (
        <div className="hidden md:flex gap-2 mb-4 flex-wrap">
          {Object.entries(summary.byCategory)
            .sort(([, a], [, b]) => b - a)
            .map(([cat, count]) => (
              <span
                key={cat}
                className="inline-flex items-center gap-2 text-11 px-2.5 h-6 rounded-sm bg-white text-ink-secondary"
                style={{ border: '1px solid #E4E4E7' }}
              >
                <span className="u-dot u-dot--filled" />
                <span className="lowercase">{cat}</span>
                <span className="u-nums text-zinc-900 font-medium">{count}</span>
              </span>
            ))}
        </div>
      )}

      {/* Calendar grid — drag blocks to reschedule across days */}
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={onDragEnd}>
        <div className="-mx-4 md:mx-0 md:overflow-visible overflow-x-auto">
        <Card className="overflow-hidden md:min-w-0">
          {/* Day of week headers */}
          <div
            className="grid grid-cols-7 bg-zinc-50"
            style={{ borderBottom: '1px solid #E4E4E7' }}
          >
            {DOW.map((d) => (
              <div key={d} className="u-label text-ink-secondary py-2 text-center">
                {d}
              </div>
            ))}
          </div>

          {/* Weeks */}
          {viewData.weeks.map((week, wi) => (
            <div
              key={wi}
              className="grid grid-cols-7"
              style={wi < viewData.weeks.length - 1 ? { borderBottom: '1px solid #E4E4E7' } : undefined}
            >
              {week.map((day, di) => (
                <MonthDayCell key={day.date} day={day} di={di} onDateClick={onDateClick} />
              ))}
            </div>
          ))}
        </Card>
        </div>
        {busy && (
          <div className="mt-2 text-11 text-ink-secondary text-center">Saving…</div>
        )}
      </DndContext>

      <RescheduleConfirmModal
        open={!!pending}
        customerName={pending?.svc?.customerName}
        fromDate={pending?.fromDate || ''}
        fromMinutes={pending?.fromMinutes}
        toDate={pending?.toDateLabel || ''}
        toMinutes={pending?.toMinutes}
        isRecurring={!!pending?.svc?.isRecurring}
        onConfirm={commitReschedule}
        onCancel={cancelReschedule}
      />

      {/* Tech workload for the month — desktop only */}
      {Object.keys(summary.byTech || {}).length > 0 && (
        <Card className="hidden md:block mt-4">
          <CardBody className="p-4">
            <div className="u-label text-ink-secondary mb-3">
              Tech Workload — {viewData.monthName}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {Object.entries(summary.byTech)
                .sort(([, a], [, b]) => b - a)
                .map(([tech, count]) => {
                  const pct = summary.totalServices
                    ? Math.round((count / summary.totalServices) * 100)
                    : 0;
                  return (
                    <div
                      key={tech}
                      className="rounded-sm bg-white p-3"
                      style={{ border: '1px solid #E4E4E7' }}
                    >
                      <div className="flex items-baseline justify-between">
                        <div className="text-13 font-medium text-ink-primary">{tech}</div>
                        <span className="u-nums text-12 font-medium text-zinc-900">
                          {count}
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 bg-zinc-100 rounded-sm overflow-hidden">
                        <div
                          className="h-full bg-zinc-900 transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

export default { ViewModeSelectorV2, WeekViewV2, MonthViewV2 };
