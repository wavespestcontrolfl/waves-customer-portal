// Route list: the Day view as one card per technician, a numbered stop list in
// route order (owner 2026-11-24, option B, FieldRoutes style). The same day
// payload as the time grid, nothing fetched here. A line opens what the grid
// block opens; there is no drag and drop in the list.
//
// Every rule that decides what a stop shows (the planned arrival, the promised
// window and its red edge, the status look, the wording) is TimeGridDay's own:
// imported, not copied.
import { useCallback, useMemo, useState } from 'react';
import { cn } from '../ui';
import {
  CloseoutOwedChip, OUTSIDE_WINDOW_EDGE, blockPromise, clockWithAp, driveInLabel, parseHHMM, plannedTitleLine,
  promiseChipTitle, serviceDisplayName, statusBlockClasses, statusBlockFill,
} from './TimeGridDay';

const LAYOUT_KEY = 'waves_dispatch_day_layout';

// Grid is today's layout; Route is remembered per browser. Storage can throw
// (private window, blocked site data): the page then simply opens on Grid.
export function readDayLayout() {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'route' ? 'route' : 'grid';
  } catch {
    return 'grid';
  }
}

export function useDayLayout() {
  const [layout, setLayout] = useState(readDayLayout);
  const change = useCallback((next) => {
    setLayout(next);
    try { localStorage.setItem(LAYOUT_KEY, next); } catch { /* not remembered */ }
  }, []);
  return [layout, change];
}

export function DayLayoutToggle({ layout, onChange }) {
  const option = (id, label) => (
    <button
      type="button"
      aria-pressed={layout === id}
      onClick={() => onChange(id)}
      className={cn(
        'px-3 h-8 text-14 font-medium u-focus-ring',
        layout === id ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-700 hover:bg-zinc-50',
      )}
    >{label}</button>
  );
  return (
    <div role="group" aria-label="Day layout" className="inline-flex overflow-hidden rounded-sm border border-zinc-300">
      {option('grid', 'Grid')}
      {option('route', 'Route')}
    </div>
  );
}

// A stop's plan, when the route model placed it.
function planOf(service) {
  const at = service.plannedArrivalMin;
  const minutes = service.plannedMinutes;
  return Number.isFinite(at) && Number.isFinite(minutes) && minutes > 0 ? { start: at, minutes } : null;
}

// The physical stops of one technician's day, in route order. The services
// of one stop (a visit group, or two services at one address) share the
// route model's `plannedStopKey`, or a visit id where the route could not
// place them: one number, each service its own line. A stop sorts by its
// earliest planned arrival, else booked start; the day list's own order
// breaks ties; a stop with no time at all goes last.
function routeStops(services) {
  const stops = new Map();
  services.forEach((service, index) => {
    const key = service.plannedStopKey || (service.visitId ? `visit-${service.visitId}` : `row-${service.id}`);
    if (!stops.has(key)) stops.set(key, { key, services: [], index });
    stops.get(key).services.push(service);
  });
  const timeOf = (s) => planOf(s)?.start ?? parseHHMM(s.windowStart) ?? Infinity;
  const list = [...stops.values()];
  for (const stop of list) {
    stop.services.sort((a, b) => timeOf(a) - timeOf(b) || (a.displayOrder ?? Infinity) - (b.displayOrder ?? Infinity));
    stop.at = timeOf(stop.services[0]);
    stop.order = Math.min(...stop.services.map((s) => s.displayOrder ?? Infinity));
  }
  // The feed's own display order (the day list's tie-proximity order) breaks a
  // tie in time; feed position only after that.
  return list.sort((a, b) => a.at - b.at || a.order - b.order || a.index - b.index);
}

// Planned minutes of the day and its finish (the last planned departure).
// Rows of one co-visit share a stretch of work: counted once.
const CLOSED = new Set(['completed', 'skipped', 'cancelled', 'no_show']);

function dayTotals(stops) {
  const seen = new Set();
  let minutes = 0;
  let finish = null;
  // Stops still to be worked with a service the route could not place (no pin,
  // no time): the last modeled departure is then not the day's finish.
  const unplanned = stops.filter((stop) => stop.services.some((s) => !CLOSED.has(s.status) && !planOf(s))).length;
  for (const s of stops.flatMap((stop) => stop.services)) {
    const plan = planOf(s);
    if (!plan) continue;
    const key = `${plan.start}:${plan.minutes}`;
    if (!seen.has(key)) { seen.add(key); minutes += plan.minutes; }
    finish = Math.max(finish ?? 0, plan.start + plan.minutes);
  }
  return { minutes, finish, unplanned };
}

const STATUS_WORD = {
  completed: 'Done', skipped: 'Skipped', cancelled: 'Cancelled', no_show: 'No show', en_route: 'En route', on_site: 'On site',
};

// The planned arrival; with no plan, the booked start marked as such.
function StopTime({ plan, bookedStart }) {
  return (
    <span className="u-nums shrink-0" data-testid="stop-time">
      {plan ? clockWithAp(plan.start) : bookedStart != null ? clockWithAp(bookedStart) : '—'}
      {!plan && bookedStart != null && <span className="ml-1 text-ink-tertiary">booked</span>}
    </span>
  );
}

