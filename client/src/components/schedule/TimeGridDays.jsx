// Square-style multi-day time grid (5-day or 7-day Week views).
// Each column is a calendar day; appointments stack inside their column at
// their windowStart time. Drag a block to a new (day, time) cell to
// reschedule. Click a block to open the existing edit modal.
//
// Uses the existing reschedule endpoint:
//   POST /admin/dispatch/:id/reschedule { newDate, newWindow, reasonCode, reasonText, notifyCustomer }
import { useMemo, useState, useCallback, useEffect } from 'react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  pointerWithin,
} from '@dnd-kit/core';
import { cn } from '../ui';
import RescheduleConfirmModal from './RescheduleConfirmModal';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const DAY_START_HOUR = 6;
const DAY_END_HOUR = 20;
const SLOT_MIN = 30;
const SLOT_HEIGHT = 32;
const SLOT_COUNT = ((DAY_END_HOUR - DAY_START_HOUR) * 60) / SLOT_MIN;
const GRID_HEIGHT = SLOT_COUNT * SLOT_HEIGHT;
const COL_MIN_WIDTH = 160;
const TIME_AXIS_WIDTH = 64;

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  }).then(async (r) => {
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(text || `${r.status} ${r.statusText}`);
    }
    return r.json();
  });
}

function parseHHMM(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (isNaN(hh) || isNaN(mm)) return null;
  return hh * 60 + mm;
}

function minutesToHHMM(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function minutesToLabel(min) {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ap = h24 < 12 ? 'AM' : 'PM';
  return m === 0 ? `${h12} ${ap}` : `${h12}:${String(m).padStart(2, '0')}`;
}

function minutesToTopPx(min) {
  return ((min - DAY_START_HOUR * 60) / SLOT_MIN) * SLOT_HEIGHT;
}

// Prefer the actual window (windowEnd - windowStart) since the DB's
// estimated_duration_minutes column is often null. Falls back to 30.
function effectiveDuration(svc) {
  if (svc?.estimatedDuration && svc.estimatedDuration > 0) return svc.estimatedDuration;
  const start = parseHHMM(svc?.windowStart);
  const end = parseHHMM(svc?.windowEnd);
  if (start != null && end != null && end > start) return end - start;
  return 30;
}

function statusBlockClasses(status) {
  switch (status) {
    case 'completed': return 'bg-zinc-200 text-zinc-500';
    case 'skipped':   return 'bg-alert-bg text-alert-fg';
    case 'on_site':   return 'bg-zinc-900 text-white';
    case 'en_route':  return 'bg-zinc-700 text-white';
    case 'confirmed': return 'bg-white text-zinc-900';
    default:          return 'bg-white text-zinc-900';
  }
}

function statusBorderColor(status) {
  switch (status) {
    case 'completed': return '#D4D4D8';
    case 'skipped':   return '#C0392B';
    case 'on_site':   return '#18181B';
    case 'en_route':  return '#3F3F46';
    case 'confirmed': return '#18181B';
    default:          return '#A1A1AA';
  }
}

// Greedy interval-scheduling lane layout: overlapping services share a
// cluster; within a cluster each goes into the first lane whose last
// assigned service ends at or before this one starts.
function computeLanes(services) {
  const result = new Map();
  const items = services
    .map((s) => {
      const start = parseHHMM(s.windowStart);
      const endRaw = parseHHMM(s.windowEnd);
      const dur = effectiveDuration(s);
      const end = endRaw != null ? endRaw : (start != null ? start + dur : null);
      return { svc: s, start: start ?? 0, end: end ?? 30 };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const clusters = [];
  items.forEach((item) => {
    let cluster = clusters.find((c) =>
      c.items.some((x) => x.start < item.end && x.end > item.start)
    );
    if (!cluster) {
      cluster = { items: [] };
      clusters.push(cluster);
    }
    cluster.items.push(item);
  });

  clusters.forEach((cluster) => {
    const lanes = [];
    cluster.items.forEach((item) => {
      let laneIdx = lanes.findIndex((e) => e <= item.start);
      if (laneIdx === -1) { laneIdx = lanes.length; lanes.push(item.end); }
      else { lanes[laneIdx] = item.end; }
      result.set(item.svc.id, { laneIdx, laneCount: 0 });
    });
    const laneCount = lanes.length;
    cluster.items.forEach((item) => {
      result.get(item.svc.id).laneCount = laneCount;
    });
  });

  return result;
}

function AppointmentBlock({ service, top, height, laneIdx = 0, laneCount = 1, onEdit }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `svc-${service.id}`,
    data: { service },
  });

  const dragStyle = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : {};

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        if (isDragging) return;
        e.stopPropagation();
        onEdit?.(service);
      }}
      className={cn(
        'absolute px-1.5 py-0.5 rounded-sm cursor-grab active:cursor-grabbing select-none overflow-hidden text-11 leading-tight u-focus-ring',
        statusBlockClasses(service.status),
        isDragging && 'opacity-60 z-50 shadow-lg',
      )}
      style={{
        top,
        height: Math.max(height, SLOT_HEIGHT - 2),
        left: `calc(${laneIdx * (100 / laneCount)}% + 2px)`,
        width: `calc(${100 / laneCount}% - 4px)`,
        border: `1px solid ${statusBorderColor(service.status)}`,
        ...dragStyle,
      }}
      title={`${service.customerName} · ${service.serviceType || ''} · ${service.windowStart || ''}${service.technicianName ? ' · ' + service.technicianName : ''}`}
    >
      <div className="font-medium truncate">{service.customerName}</div>
      {height > SLOT_HEIGHT && (
        <div className="opacity-70 truncate text-10">
          {service.technicianName || '—'} · {service.serviceType || ''}
        </div>
      )}
    </div>
  );
}

