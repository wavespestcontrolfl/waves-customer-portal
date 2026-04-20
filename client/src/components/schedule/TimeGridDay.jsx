// Square-style day-view time grid for Dispatch.
// Tech columns × 30-min time rows from 6 AM → 8 PM. Drag a block to a new (tech, time)
// to reschedule + reassign. Click a block to open the existing edit modal.
//
// Endpoints used (already exist):
//   PUT  /admin/schedule/:id/assign         { technicianId }
//   POST /admin/dispatch/:id/reschedule     { newDate, newWindow, reasonCode, reasonText, notifyCustomer }
import { useMemo, useState, useCallback } from 'react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  pointerWithin,
} from '@dnd-kit/core';
import { Badge, cn } from '../ui';
import RescheduleConfirmModal from './RescheduleConfirmModal';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const DAY_START_HOUR = 6;
const DAY_END_HOUR = 20;
const SLOT_MIN = 30;
const SLOT_HEIGHT = 32;
const SLOT_COUNT = ((DAY_END_HOUR - DAY_START_HOUR) * 60) / SLOT_MIN;
const GRID_HEIGHT = SLOT_COUNT * SLOT_HEIGHT;
const COL_MIN_WIDTH = 200;
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

// Prefer the actual window (windowEnd - windowStart) since the DB's
// estimated_duration_minutes column is often null. Falls back to 30.
function effectiveDuration(svc) {
  if (svc?.estimatedDuration && svc.estimatedDuration > 0) return svc.estimatedDuration;
  const start = parseHHMM(svc?.windowStart);
  const end = parseHHMM(svc?.windowEnd);
  if (start != null && end != null && end > start) return end - start;
  return 30;
}

function minutesToTopPx(min) {
  return ((min - DAY_START_HOUR * 60) / SLOT_MIN) * SLOT_HEIGHT;
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
// cluster; within a cluster each is placed in the first lane whose last
// assigned service ends at or before this one starts. Returns a Map
// keyed by service.id → { laneIdx, laneCount }.
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
        'absolute px-2 py-1 rounded-sm cursor-grab active:cursor-grabbing select-none overflow-hidden text-11 leading-tight u-focus-ring',
        statusBlockClasses(service.status),
        isDragging && 'opacity-90 z-50 shadow-2xl ring-2 ring-zinc-900',
      )}
      style={{
        top,
        height: Math.max(height, SLOT_HEIGHT - 2),
        left: `calc(${laneIdx * (100 / laneCount)}% + 2px)`,
        width: `calc(${100 / laneCount}% - 4px)`,
        border: `1px solid ${statusBorderColor(service.status)}`,
        ...dragStyle,
      }}
      title={`${service.customerName} · ${service.serviceType || ''} · ${service.windowDisplay || ''}`}
    >
      <div className="font-medium truncate">{service.customerName}</div>
      <div className="opacity-80 truncate">
        {service.windowDisplay || minutesToHHMM(parseHHMM(service.windowStart) || 0)} · {service.serviceType || ''}
      </div>
      {service.address && height > SLOT_HEIGHT * 1.5 && (
        <div className="opacity-60 truncate">{service.address}</div>
      )}
    </div>
  );
}