function StopLine({ service, onEdit, owesCompletion }) {
  const plan = planOf(service);
  const { promise } = plan ? blockPromise(service, plan) : { promise: null };
  const outside = promise?.outside === true;
  const bookedStart = parseHHMM(service.windowStart);
  const status = service.status;
  const flat = status === 'completed' || status === 'skipped';
  // Once per stop: the feed marks the first card of a stop (driveInShown).
  const drive = driveInLabel(service);
  const name = service.customerName || 'Unassigned';
  return (
    <div>
      <button
        type="button"
        onClick={() => onEdit?.(service)}
        title={`${name} · ${serviceDisplayName(service)}${plan ? plannedTitleLine(plan, promise) : ''}`}
        className={cn(
          'w-full text-left flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-1 pr-3 py-2 text-14 leading-tight border-l-[3px] u-focus-ring',
          flat ? statusBlockClasses(status) : 'bg-white text-zinc-900 hover:bg-zinc-50',
          status === 'cancelled' && 'text-zinc-500 line-through',
        )}
        style={{ borderLeftColor: outside ? OUTSIDE_WINDOW_EDGE : (statusBlockFill(status) || '#A1A1AA') }}
      >
        <StopTime plan={plan} bookedStart={bookedStart} />
        <span className="font-medium truncate min-w-0 flex-1 basis-40">{name}</span>
        <span className="opacity-80 truncate min-w-0 basis-32 shrink">{serviceDisplayName(service)}</span>
        {plan && <span className="u-nums shrink-0 opacity-80" data-testid="stop-minutes">{plan.minutes} min</span>}
        {drive && <span className="u-nums shrink-0 opacity-70">{drive}</span>}
        {STATUS_WORD[status] && <span className="shrink-0 opacity-80">{STATUS_WORD[status]}</span>}
        {owesCompletion?.(service) && <CloseoutOwedChip />}
        {promise && (
          <span
            className="shrink-0 ml-auto rounded-xs bg-zinc-100 px-1 u-nums text-zinc-700 whitespace-nowrap"
            title={promiseChipTitle(promise)}
          >{promise.label}</span>
        )}
      </button>
    </div>
  );
}

function RouteCard({ name, stops, onEdit, owesCompletion }) {
  const { minutes, finish, unplanned } = dayTotals(stops);
  return (
    <section className="rounded-sm border border-zinc-200 bg-white overflow-hidden" aria-label={`${name} route`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 bg-zinc-50 border-b border-zinc-200 text-14">
        <h3 className="font-medium text-zinc-900 truncate min-w-0">{name}</h3>
        <span className="u-nums text-ink-secondary">{stops.length} {stops.length === 1 ? 'stop' : 'stops'}</span>
        {minutes > 0 && <span className="u-nums text-ink-secondary">{minutes} min planned</span>}
        {unplanned > 0 ? (
          <span className="u-nums text-ink-secondary">
            Finish not known ({unplanned} {unplanned === 1 ? 'stop' : 'stops'} unplanned)
          </span>
        ) : finish != null && <span className="u-nums text-ink-secondary">Planned finish {clockWithAp(finish)}</span>}
      </header>
      {stops.length === 0 ? (
        <p className="px-3 py-3 text-14 text-ink-tertiary">No stops</p>
      ) : (
        <ol className="divide-y divide-zinc-100">
          {stops.map((stop, i) => (
            <li key={stop.key} className="flex items-stretch" data-testid="stop">
              <span className="u-nums shrink-0 w-8 pl-3 py-2 text-14 font-medium text-ink-secondary" data-testid="stop-number">{i + 1}</span>
              <div className="min-w-0 flex-1 divide-y divide-zinc-50">
                {stop.services.map((service) => (
                  <StopLine key={service.id} service={service} onEdit={onEdit} owesCompletion={owesCompletion} />
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function RouteListDay({ services = [], technicians = [], onEdit, owesCompletion }) {
  const cards = useMemo(() => {
    const byTech = new Map();
    const unassigned = [];
    for (const s of services) {
      if (!s.technicianId) { unassigned.push(s); continue; }
      if (!byTech.has(s.technicianId)) byTech.set(s.technicianId, []);
      byTech.get(s.technicianId).push(s);
    }
    const out = [];
    if (unassigned.length) out.push({ id: '__unassigned__', name: 'Unassigned', stops: routeStops(unassigned) });
    const seen = new Set();
    for (const t of technicians) {
      seen.add(t.id);
      out.push({ id: t.id, name: t.name, stops: routeStops(byTech.get(t.id) || []) });
    }
    // A technician with visits who is not on the roster still gets a card.
    for (const [id, list] of byTech) {
      if (!seen.has(id)) out.push({ id, name: list[0].technicianName || 'Technician', stops: routeStops(list) });
    }
    return out;
  }, [services, technicians]);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 p-3" data-testid="route-list">
      {cards.map((card) => (
        <RouteCard key={card.id} name={card.name} stops={card.stops} onEdit={onEdit} owesCompletion={owesCompletion} />
      ))}
    </div>
  );
}