function SlotDroppable({ date, slotIdx }) {
  const slotMin = DAY_START_HOUR * 60 + slotIdx * SLOT_MIN;
  const { setNodeRef, isOver } = useDroppable({
    id: `slot-${date}-${slotIdx}`,
    data: { date, slotMin },
  });
  const isHour = slotIdx % 2 === 0;
  return (
    <div
      ref={setNodeRef}
      className={cn('transition-colors', isOver && 'bg-zinc-100')}
      style={{
        height: SLOT_HEIGHT,
        borderTop: `1px solid ${isHour ? '#E4E4E7' : '#F4F4F5'}`,
      }}
    />
  );
}

function DayColumn({ day, onEdit, isToday, isSelected }) {
  const services = (day.services || []).filter((s) => parseHHMM(s.windowStart) != null);
  return (
    <div
      className="flex-1 relative"
      style={{ minWidth: COL_MIN_WIDTH, borderRight: '1px solid #E4E4E7' }}
    >
      <div
        className={cn(
          'sticky top-0 z-10 px-3 py-2 text-12 font-medium flex items-center justify-between',
          isToday ? 'bg-zinc-900 text-white' : isSelected ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-50 text-zinc-900',
        )}
        style={{ borderBottom: '1px solid #E4E4E7' }}
      >
        <span className="truncate">
          <span className="u-label">{day.dayOfWeek}</span>
          <span className="ml-2 u-nums text-13">{day.dayNum}</span>
        </span>
        <span className={cn('u-nums text-11', isToday ? 'text-white/80' : 'text-ink-secondary')}>
          {day.count}
        </span>
      </div>
      <div className="relative" style={{ height: GRID_HEIGHT }}>
        {Array.from({ length: SLOT_COUNT }).map((_, idx) => (
          <SlotDroppable key={idx} date={day.date} slotIdx={idx} />
        ))}
        {(() => {
          const lanes = computeLanes(services);
          return services.map((svc) => {
            const startMin = parseHHMM(svc.windowStart);
            if (startMin == null || startMin < DAY_START_HOUR * 60 || startMin >= DAY_END_HOUR * 60) return null;
            const top = minutesToTopPx(startMin);
            const dur = effectiveDuration(svc);
            const height = (dur / SLOT_MIN) * SLOT_HEIGHT;
            const lane = lanes.get(svc.id) || { laneIdx: 0, laneCount: 1 };
            return (
              <AppointmentBlock
                key={svc.id}
                service={svc}
                top={top}
                height={height}
                laneIdx={lane.laneIdx}
                laneCount={lane.laneCount}
                onEdit={onEdit}
              />
            );
          });
        })()}
      </div>
    </div>
  );
}

