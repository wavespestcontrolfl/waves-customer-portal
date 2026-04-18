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

function AppointmentBlock({ service, top, height, onEdit }) {
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
        'absolute left-1 right-1 px-2 py-1 rounded-sm border-hairline cursor-grab active:cursor-grabbing select-none overflow-hidden text-11 leading-tight u-focus-ring',
        statusBlockClasses(service.status),
        isDragging && 'opacity-60 z-50 shadow-lg',
      )}
      style={{ top, height: Math.max(height, SLOT_HEIGHT - 2), ...dragStyle }}
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
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'border-t border-zinc-100 transition-colors',
        slotIdx % 2 === 0 && 'border-zinc-200',
        isOver && 'bg-zinc-100',
      )}
      style={{ height: SLOT_HEIGHT }}
    />
  );
}

function TechColumn({ tech, services, onEdit }) {
  return (
    <div
      className="flex-1 border-r border-zinc-200 relative"
      style={{ minWidth: COL_MIN_WIDTH }}
    >
      <div className="sticky top-0 z-10 bg-zinc-50 border-b border-zinc-200 px-3 py-2 text-12 font-medium text-zinc-900 flex items-center justify-between">
        <span className="truncate">{tech.name}</span>
        <span className="u-nums text-11 text-ink-secondary">
          {services.length}
        </span>
      </div>
      <div className="relative" style={{ height: GRID_HEIGHT }}>
        {Array.from({ length: SLOT_COUNT }).map((_, idx) => (
          <SlotDroppable key={idx} techId={tech.id} slotIdx={idx} />
        ))}
        {services.map((svc) => {
          const startMin = parseHHMM(svc.windowStart);
          if (startMin == null || startMin < DAY_START_HOUR * 60 || startMin >= DAY_END_HOUR * 60) return null;
          const top = minutesToTopPx(startMin);
          const dur = svc.estimatedDuration || 30;
          const height = (dur / SLOT_MIN) * SLOT_HEIGHT;
          return (
            <AppointmentBlock
              key={svc.id}
              service={svc}
              top={top}
              height={height}
              onEdit={onEdit}
            />
          );
        })}
      </div>
    </div>
  );
}

function TimeAxis() {
  return (
    <div
      className="bg-white border-r border-zinc-200 sticky left-0 z-20"
      style={{ width: TIME_AXIS_WIDTH }}
    >
      <div className="bg-zinc-50 border-b border-zinc-200" style={{ height: 36 }} />
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
    <div className="border-b border-zinc-200 bg-zinc-50/50 px-2 py-2 flex flex-wrap gap-1">
      <span className="text-10 uppercase tracking-label text-ink-tertiary self-center mr-2">All-day</span>
      {services.map((svc) => (
        <button
          key={svc.id}
          type="button"
          onClick={() => onEdit?.(svc)}
          className="px-2 py-1 rounded-sm border-hairline border-zinc-300 bg-white text-11 text-zinc-900 hover:border-zinc-900 truncate max-w-[200px]"
        >
          {svc.customerName} · {svc.serviceType || ''}
        </button>
      ))}
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
    if (allServices.some((s) => !s.technicianId)) {
      list.push({ id: '__unassigned__', name: 'Unassigned' });
    }
    return list;
  }, [technicians, allServices]);

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

  const allDay = useMemo(
    () => allServices.filter((s) => parseHHMM(s.windowStart) == null),
    [allServices],
  );

  const onDragEnd = useCallback(async (event) => {
    const { active, over } = event;
    if (!over) return;
    const svc = active.data.current?.service;
    const drop = over.data.current;
    if (!svc || !drop) return;

    const fromTech = svc.technicianId || '__unassigned__';
    const toTech = drop.techId;
    const fromMin = parseHHMM(svc.windowStart);
    const toMin = drop.slotMin;
    if (fromTech === toTech && fromMin === toMin) return;

    const dur = svc.estimatedDuration || 30;
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
            notifyCustomer: false,
          }),
        }));
      }
      await Promise.all(calls);
      setOptimistic(null);
      onChange?.();
    } catch (err) {
      alert('Reschedule failed: ' + err.message);
      setOptimistic(null);
    } finally {
      setBusy(false);
    }
  }, [allServices, date, onChange, technicians]);

  if (techList.length === 0) {
    return (
      <div className="text-ink-secondary text-center py-16 text-13">
        No technicians scheduled for this day.
      </div>
    );
  }

  return (
    <div className="bg-white border-hairline border-zinc-200 rounded-md overflow-hidden">
      <AllDayStrip services={allDay} onEdit={onEdit} />
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={onDragEnd}>
        <div className="overflow-auto" style={{ maxHeight: '70vh' }}>
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
      </DndContext>
      {busy && (
        <div className="px-3 py-1 text-11 text-ink-secondary border-t border-zinc-200">Saving…</div>
      )}
    </div>
  );
}
