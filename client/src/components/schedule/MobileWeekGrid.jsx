// Mobile-only Square-style week view for Dispatch.
// 7 equal day-letter columns, half-hourly grid, service-color blocks,
// red now-line on today's column only, pinch/Ctrl+wheel zoom.
// Shares the /admin/schedule/week endpoint and /admin/dispatch/:id/reschedule
// handler with the desktop TimeGridDays grid — no backend changes.

import { useMemo, useState, useCallback, useEffect, useRef, useLayoutEffect } from 'react';
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
import { serviceColor } from '../../lib/service-colors';
import { etDateString } from '../../lib/timezone';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const SLOT_MIN = 30;
const SLOT_COUNT = (24 * 60) / SLOT_MIN; // 48 — full 24-hour grid
const TIME_AXIS_WIDTH = 42;
const DAY_HEADER_HEIGHT = 44;

// Zoom — slotHeight in px per 30-min slot.
// Clamped so hoursVisible ∈ [~4, 24] on a typical mobile viewport.
const ZOOM_MIN = 10;     // ~24h visible on 480px viewport
const ZOOM_MAX = 64;     // ~4h visible
const ZOOM_DEFAULT = 24; // ~12h visible (7 AM–7 PM)
const ZOOM_STORAGE_KEY = 'waves_dispatch_zoom_v2';

function readZoom() {
  if (typeof window === 'undefined') return ZOOM_DEFAULT;
  const raw = parseFloat(window.localStorage.getItem(ZOOM_STORAGE_KEY));
  if (!Number.isFinite(raw)) return ZOOM_DEFAULT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, raw));
}

function writeZoom(v) {
  try { window.localStorage.setItem(ZOOM_STORAGE_KEY, String(v)); } catch {}
}

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
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ap = h24 < 12 ? 'AM' : 'PM';
  return `${h12} ${ap}`;
}


function startOfWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - day);
  return etDateString(sunday);
}

function effectiveDuration(svc) {
  if (svc?.estimatedDuration && svc.estimatedDuration > 0) return svc.estimatedDuration;
  const start = parseHHMM(svc?.windowStart);
  const end = parseHHMM(svc?.windowEnd);
  if (start != null && end != null && end > start) return end - start;
  return 30;
}

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
      c.items.some((x) => x.start < item.end && x.end > item.start),
    );
    if (!cluster) { cluster = { items: [] }; clusters.push(cluster); }
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
    cluster.items.forEach((item) => {
      result.get(item.svc.id).laneCount = lanes.length;
    });
  });

  return result;
}

// ── Appointment block ──────────────────────────────────────────────

function MobileBlock({ service, top, height, laneIdx, laneCount, onEdit }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `svc-${service.id}`,
    data: { service },
  });
  const dragStyle = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : {};

  // Alert states take precedence over service-line color. Missing customer
  // data is itself an alert state (action required) — show red, same as an
  // unassigned or skipped job.
  const name = String(service.customerName || '').trim();
  const customerMissing = !name;
  let bg, fg;
  if (service.status === 'skipped' || !service.technicianId || customerMissing) {
    bg = '#C0392B'; fg = '#FFFFFF';
  } else if (service.status === 'completed') {
    bg = '#E4E4E7'; fg = '#52525B';
  } else {
    const c = serviceColor(service.serviceType);
    bg = c.bg; fg = c.fg;
  }

  const firstName = customerMissing ? 'Unassigned' : (name.split(' ')[0] || name);
  const tooSmall = height < 28;

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
        'absolute select-none overflow-hidden u-focus-ring',
        isDragging && 'opacity-90 z-50 shadow-xl',
      )}
      style={{
        top,
        height: Math.max(height, 16),
        left: `calc(${laneIdx * (100 / laneCount)}% + 1px)`,
        width: `calc(${100 / laneCount}% - 2px)`,
        background: bg,
        color: fg,
        borderRadius: 6,
        padding: tooSmall ? '1px 4px' : '2px 5px',
        fontSize: 11,
        lineHeight: 1.15,
        cursor: 'grab',
        touchAction: 'none',
        ...dragStyle,
      }}
      title={`${service.customerName} · ${service.serviceType || ''} · ${service.windowStart || ''}`}
    >
      <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {firstName}
      </div>
      {!tooSmall && service.serviceType && (
        <div style={{ opacity: 0.85, fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {service.serviceType}
        </div>
      )}
    </div>
  );
}