function TimeAxis({ headerHeight }) {
  return (
    <div
      className="bg-white sticky left-0 z-20"
      style={{ width: TIME_AXIS_WIDTH, borderRight: '1px solid #E4E4E7' }}
    >
      <div
        className="bg-zinc-50"
        style={{ height: headerHeight, borderBottom: '1px solid #E4E4E7' }}
      />
      <div className="relative" style={{ height: GRID_HEIGHT }}>
        {Array.from({ length: SLOT_COUNT }).map((_, idx) => {
          const min = DAY_START_HOUR * 60 + idx * SLOT_MIN;
          const isHour = min % 60 === 0;
          return (
            <div
              key={idx}
              className={cn(
                'absolute right-0 pr-2 text-10 u-nums',
                isHour ? 'text-zinc-700 font-medium' : 'text-ink-tertiary',
              )}
              style={{ top: idx * SLOT_HEIGHT - 6, height: SLOT_HEIGHT }}
            >
              {isHour ? minutesToLabel(min) : ''}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function startOfWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return monday.toISOString().split('T')[0];
}

export default function TimeGridDays({
  date,           // anchor date (any day in the week)
  dayCount = 7,   // 5 (Mon–Fri) or 7 (Mon–Sun)
  selectedDate,   // optional — highlight this day
  onEdit,
  onChange,
  onDateClick,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [optimistic, setOptimistic] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);

  const monday = useMemo(() => startOfWeek(date), [date]);

  useEffect(() => {
    setLoading(true);
    setOptimistic(null);
    adminFetch(`/admin/schedule/week?start=${monday}`)
      .then((j) => { setData(j); setLoading(false); })
      .catch((err) => { console.error(err); setLoading(false); });
  }, [monday]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const days = useMemo(() => {
    const all = (optimistic || data?.days || []);
    return dayCount === 5 ? all.slice(0, 5) : all;
  }, [data, optimistic, dayCount]);

  const today = new Date().toISOString().split('T')[0];

  const onDragEnd = useCallback((event) => {
    const { active, over } = event;
    if (!over) return;
    const svc = active.data.current?.service;
    const drop = over.data.current;
    if (!svc || !drop) return;

    const fromDate = (data?.days || []).find((d) =>
      d.services?.some((s) => s.id === svc.id),
    )?.date;
    const toDate = drop.date;
    const fromMin = parseHHMM(svc.windowStart);
    const toMin = drop.slotMin;
    if (fromDate === toDate && fromMin === toMin) return;

    const dur = effectiveDuration(svc);
    const newWindow = `${minutesToHHMM(toMin)}-${minutesToHHMM(toMin + dur)}`;

    const updatedSvc = {
      ...svc,
      windowStart: minutesToHHMM(toMin),
      windowEnd: minutesToHHMM(toMin + dur),
    };
    const nextDays = (data?.days || []).map((d) => {
      if (d.date === fromDate && d.date === toDate) {
        return {
          ...d,
          services: d.services.map((s) => (s.id === svc.id ? updatedSvc : s)),
        };
      }
      if (d.date === fromDate) {
        const filtered = d.services.filter((s) => s.id !== svc.id);
        return { ...d, services: filtered, count: filtered.length };
      }
      if (d.date === toDate) {
        const added = [...d.services, updatedSvc];
        return { ...d, services: added, count: added.length };
      }
      return d;
    });
    setOptimistic({ ...data, days: nextDays });
    setPending({
      svc,
      toDate,
      newWindow,
      fromLabel: `${fromDate} · ${minutesToLabel(fromMin)}`,
      toLabel: `${toDate} · ${minutesToLabel(toMin)}`,
    });
  }, [data]);

  const commitReschedule = useCallback(async ({ notificationType }) => {
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
          reasonText: 'Rescheduled via drag-and-drop on multi-day grid',
          notifyCustomer: notificationType === 'sms',
        }),
      });
      const j = await adminFetch(`/admin/schedule/week?start=${monday}`);
      setData(j);
      setOptimistic(null);
      setPending(null);
      onChange?.();
    } catch (err) {
      alert('Reschedule failed: ' + err.message);
      setOptimistic(null);
      setPending(null);
    } finally {
      setBusy(false);
    }
  }, [pending, monday, onChange]);

  const cancelReschedule = useCallback(() => {
    setOptimistic(null);
    setPending(null);
  }, []);

  if (loading) {
    return <div className="py-10 text-center text-13 text-ink-secondary">Loading…</div>;
  }
  if (!days.length) {
    return <div className="py-10 text-center text-13 text-ink-secondary">No data.</div>;
  }

  return (
    <div
      className="bg-white rounded-md overflow-hidden"
      style={{ border: '1px solid #E4E4E7' }}
    >
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={onDragEnd}>
        <div className="overflow-auto" style={{ maxHeight: '70vh' }}>
          <div className="flex" style={{ minWidth: TIME_AXIS_WIDTH + days.length * COL_MIN_WIDTH }}>
            <TimeAxis headerHeight={36} />
            {days.map((day) => (
              <DayColumn
                key={day.date}
                day={day}
                onEdit={onEdit}
                isToday={day.date === today}
                isSelected={selectedDate && day.date === selectedDate}
              />
            ))}
          </div>
        </div>
      </DndContext>
      {busy && (
        <div
          className="px-3 py-1 text-11 text-ink-secondary"
          style={{ borderTop: '1px solid #E4E4E7' }}
        >Saving…</div>
      )}
      <RescheduleConfirmModal
        open={!!pending}
        customerName={pending?.svc?.customerName}
        fromLabel={pending?.fromLabel || ''}
        toLabel={pending?.toLabel || ''}
        onConfirm={commitReschedule}
        onCancel={cancelReschedule}
      />
    </div>
  );
}
