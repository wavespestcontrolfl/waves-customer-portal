// Open times on the Dispatch board (owner 2026-10-26, "start step 4";
// GATE_BOARD_OPEN_TIMES): while a visit is dragged on the day or week grid,
// the hours that fit it light up, each with what it adds to the day's
// driving ("adds N min"), amber over 30 min, and the best one tagged. It is
// the open-times search the staff time box uses (find-time summary with
// openTimes), asked for the board's own days. Display only: the drop still
// saves the way it always has.

import { useEffect, useState } from 'react';
import { cn } from '../ui';
import { addsPhrase } from './OpenTimesBox';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const FAR_MINUTES = 30;

function toMin(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

const finite = (v) => (Number.isFinite(v) ? v : Infinity);
// The rain tier (0 sorts first) only orders an outdoor job's hours, as in the box.
const tier = (fit) => (Number.isFinite(fit.rainTier) ? fit.rainTier : 0);
const byBest = (a, b) => tier(a) - tier(b) || finite(a.detourMinutes) - finite(b.detourMinutes)
  || a.date.localeCompare(b.date) || a.startMin - b.startMin;

/** Every hour that fits, one per technician route: { date, techId, startMin, ... }. */
export function boardFits(data) {
  if (!data?.summary?.open_times || !Array.isArray(data.summary.days)) return null;
  return data.summary.days
    .flatMap((day) => (day.closed ? [] : (day.hours || []).map((h) => ({
      date: day.date,
      techId: h.technician?.id ?? null,
      startMin: toMin(h.start_time),
      detourMinutes: h.detour_minutes ?? null,
      driveSource: h.drive_source ?? null,
      rainTier: h.rain_tier ?? null,
    }))))
    .filter((fit) => fit.startMin != null);
}

/**
 * The lit hours for the visit being dragged over `dates` (the grid's shown
 * days): `{ fits, best }`, both null until the search answers (or with
 * nothing dragged). The day grid asks for every technician's route (a drop
 * can change the technician). The week grid passes `ownRoute`: a drop keeps
 * the visit's technician, so only that route is searched, and an unassigned
 * visit lights nothing. `durationOf` is the board's own duration rule.
 */
export function useBoardOpenTimes({ enabled, service, durationOf, dates, ownRoute = false }) {
  const [answer, setAnswer] = useState(null);
  const technicianId = ownRoute ? service?.technicianId : undefined;
  const dateFrom = dates[0];
  const dateTo = dates[dates.length - 1];
  const key = enabled && service?.id && dateFrom && (!ownRoute || technicianId)
    ? [service.id, durationOf(service), dateFrom, dateTo, technicianId || ''].join('|') : '';
  useEffect(() => {
    if (!key) return undefined;
    const controller = new AbortController();
    fetch(`${API_BASE}/admin/schedule/find-time`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        hint: true, summary: true, openTimes: true, arrivalWindows: true, slotStepMinutes: 60,
        serviceId: service.id,
        customerId: service.customerId || service.customer_id || undefined,
        // A row books its technician, so a technician who cannot do the service is left out.
        serviceType: service.serviceType || undefined,
        durationMinutes: durationOf(service),
        excludeServiceIds: [service.id],
        dateFrom, dateTo,
        technicianId: technicianId || undefined,
      }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((data) => { if (!controller.signal.aborted) setAnswer({ key, fits: boardFits(data) || [] }); });
    return () => controller.abort();
  }, [key]);
  const fits = answer?.key === key ? answer.fits : null;
  return { fits, best: fits?.length ? [...fits].sort(byBest)[0] : null };
}

const sameFit = (a, b) => !!a && !!b && a.date === b.date && a.techId === b.techId && a.startMin === b.startMin;

/**
 * One column's lit hours. The mouse passes through to the drop rows beneath,
 * and the column's visits draw over them (render this before the blocks).
 */
export function LitHours({ fits, best, minutesToTopPx, hourHeight }) {
  return fits.map((fit) => {
    const far = Number(fit.detourMinutes) > FAR_MINUTES;
    return (
      <div
        key={`lit-${fit.date}-${fit.techId}-${fit.startMin}`}
        data-testid="board-open-time"
        data-far={far || undefined}
        className={cn(
          'absolute pointer-events-none flex items-center justify-between rounded-xs border u-nums',
          far ? 'border-warn-fg bg-warn-bg text-warn-fg' : 'border-zinc-900 bg-white text-zinc-900',
        )}
        style={{ top: minutesToTopPx(fit.startMin) + 3, height: hourHeight - 6, left: 6, right: 6, padding: '0 10px', fontSize: 14 }}
      >
        <span>{addsPhrase(fit)}</span>
        {sameFit(fit, best) ? <span className="rounded-full bg-zinc-900 px-2 font-medium text-white">Best</span> : null}
      </div>
    );
  });
}
