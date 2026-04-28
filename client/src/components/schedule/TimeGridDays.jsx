// Square-style multi-day time grid (5-day or 7-day Week views).
// Each column is a calendar day; appointments stack inside their column at
// their windowStart time. Drag a block to a new (day, time) cell to
// reschedule. Click a block to open the existing edit modal.
//
// Uses the existing reschedule endpoint:
//   POST /admin/dispatch/:id/reschedule { newDate, newWindow, reasonCode, reasonText, notifyCustomer }
import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  pointerWithin,
} from '@dnd-kit/core';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../ui';
import RescheduleConfirmModal from './RescheduleConfirmModal';
import { etDateString } from '../../lib/timezone';

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

// "2026-04-21" → "04/21"  (zero-padded MM/DD, mirroring Square's day header).
function formatMonthDay(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}` : '';
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

// Square-style flat-color blocks. Mirrors TimeGridDay's palette so the
// week/5-day grid reads identically to the single-day swimlane view.
function statusBlockClasses(status) {
  switch (status) {
    case 'completed': return 'bg-zinc-200 text-zinc-500';
    case 'skipped':   return 'bg-alert-bg text-alert-fg';
    case 'on_site':   return 'bg-zinc-900 text-white';
    case 'en_route':  return 'text-white';
    case 'confirmed': return 'text-white';
    default:          return 'text-white';
  }
}

function statusBlockFill(status) {
  switch (status) {
    case 'en_route':  return '#1E40AF';
    case 'on_site':   return null;
    case 'completed': return null;
    case 'skipped':   return null;
    case 'confirmed': return '#3B82F6';
    default:          return '#3B82F6';
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
        isDragging && 'opacity-90 z-50 shadow-2xl ring-2 ring-zinc-900',
      )}
      style={{
        top,
        height: Math.max(height, SLOT_HEIGHT - 2),
        left: `calc(${laneIdx * (100 / laneCount)}% + 2px)`,
        width: `calc(${100 / laneCount}% - 4px)`,
        background: statusBlockFill(service.status) || undefined,
        ...dragStyle,
      }}
      title={`${service.customerName || 'Unassigned'} · ${service.serviceType || ''} · ${service.windowStart || ''}${service.technicianName ? ' · ' + service.technicianName : ''}`}
    >
      <div className="opacity-90 truncate text-10">
        {(() => {
          const min = parseHHMM(service.windowStart);
          return min == null ? '' : minutesToLabel(min);
        })()}
      </div>
      <div className="font-medium truncate">{service.customerName || 'Unassigned'}</div>
      {height > SLOT_HEIGHT && (
        <div className="opacity-80 truncate text-10">
          {service.serviceType || ''}{service.technicianName ? ` · ${service.technicianName}` : ''}
        </div>
      )}
    </div>
  );
}

function SlotDroppable({ date, slotIdx, onCreateStart }) {
  const slotMin = DAY_START_HOUR * 60 + slotIdx * SLOT_MIN;
  const { setNodeRef, isOver } = useDroppable({
    id: `slot-${date}-${slotIdx}`,
    data: { date, slotMin },
  });
  const isHour = slotIdx % 2 === 0;
  return (
    <div
      ref={setNodeRef}
      onPointerDown={onCreateStart ? (e) => onCreateStart(e, slotIdx) : undefined}
      className={cn('transition-colors', isOver && 'bg-zinc-100', onCreateStart && 'cursor-crosshair')}
      style={{
        height: SLOT_HEIGHT,
        borderTop: `1px solid ${isHour ? '#E4E4E7' : '#F4F4F5'}`,
      }}
    />
  );
}

function DayColumn({ day, onEdit, onCreateSlot }) {
  // Unassigned-with-time services render in the UnassignedRail, not here.
  const services = (day.services || []).filter(
    (s) => s.technicianId && parseHHMM(s.windowStart) != null,
  );
  const gridRef = useRef(null);
  const [sel, setSel] = useState(null); // { startIdx, endIdx } during drag-to-select
  const selRef = useRef(sel);
  useEffect(() => { selRef.current = sel; }, [sel]);

  const handleCreateStart = useCallback((e, slotIdx) => {
    if (e.button !== 0) return;
    if (!onCreateSlot) return;
    e.preventDefault();
    setSel({ startIdx: slotIdx, endIdx: slotIdx });
    const gridEl = gridRef.current;
    if (!gridEl) return;
    const onMove = (ev) => {
      const rect = gridEl.getBoundingClientRect();
      const y = Math.max(0, Math.min(rect.height - 1, ev.clientY - rect.top));
      const idx = Math.min(SLOT_COUNT - 1, Math.max(0, Math.floor(y / SLOT_HEIGHT)));
      setSel((prev) => (prev ? { ...prev, endIdx: idx } : prev));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const cur = selRef.current;
      setSel(null);
      if (!cur) return;
      const lo = Math.min(cur.startIdx, cur.endIdx);
      const hi = Math.max(cur.startIdx, cur.endIdx);
      const startMin = DAY_START_HOUR * 60 + lo * SLOT_MIN;
      const endMin = DAY_START_HOUR * 60 + (hi + 1) * SLOT_MIN;
      onCreateSlot({
        date: day.date,
        windowStart: minutesToHHMM(startMin),
        windowEnd: minutesToHHMM(endMin),
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [onCreateSlot, day.date]);

  const selTop = sel ? Math.min(sel.startIdx, sel.endIdx) * SLOT_HEIGHT : 0;
  const selHeight = sel
    ? (Math.max(sel.startIdx, sel.endIdx) - Math.min(sel.startIdx, sel.endIdx) + 1) * SLOT_HEIGHT
    : 0;

  return (
    <div
      className="flex-1 relative"
      style={{ minWidth: COL_MIN_WIDTH, borderRight: '1px solid #E4E4E7' }}
    >
      <div
        className="sticky top-0 z-10 bg-white px-3 py-2 text-13 text-zinc-500 flex items-center justify-between"
        style={{ borderBottom: '1px solid #E4E4E7' }}
      >
        <span className="truncate">
          {day.dayOfWeek} {formatMonthDay(day.date)}
        </span>
        <span className="u-nums text-11 text-zinc-400">{services.length}</span>
      </div>
      <div ref={gridRef} className="relative" style={{ height: GRID_HEIGHT }}>
        {Array.from({ length: SLOT_COUNT }).map((_, idx) => (
          <SlotDroppable
            key={idx}
            date={day.date}
            slotIdx={idx}
            onCreateStart={onCreateSlot ? handleCreateStart : undefined}
          />
        ))}
        {sel && (
          <div
            className="absolute left-0 right-0 pointer-events-none"
            style={{
              top: selTop,
              height: selHeight,
              background: 'rgba(24, 24, 27, 0.08)',
              borderLeft: '2px solid #18181B',
            }}
          />
        )}
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
        className="bg-white"
        style={{ height: headerHeight, borderBottom: '1px solid #E4E4E7' }}
      />
      <div className="relative" style={{ height: GRID_HEIGHT }}>
        {Array.from({ length: SLOT_COUNT }).map((_, idx) => {
          const min = DAY_START_HOUR * 60 + idx * SLOT_MIN;
          if (min % 60 !== 0) return null;
          return (
            <div
              key={idx}
              className="absolute right-0 pr-2 text-12 u-nums text-zinc-500"
              style={{ top: idx * SLOT_HEIGHT - 8, height: SLOT_HEIGHT }}
            >
              {minutesToLabel(min)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RailItem({ service, dayLabel, onEdit }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `svc-${service.id}`,
    data: { service },
  });
  const dragStyle = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : {};
  const startMin = parseHHMM(service.windowStart);
  const timeLabel = startMin != null ? minutesToLabel(startMin) : '';
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
        'px-2 py-2 rounded-sm bg-white cursor-grab active:cursor-grabbing select-none text-11 leading-tight u-focus-ring',
        isDragging && 'opacity-90 z-50 shadow-2xl ring-2 ring-zinc-900',
      )}
      style={{ border: '1px solid #D4D4D8', ...dragStyle }}
      title={`${service.customerName || 'Unassigned'} · ${service.serviceType || ''} · ${dayLabel} ${timeLabel}`}
    >
      <div className="u-nums text-10 text-zinc-500 mb-0.5">
        {dayLabel}{timeLabel && ` · ${timeLabel}`}
      </div>
      <div className="font-medium truncate text-zinc-900">{service.customerName || 'Unassigned'}</div>
      {service.serviceType && (
        <div className="truncate text-zinc-700">{service.serviceType}</div>
      )}
    </div>
  );
}

function UnassignedRail({ items, onEdit, collapsed, onToggleCollapsed }) {
  const { setNodeRef, isOver } = useDroppable({
    id: 'rail-unassigned',
    data: { target: 'rail' },
  });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'bg-zinc-50 flex-shrink-0 sticky left-0 z-30 transition-all',
        isOver && 'bg-zinc-100',
      )}
      style={{ width: collapsed ? 36 : 180, borderRight: '1px solid #E4E4E7' }}
    >
      <div
        className="sticky top-0 z-10 bg-zinc-50 flex items-center justify-between gap-2"
        style={{
          height: 36,
          padding: collapsed ? '0' : '0 12px',
          borderBottom: '1px solid #E4E4E7',
        }}
      >
        {collapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="w-full h-full flex items-center justify-center text-ink-tertiary hover:text-zinc-900 u-focus-ring"
            title={`Expand unassigned (${items.length})`}
            aria-label="Expand unassigned"
          >
            <ChevronRight size={14} />
          </button>
        ) : (
          <>
            <span className="text-10 uppercase tracking-label text-ink-tertiary font-medium">Unassigned</span>
            <div className="flex items-center gap-2">
              <span className="u-nums text-11 text-zinc-700">{items.length}</span>
              <button
                type="button"
                onClick={onToggleCollapsed}
                className="text-ink-tertiary hover:text-zinc-900 u-focus-ring p-0.5 -mr-1"
                title="Collapse unassigned"
                aria-label="Collapse unassigned"
              >
                <ChevronLeft size={14} />
              </button>
            </div>
          </>
        )}
      </div>
      {!collapsed && (
        items.length === 0 ? (
          <div className="px-3 py-6 text-11 text-ink-tertiary text-center">
            Drop here to unassign
          </div>
        ) : (
          <div className="px-2 py-2 flex flex-col gap-1.5">
            {items.map(({ service, dayLabel }) => (
              <RailItem
                key={service.id}
                service={service}
                dayLabel={dayLabel}
                onEdit={onEdit}
              />
            ))}
          </div>
        )
      )}
    </div>
  );
}

function startOfWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return etDateString(monday);
}

export default function TimeGridDays({
  date,           // anchor date (any day in the week)
  dayCount = 7,   // 5 (Mon–Fri) or 7 (Mon–Sun)
  selectedDate,   // optional — highlight this day
  onEdit,
  onChange,
  onDateClick,
  onCreateSlot,
  refreshKey = 0, // bump to force a week-fetch refresh from the parent
  hideUnassignedRail = false,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [optimistic, setOptimistic] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);
  const [unassignedCollapsed, setUnassignedCollapsed] = useState(false);

  const monday = useMemo(() => startOfWeek(date), [date]);

  useEffect(() => {
    setLoading(true);
    setOptimistic(null);
    adminFetch(`/admin/schedule/week?start=${monday}`)
      .then((j) => { setData(j); setLoading(false); })
      .catch((err) => { console.error(err); setLoading(false); });
  }, [monday, refreshKey]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const days = useMemo(() => {
    const all = (optimistic || data?.days || []);
    return dayCount === 5 ? all.slice(0, 5) : all;
  }, [data, optimistic, dayCount]);

  const unassignedList = useMemo(() => {
    const items = [];
    days.forEach((day) => {
      (day.services || []).forEach((s) => {
        if (!s.technicianId && parseHHMM(s.windowStart) != null) {
          items.push({
            service: s,
            dayLabel: `${day.dayOfWeek} ${day.dayNum}`,
          });
        }
      });
    });
    items.sort((a, b) => {
      const aMin = parseHHMM(a.service.windowStart) ?? Infinity;
      const bMin = parseHHMM(b.service.windowStart) ?? Infinity;
      return aMin - bMin;
    });
    return items;
  }, [days]);

  const onDragEnd = useCallback((event) => {
    const { active, over } = event;
    if (!over) return;
    const svc = active.data.current?.service;
    const drop = over.data.current;
    if (!svc || !drop) return;

    const fromDate = (data?.days || []).find((d) =>
      d.services?.some((s) => s.id === svc.id),
    )?.date;
    const fromMin = parseHHMM(svc.windowStart);
    const fromTechName = svc.technicianName || null;

    // Case A: drop onto the rail → unassign (no date/time change).
    if (drop.target === 'rail') {
      if (!svc.technicianId) return; // already unassigned, no-op
      const updatedSvc = { ...svc, technicianId: null, technicianName: null };
      const nextDays = (data?.days || []).map((d) =>
        d.date === fromDate
          ? { ...d, services: d.services.map((s) => (s.id === svc.id ? updatedSvc : s)) }
          : d,
      );
      setOptimistic({ ...data, days: nextDays });
      setPending({
        mode: 'assign',
        svc,
        toDate: fromDate,
        newWindow: null,
        fromLabel: `${fromDate} · ${minutesToLabel(fromMin)}`,
        toLabel: `${fromDate} · ${minutesToLabel(fromMin)}`,
        technicianChange: { fromName: fromTechName, toName: null },
      });
      return;
    }

    // Case B: drop onto a date slot → reschedule (existing behavior,
    // also works when source is from the rail — tech stays unchanged).
    const toDate = drop.date;
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
      mode: 'reschedule',
      svc,
      toDate,
      newWindow,
      fromLabel: `${fromDate} · ${minutesToLabel(fromMin)}`,
      toLabel: `${toDate} · ${minutesToLabel(toMin)}`,
      technicianChange: null,
    });
  }, [data]);

  const commitReschedule = useCallback(async ({ notificationType }) => {
    if (!pending) return;
    const { mode, svc, toDate, newWindow } = pending;
    setBusy(true);
    try {
      if (mode === 'assign') {
        await adminFetch(`/admin/schedule/${svc.id}/assign`, {
          method: 'PUT',
          body: JSON.stringify({ technicianId: null }),
        });
      } else {
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
      }
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
    return (
      <div className="py-10 text-center text-13 text-ink-secondary">
        No services scheduled this week.
      </div>
    );
  }

  return (
    <div
      className="bg-white rounded-md overflow-hidden"
      style={{ border: '1px solid #E4E4E7' }}
    >
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={onDragEnd}>
        <div className="flex" style={{ maxHeight: '70vh' }}>
          {!hideUnassignedRail && (
            <UnassignedRail
              items={unassignedList}
              onEdit={onEdit}
              collapsed={unassignedCollapsed}
              onToggleCollapsed={() => setUnassignedCollapsed((v) => !v)}
            />
          )}
          <div className="overflow-auto flex-1">
            <div className="flex" style={{ minWidth: TIME_AXIS_WIDTH + days.length * COL_MIN_WIDTH }}>
              <TimeAxis headerHeight={36} />
              {days.map((day) => (
                <DayColumn
                  key={day.date}
                  day={day}
                  onEdit={onEdit}
                  onCreateSlot={onCreateSlot}
                />
              ))}
            </div>
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
        technicianChange={pending?.technicianChange}
        onConfirm={commitReschedule}
        onCancel={cancelReschedule}
      />
    </div>
  );
}