// ── Droppable 30-min slot on a given day ───────────────────────────

function Slot({ date, slotIdx, slotHeight }) {
  const slotMin = slotIdx * SLOT_MIN;
  const { setNodeRef, isOver } = useDroppable({
    id: `slot-${date}-${slotIdx}`,
    data: { date, slotMin },
  });
  const onHour = slotIdx % 2 === 0;
  return (
    <div
      ref={setNodeRef}
      style={{
        height: slotHeight,
        borderTop: onHour ? '1px solid rgba(0,0,0,0.08)' : '1px solid rgba(0,0,0,0.035)',
        background: isOver ? 'rgba(24,24,27,0.06)' : 'transparent',
        transition: 'background-color 120ms',
      }}
    />
  );
}

// ── Day column ─────────────────────────────────────────────────────

function DayColumn({ day, onEdit, isToday, slotHeight, nowMin }) {
  const services = (day.services || []).filter(
    (s) => parseHHMM(s.windowStart) != null,
  );
  const lanes = computeLanes(services);
  const gridHeight = slotHeight * SLOT_COUNT;

  return (
    <div style={{ flex: 1, minWidth: 0, position: 'relative', borderRight: '1px solid rgba(0,0,0,0.06)' }}>
      <div style={{ position: 'relative', height: gridHeight }}>
        {Array.from({ length: SLOT_COUNT }).map((_, idx) => (
          <Slot key={idx} date={day.date} slotIdx={idx} slotHeight={slotHeight} />
        ))}
        {services.map((svc) => {
          const startMin = parseHHMM(svc.windowStart);
          if (startMin == null) return null;
          const top = (startMin / SLOT_MIN) * slotHeight;
          const dur = effectiveDuration(svc);
          const height = (dur / SLOT_MIN) * slotHeight;
          const lane = lanes.get(svc.id) || { laneIdx: 0, laneCount: 1 };
          return (
            <MobileBlock
              key={svc.id}
              service={svc}
              top={top}
              height={height}
              laneIdx={lane.laneIdx}
              laneCount={lane.laneCount}
              onEdit={onEdit}
            />
          );
        })}
        {isToday && nowMin != null && (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: (nowMin / SLOT_MIN) * slotHeight,
              height: 1.5,
              background: '#DC2626',
              pointerEvents: 'none',
              zIndex: 5,
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── Time axis ──────────────────────────────────────────────────────

function TimeAxis({ slotHeight, nowMin, showNowDot }) {
  const gridHeight = slotHeight * SLOT_COUNT;
  return (
    <div
      style={{
        width: TIME_AXIS_WIDTH,
        flexShrink: 0,
        position: 'relative',
        background: '#FAFAFA',
        borderRight: '1px solid rgba(0,0,0,0.08)',
      }}
    >
      <div style={{ position: 'relative', height: gridHeight }}>
        {Array.from({ length: 24 }).map((_, hr) => (
          <div
            key={hr}
            style={{
              position: 'absolute',
              top: hr * 2 * slotHeight - 6,
              right: 4,
              fontSize: 10,
              color: '#71717A',
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1,
            }}
          >
            {hr === 0 ? '' : minutesToLabel(hr * 60)}
          </div>
        ))}
        {showNowDot && nowMin != null && (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              right: 0,
              top: (nowMin / SLOT_MIN) * slotHeight - 4,
              width: 8,
              height: 8,
              borderRadius: 999,
              background: '#DC2626',
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── Day header row (sticky) ────────────────────────────────────────

function DayHeaderRow({ days, todayIso }) {
  return (
    <div style={{ display: 'flex', height: DAY_HEADER_HEIGHT, background: '#FFFFFF' }}>
      <div style={{ width: TIME_AXIS_WIDTH, flexShrink: 0, borderRight: '1px solid rgba(0,0,0,0.08)' }} />
      {days.map((day) => {
        const d = new Date(day.date + 'T12:00:00');
        const letter = d.toLocaleDateString('en-US', { weekday: 'narrow' });
        const num = d.getDate();
        const today = day.date === todayIso;
        return (
          <div
            key={day.date}
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              borderRight: '1px solid rgba(0,0,0,0.06)',
            }}
          >
            <span style={{ fontSize: 10, color: today ? '#18181B' : '#71717A', fontWeight: today ? 700 : 500, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              {letter}
            </span>
            <span style={{ fontSize: 14, color: today ? '#18181B' : '#3F3F46', fontWeight: today ? 700 : 500, fontVariantNumeric: 'tabular-nums' }}>
              {num}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────

export default function MobileWeekGrid({ date, onEdit, onChange, onNavigate }) {
  const monthInputRef = useRef(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [optimistic, setOptimistic] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);
  const [slotHeight, setSlotHeight] = useState(() => readZoom());
  const [nowMin, setNowMin] = useState(() => {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  });

  const weekStart = useMemo(() => startOfWeek(date), [date]);
  const scrollRef = useRef(null);
  const didInitialScrollRef = useRef(false);

  useEffect(() => {
    setLoading(true);
    setOptimistic(null);
    adminFetch(`/admin/schedule/week?start=${weekStart}`)
      .then((j) => { setData(j); setLoading(false); })
      .catch((err) => { console.error(err); setLoading(false); });
  }, [weekStart]);

  useEffect(() => {
    const t = setInterval(() => {
      const n = new Date();
      setNowMin(n.getHours() * 60 + n.getMinutes());
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  // Initial scroll: first load → scroll to ~7 AM so the working window
  // sits at the top. Keep scroll position on subsequent week nav.
  useLayoutEffect(() => {
    if (loading || !data || didInitialScrollRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = 7 * 2 * slotHeight; // 7 AM
    didInitialScrollRef.current = true;
  }, [loading, data, slotHeight]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const days = useMemo(() => (optimistic || data?.days || []), [data, optimistic]);

  const todayIso = etDateString(new Date());

  // ── Zoom: Ctrl/Cmd + wheel (desktop) and 2-finger pinch (touch) ──
  //
  // The scroll container mounts only after `loading` flips to false, so the
  // ref-reading effect must depend on `data` (not just `slotHeight`). Also
  // keep slotHeight in a ref so the handler reads latest without the effect
  // re-registering on every zoom step.

  const slotHeightRef = useRef(slotHeight);
  useEffect(() => { slotHeightRef.current = slotHeight; }, [slotHeight]);

  const applyZoom = useCallback((nextPx, anchorClientY) => {
    const el = scrollRef.current;
    if (!el) { setSlotHeight(nextPx); writeZoom(nextPx); return; }
    const rect = el.getBoundingClientRect();
    const anchorInGrid = (anchorClientY ?? rect.top + rect.height / 2) - rect.top + el.scrollTop;
    setSlotHeight((prev) => {
      const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextPx));
      const ratio = clamped / prev;
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = anchorInGrid * ratio - (anchorClientY - rect.top);
      });
      writeZoom(clamped);
      return clamped;
    });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const delta = -e.deltaY * 0.05;
      applyZoom(slotHeightRef.current + delta, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyZoom, data]);

  // Pinch — measured from two touches on the grid scroller.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let startDist = 0;
    let startSlot = slotHeightRef.current;
    let anchorY = 0;
    let active = false;

    const dist = (t) => {
      const dx = t[0].clientX - t[1].clientX;
      const dy = t[0].clientY - t[1].clientY;
      return Math.hypot(dx, dy);
    };

    const onStart = (e) => {
      if (e.touches.length === 2) {
        startDist = dist(e.touches);
        startSlot = slotHeightRef.current;
        anchorY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        active = true;
      }
    };
    const onMove = (e) => {
      if (!active || e.touches.length !== 2) return;
      e.preventDefault();
      const d = dist(e.touches);
      if (startDist === 0) return;
      const ratio = d / startDist;
      applyZoom(startSlot * ratio, anchorY);
    };
    const onEnd = (e) => {
      if (e.touches.length < 2) { active = false; startDist = 0; }
    };

    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [applyZoom, data]);

  // ── Drag-to-reschedule (mirrors TimeGridDays.onDragEnd) ──────────

  const onDragEnd = useCallback((event) => {
    const { active, over } = event;
    if (!over) return;
    const svc = active.data.current?.service;
    const drop = over.data.current;
    if (!svc || !drop || drop.target === 'rail') return;

    const fromDate = (data?.days || []).find((d) =>
      d.services?.some((s) => s.id === svc.id),
    )?.date;
    const fromMin = parseHHMM(svc.windowStart);
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
        return { ...d, services: d.services.map((s) => (s.id === svc.id ? updatedSvc : s)) };
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
      fromLabel: `${fromDate} · ${fromMin != null ? minutesToLabel(fromMin) : ''}`,
      toLabel: `${toDate} · ${minutesToLabel(toMin)}`,
      technicianChange: null,
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
          reasonText: 'Rescheduled via drag-and-drop on mobile week grid',
          notifyCustomer: notificationType === 'sms',
        }),
      });
      const j = await adminFetch(`/admin/schedule/week?start=${weekStart}`);
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
  }, [pending, weekStart, onChange]);

  const cancelReschedule = useCallback(() => {
    setOptimistic(null);
    setPending(null);
  }, []);

  const anchor = days[0] ? new Date(days[0].date + 'T12:00:00') : new Date(date + 'T12:00:00');
  const monthLabel = anchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  if (loading) {
    return <div className="py-10 text-center text-13 text-ink-secondary">Loading…</div>;
  }

  return (
    <div className="bg-white rounded-md overflow-hidden" style={{ border: '1px solid #E4E4E7' }}>
      {/* Month/year header — tap opens the native month picker. */}
      <div style={{ position: 'relative', height: 40, borderBottom: '1px solid rgba(0,0,0,0.06)', background: '#FFFFFF' }}>
        <button
          type="button"
          onClick={() => {
            const el = monthInputRef.current;
            if (!el) return;
            if (typeof el.showPicker === 'function') el.showPicker();
            else el.click();
          }}
          className="w-full h-full flex items-center justify-center gap-1.5 px-4"
          style={{ color: '#18181B', fontSize: 14, fontWeight: 600 }}
        >
          <span>{monthLabel}</span>
          <span aria-hidden style={{ fontSize: 10, color: '#71717A' }}>▾</span>
        </button>
        <input
          ref={monthInputRef}
          type="month"
          value={`${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}`}
          onChange={(e) => {
            const v = e.target.value; // "YYYY-MM"
            if (!v || !onNavigate) return;
            const [y, m] = v.split('-').map(Number);
            const today = new Date();
            const pick = (today.getFullYear() === y && today.getMonth() + 1 === m)
              ? today
              : new Date(y, m - 1, 1);
            onNavigate(etDateString(pick));
          }}
          aria-hidden
          tabIndex={-1}
          style={{
            position: 'absolute',
            left: 0, top: 0,
            width: 1, height: 1,
            opacity: 0,
            pointerEvents: 'none',
          }}
        />
      </div>

      <DayHeaderRow days={days} todayIso={todayIso} />

      <div
        ref={scrollRef}
        style={{
          height: 'calc(100vh - 320px)',
          minHeight: 380,
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          overscrollBehavior: 'contain',
        }}
      >
        <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={onDragEnd}>
          <div style={{ display: 'flex' }}>
            <TimeAxis slotHeight={slotHeight} nowMin={nowMin} showNowDot={days.some((d) => d.date === todayIso)} />
            {days.map((day) => (
              <DayColumn
                key={day.date}
                day={day}
                onEdit={onEdit}
                isToday={day.date === todayIso}
                slotHeight={slotHeight}
                nowMin={nowMin}
              />
            ))}
          </div>
        </DndContext>
      </div>

      {busy && (
        <div style={{ padding: '4px 12px', fontSize: 11, color: '#71717A', borderTop: '1px solid #E4E4E7' }}>
          Saving…
        </div>
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