function SlotDroppable({ techId, slotIdx }) {
  const slotMin = DAY_START_HOUR * 60 + slotIdx * SLOT_MIN;
  const { setNodeRef, isOver } = useDroppable({
    id: `slot-${techId}-${slotIdx}`,
    data: { techId, slotMin },
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

function TechColumn({ tech, services, onEdit }) {
  return (
    <div
      className="flex-1 relative"
      style={{ minWidth: COL_MIN_WIDTH, borderRight: '1px solid #E4E4E7' }}
    >
      <div
        className="sticky top-0 z-10 bg-zinc-50 px-3 py-2 text-12 font-medium text-zinc-900 flex items-center justify-between"
        style={{ borderBottom: '1px solid #E4E4E7' }}
      >
        <span className="truncate">{tech.name}</span>
        <span className="u-nums text-11 text-ink-secondary">
          {services.length}
        </span>
      </div>
      <div className="relative" style={{ height: GRID_HEIGHT }}>
        {Array.from({ length: SLOT_COUNT }).map((_, idx) => (
          <SlotDroppable key={idx} techId={tech.id} slotIdx={idx} />
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

function TimeAxis() {
  return (
    <div
      className="bg-white sticky left-0 z-20"
      style={{ width: TIME_AXIS_WIDTH, borderRight: '1px solid #E4E4E7' }}
    >
      <div
        className="bg-zinc-50"
        style={{ height: 36, borderBottom: '1px solid #E4E4E7' }}
      />
      <div className="relative" style={{ height: GRID_HEIGHT }}>
        {Array.from({ length: SLOT_COUNT }).map((_, idx) => {
          const min = DAY_START_HOUR * 60 + idx * SLOT_MIN;
          const isHour = min % 60 === 0;
          return (
            <div
              key={idx}
              className={cn(
                'absolute right-0 pr-2 text-10 text-ink-tertiary u-nums',
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

function AllDayStrip({ services, onEdit }) {
  if (services.length === 0) return null;
  return (
    <div
      className="bg-zinc-50/50 px-2 py-2 flex flex-wrap gap-1"
      style={{ borderBottom: '1px solid #E4E4E7' }}
    >
      <span className="text-10 uppercase tracking-label text-ink-tertiary self-center mr-2">All-day</span>
      {services.map((svc) => (
        <button
          key={svc.id}
          type="button"
          onClick={() => onEdit?.(svc)}
          className="px-2 py-1 rounded-sm bg-white text-11 text-zinc-900 truncate max-w-[200px]"
          style={{ border: '1px solid #D4D4D8' }}
        >
          {svc.customerName} · {svc.serviceType || ''}
        </button>
      ))}
    </div>
  );
}

function RailItem({ service, onEdit }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `svc-${service.id}`,
    data: { service },
  });
  const dragStyle = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : {};
  const startMin = parseHHMM(service.windowStart);
  const timeLabel = startMin != null ? minutesToLabel(startMin) : 'Any time';
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
      title={`${service.customerName} · ${service.serviceType || ''} · ${service.windowDisplay || timeLabel}`}
    >
      <div className="u-nums text-10 text-zinc-500 mb-0.5">{timeLabel}</div>
      <div className="font-medium truncate text-zinc-900">{service.customerName}</div>
      {service.serviceType && (
        <div className="truncate text-zinc-700">{service.serviceType}</div>
      )}
    </div>
  );
}

function UnassignedRail({ services, onEdit }) {
  const { setNodeRef, isOver } = useDroppable({
    id: 'rail-unassigned',
    data: { techId: '__unassigned__' },
  });
  const sorted = [...services].sort((a, b) => {
    const aMin = parseHHMM(a.windowStart) ?? Infinity;
    const bMin = parseHHMM(b.windowStart) ?? Infinity;
    return aMin - bMin;
  });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'bg-zinc-50 flex-shrink-0 overflow-auto transition-colors',
        isOver && 'bg-zinc-100',
      )}
      style={{ width: 180, borderRight: '1px solid #E4E4E7' }}
    >
      <div
        className="sticky top-0 z-10 bg-zinc-50 px-3 py-2 flex items-center justify-between"
        style={{ borderBottom: '1px solid #E4E4E7' }}
      >
        <span className="text-10 uppercase tracking-label text-ink-tertiary font-medium">Unassigned</span>
        <span className="u-nums text-11 text-zinc-700">{sorted.length}</span>
      </div>
      {sorted.length === 0 ? (
        <div className="px-3 py-6 text-11 text-ink-tertiary text-center">
          Drop here to unassign
        </div>
      ) : (
        <div className="px-2 py-2 flex flex-col gap-1.5">
          {sorted.map((svc) => (
            <RailItem key={svc.id} service={svc} onEdit={onEdit} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function TimeGridDay({
  date,
  services,
  technicians,
  onEdit,
  onChange,
}) {
  const [optimistic, setOptimistic] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);

  const allServices = optimistic || services;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const techList = useMemo(() => {
    const seen = new Set();
    const list = [];
    (technicians || []).forEach((t) => {
      if (t?.id && !seen.has(t.id)) { seen.add(t.id); list.push({ id: t.id, name: t.name }); }
    });
    allServices.forEach((s) => {
      if (s.technicianId && !seen.has(s.technicianId)) {
        seen.add(s.technicianId);
        list.push({ id: s.technicianId, name: s.technicianName || 'Tech' });
      }
    });
    return list;
  }, [technicians, allServices]);

  const unassignedInRail = useMemo(
    () => allServices.filter((s) => !s.technicianId),
    [allServices],
  );

  const byTech = useMemo(() => {
    const map = {};
    techList.forEach((t) => { map[t.id] = []; });
    allServices.forEach((svc) => {
      const key = svc.technicianId || '__unassigned__';
      if (!map[key]) map[key] = [];
      map[key].push(svc);
    });
    return map;
  }, [allServices, techList]);

  // Any-time + unassigned items live in the rail now; AllDayStrip only shows
  // tech-assigned services that don't have a parseable time window.
  const allDay = useMemo(
    () => allServices.filter(
      (s) => !!s.technicianId && parseHHMM(s.windowStart) == null,
    ),
    [allServices],
  );

  const onDragEnd = useCallback((event) => {
    const { active, over } = event;
    if (!over) return;
    const svc = active.data.current?.service;
    const drop = over.data.current;
    if (!svc || !drop) return;

    const fromTech = svc.technicianId || '__unassigned__';
    const toTech = drop.techId;
    const fromMin = parseHHMM(svc.windowStart);
    // Rail droppable has no slotMin — keep the original time when unassigning.
    const toMin = drop.slotMin != null ? drop.slotMin : fromMin;
    if (fromTech === toTech && fromMin === toMin) return;

    const dur = effectiveDuration(svc);
    const newWindow = `${minutesToHHMM(toMin)}-${minutesToHHMM(toMin + dur)}`;
    const newWindowDisplay = `${minutesToLabel(toMin)} – ${minutesToLabel(toMin + dur)}`;

    const next = allServices.map((s) =>
      s.id === svc.id
        ? {
            ...s,
            technicianId: toTech === '__unassigned__' ? null : toTech,
            technicianName: toTech === '__unassigned__'
              ? null
              : (technicians.find((t) => t.id === toTech)?.name || s.technicianName),
            windowStart: minutesToHHMM(toMin),
            windowEnd: minutesToHHMM(toMin + dur),
            windowDisplay: newWindowDisplay,
          }
        : s,
    );
    setOptimistic(next);

    const fromTechName = fromTech === '__unassigned__'
      ? null
      : (technicians.find((t) => t.id === fromTech)?.name || svc.technicianName || null);
    const toTechName = toTech === '__unassigned__'
      ? null
      : (technicians.find((t) => t.id === toTech)?.name || null);
    setPending({
      svc,
      toTech,
      fromMin,
      toMin,
      newWindow,
      fromLabel: minutesToLabel(fromMin),
      toLabel: minutesToLabel(toMin),
      technicianChange: fromTech !== toTech
        ? { fromName: fromTechName, toName: toTechName }
        : null,
    });
  }, [allServices, technicians]);

  const commitReschedule = useCallback(async ({ notificationType }) => {
    if (!pending) return;
    const { svc, toTech, fromMin, toMin, newWindow } = pending;
    const fromTech = svc.technicianId || '__unassigned__';
    setBusy(true);
    try {
      const calls = [];
      if (fromTech !== toTech) {
        const techForApi = toTech === '__unassigned__' ? null : toTech;
        calls.push(adminFetch(`/admin/schedule/${svc.id}/assign`, {
          method: 'PUT',
          body: JSON.stringify({ technicianId: techForApi }),
        }));
      }
      if (fromMin !== toMin) {
        calls.push(adminFetch(`/admin/dispatch/${svc.id}/reschedule`, {
          method: 'POST',
          body: JSON.stringify({
            newDate: date,
            newWindow,
            reasonCode: 'dispatch_drag',
            reasonText: 'Rescheduled via drag-and-drop on Day grid',
            notifyCustomer: notificationType === 'sms',
          }),
        }));
      }
      await Promise.all(calls);
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
  }, [pending, date, onChange]);

  const cancelReschedule = useCallback(() => {
    setOptimistic(null);
    setPending(null);
  }, []);

  if (techList.length === 0 && unassignedInRail.length === 0) {
    return (
      <div className="text-ink-secondary text-center py-16 text-13">
        No technicians scheduled for this day.
      </div>
    );
  }

  return (
    <div
      className="bg-white rounded-md overflow-hidden"
      style={{ border: '1px solid #E4E4E7' }}
    >
      <AllDayStrip services={allDay} onEdit={onEdit} />
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={onDragEnd}>
        <div className="flex" style={{ maxHeight: '70vh' }}>
          <UnassignedRail services={unassignedInRail} onEdit={onEdit} />
          {techList.length === 0 ? (
            <div className="flex-1 text-ink-secondary text-center py-16 text-13">
              No technicians scheduled for this day.
            </div>
          ) : (
            <div className="overflow-auto flex-1">
              <div className="flex" style={{ minWidth: TIME_AXIS_WIDTH + techList.length * COL_MIN_WIDTH }}>
                <TimeAxis />
                {techList.map((tech) => (
                  <TechColumn
                    key={tech.id}
                    tech={tech}
                    services={byTech[tech.id] || []}
                    onEdit={onEdit}
                  />
                ))}
              </div>
            </div>
          )}
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
        fromLabel={pending ? `${date} · ${pending.fromLabel}` : ''}
        toLabel={pending ? `${date} · ${pending.toLabel}` : ''}
        technicianChange={pending?.technicianChange}
        onConfirm={commitReschedule}
        onCancel={cancelReschedule}
      />
    </div>
  );
}
