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

function formatDateISO(d) { return d.toISOString().split('T')[0]; }

// ─── VIEW MODE SELECTOR ──────────────────────────────────────────

export function ViewModeSelectorV2({ viewMode, onViewModeChange }) {
  const modes = [
    { id: 'day', label: 'Day' },
    { id: '5day', label: '5-Day' },
    { id: 'week', label: 'Week' },
    { id: 'month', label: 'Month' },
  ];

  return (
    <div className="inline-flex items-center border-hairline border-zinc-200 rounded-sm overflow-hidden bg-white">
      {modes.map((m) => (
        <button
          key={m.id}
          onClick={() => onViewModeChange(m.id)}
          className={cn(
            'h-8 px-4 text-11 uppercase tracking-label font-medium u-focus-ring transition-colors',
            viewMode === m.id
              ? 'bg-zinc-900 text-white'
              : 'bg-white text-ink-secondary hover:bg-zinc-50'
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
    const mondayStr = formatDateISO(monday);

    adminFetch(`/admin/schedule/week?start=${mondayStr}`)
      .then((res) => { setData(res); setLoading(false); })
      .catch(() => setLoading(false));
  }, [startDate]);

  if (loading) return <div className="py-10 text-center text-13 text-ink-secondary">Loading week…</div>;
  if (!data?.days) return null;

  const today = formatDateISO(new Date());
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

function MonthServiceChip({ service }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `msvc-${service.id}`,
    data: { service },
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        'text-11 truncate leading-tight cursor-grab active:cursor-grabbing select-none',
        service.status === 'completed' ? 'line-through text-ink-tertiary' : 'text-ink-primary',
        isDragging && 'opacity-60'
      )}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        zIndex: isDragging ? 50 : undefined,
      }}
      title={`${service.customerName} · ${service.serviceType || ''} · ${service.windowStart || ''}${service.techName ? ' · ' + service.techName : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      {service.customerName?.split(' ')[0] || '—'}
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
        'text-left min-h-[90px] p-2 transition-colors u-focus-ring cursor-pointer',
        day.isToday ? 'bg-zinc-50' : 'bg-white hover:bg-zinc-50',
        !day.isCurrentMonth && 'opacity-40',
        isOver && 'bg-zinc-100 ring-1 ring-zinc-400 ring-inset'
      )}
      style={di < 6 ? { borderRight: '1px solid #E4E4E7' } : undefined}
    >
      {/* Day number + count */}
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
          <span className="u-nums text-11 font-medium text-zinc-900">
            {day.count}
          </span>
        )}
      </div>

      {/* Category dots */}
      {day.count > 0 && Object.keys(day.categoryCounts || {}).length > 0 && (
        <div className="flex gap-1 flex-wrap mb-1">
          {Object.entries(day.categoryCounts).map(([cat, count]) => (
            <span
              key={cat}
              title={`${cat}: ${count}`}
              className="u-dot u-dot--filled"
            />
          ))}
        </div>
      )}

      {/* Draggable service list (first 3) */}
      <div className="space-y-0.5">
        {day.services.slice(0, 3).map((s) => (
          <MonthServiceChip key={s.id} service={s} />
        ))}
      </div>
      {day.count > 3 && (
        <div className="text-11 text-ink-tertiary mt-0.5">
          +{day.count - 3}
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

  const onDragEnd = useCallback(async (event) => {
    const { active, over } = event;
    if (!over) return;
    const svc = active.data.current?.service;
    const drop = over.data.current;
    if (!svc || !drop?.date) return;

    // Find the day currently containing this svc
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

    // Build newWindow from current svc.windowStart + duration
    const startMin = parseHHMM(svc.windowStart);
    const dur = svc.duration || 30;
    const newWindow = startMin != null
      ? `${minutesToHHMM(startMin)}-${minutesToHHMM(startMin + dur)}`
      : '08:00-09:00';

    // Optimistic: remove from fromDate, add to toDate
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
    setBusy(true);
    try {
      await adminFetch(`/admin/dispatch/${svc.id}/reschedule`, {
        method: 'POST',
        body: JSON.stringify({
          newDate: toDate,
          newWindow,
          reasonCode: 'dispatch_drag',
          reasonText: 'Rescheduled via drag-and-drop on month grid',
          notifyCustomer: false,
        }),
      });
      await reload();
    } catch (err) {
      alert('Reschedule failed: ' + err.message);
      setOptimistic(null);
    } finally {
      setBusy(false);
    }
  }, [data, optimistic, reload]);

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
      {/* Month summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
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

      {/* Category breakdown (monochrome chips) */}
      {Object.keys(summary.byCategory || {}).length > 0 && (
        <div className="flex gap-2 mb-4 flex-wrap">
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
        <div className="-mx-4 md:mx-0 overflow-x-auto">
        <Card className="overflow-hidden min-w-[700px] md:min-w-0 md:mx-0 mx-4">
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

      {/* Tech workload for the month */}
      {Object.keys(summary.byTech || {}).length > 0 && (
        <Card className="mt-4">
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
