import { ArrowRight, BookOpen, Camera, ChevronRight, ClipboardList, CloudRain, FileText, Leaf, MapPin, Navigation, RefreshCw, Truck, Wrench } from 'lucide-react';
import { serviceWindowLabel, stopPropertyAlerts, stopStatusLabel, stopSummaryLabel, stopWindow, stopHasCustomerSentPhotos } from './routeStops';
import { directionsHref } from '../../lib/directionsHref';

// Today's tool gaps (GATE_TRUCK_KIT, /api/tech/truck-check `gaps`) by the
// stop's services: the names of the tools a visit's checklist requires that
// the technician's truck lacks.
function gapNamesFor(stop, gaps) {
  if (!Array.isArray(gaps) || !gaps.length) return [];
  const ids = new Set(stop.services.map((row) => String(row.id)));
  return [...new Set(gaps.filter((gap) => ids.has(String(gap.serviceId))).flatMap((gap) => gap.missing || []))];
}

function StopCard({ stop, onOpen, disabled, featured = false, index, gaps }) {
  const service = stop.primary;
  const name = service.customerName || service.customer_name || 'Customer';
  const active = stop.services.some((row) => ['on_site', 'en_route'].includes(row.status));
  const serviceLabel = stopSummaryLabel(stop) || service.serviceTypeDisplay || service.serviceType || service.service_type || 'Service';
  const customerSentPhotos = stopHasCustomerSentPhotos(stop);
  const toolGap = gapNamesFor(stop, gaps);
  if (!featured) return (
    <button type="button" className="tf-stop" onClick={() => onOpen(stop)} disabled={disabled}>
      <span className="tf-stop-number">{index + 1}</span>
      <span className="tf-stop-copy">
        <span className="tf-muted">{serviceWindowLabel(stopWindow(stop)) || 'Time not set'} · {stopStatusLabel(stop)}</span>
        <strong>{name}</strong>
        <span className="tf-muted">{service.address}</span>
        <span className="tf-muted">{serviceLabel}</span>
        {customerSentPhotos && <span className="tf-tag">📷 Customer sent photos</span>}
        {toolGap.length > 0 && <span className="tf-tag">Tool not on truck</span>}
      </span>
      <ChevronRight size={20} aria-hidden="true" />
    </button>
  );
  return (
    <article className="tf-card tf-next">
      <div className="tf-card-top"><Navigation size={18} aria-hidden="true" />{active ? 'Current visit' : 'Up next'}</div>
      <div className="tf-card-main">
        <p className="tf-muted">{serviceWindowLabel(stopWindow(stop)) || 'Time not set'}</p>
        <h2>{name}</h2>
        <p className="tf-muted">{service.address}</p>
        <div className="tf-tags"><span className="tf-tag">{serviceLabel}</span>{customerSentPhotos && <span className="tf-tag">📷 Customer sent photos</span>}</div>
        {toolGap.length > 0 && <div className="tf-alert tf-error">Not on your truck: {toolGap.join(', ')}</div>}
        {stopPropertyAlerts(stop).map((alert, i) => (
          <div key={i} className={`tf-alert ${alert?.type === 'chemical' ? 'tf-error' : ''}`}>
            {typeof alert === 'string' ? alert : alert.text}
          </div>
        ))}
        {service.address && <a className="tf-button" href={directionsHref(service.address, service.gateWaypoint)} target="_blank" rel="noopener noreferrer"><Navigation aria-hidden="true" />Directions</a>}
        <div className="tf-actions"><button type="button" className="tf-button tf-primary" onClick={() => onOpen(stop)} disabled={disabled}>Open visit <ArrowRight aria-hidden="true" /></button></div>
      </div>
    </article>
  );
}

// Today's three regions, each its own component so the page's decision
// structure stays readable (and under the complexity limit).
function TodayHeading({ loading, refreshing, error, completed, stops, serviceCount, onRetry }) {
  return (
    <div className="tf-page-heading">
      <div>
        <h1>Today</h1>
        <p className="tf-muted">
          {new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric' })}
          {!loading && !error && ` · ${completed} of ${stops.length} stops complete · ${serviceCount} services`}
        </p>
      </div>
      <button type="button" className="tf-button" aria-label="Refresh route" onClick={onRetry} disabled={loading || refreshing}><RefreshCw aria-hidden="true" /></button>
    </div>
  );
}

function RouteColumn({ loading, error, stops, nextStop, completed, onOpen, busy, toolGaps }) {
  const emptyTitle = stops.length === 0 ? 'No stops scheduled today' : completed === stops.length ? 'All stops completed' : 'No remaining stops';
  return (
    <div className="tf-col">
      <div className="tf-area-next">
        {loading ? <p role="status">Loading your route…</p> : !error && (nextStop
          ? <StopCard stop={nextStop} featured onOpen={onOpen} disabled={busy} gaps={toolGaps} />
          : <div className="tf-card tf-card-main"><MapPin aria-hidden="true" /><h2>{emptyTitle}</h2><p className="tf-muted">Refresh to check for schedule updates.</p></div>)}
      </div>
      {!loading && !error && stops.length > 0 && <section className="tf-area-route"><h2 className="tf-overline">Your route</h2><div className="tf-route">{stops.map((stop, index) => <StopCard key={stop.key} stop={stop} index={index} onOpen={onOpen} disabled={busy} gaps={toolGaps} />)}</div></section>}
    </div>
  );
}

function SideColumn({ handoffCards, scheduleChanges, truckCheck, timeClock, followThrough }) {
  return (
    <div className="tf-col">
      {(handoffCards || scheduleChanges) && (
        <div className="tf-area-changes" style={handoffCards ? { display: 'grid', gap: 12 } : undefined}>{handoffCards}{scheduleChanges}</div>
      )}
      {truckCheck && <div className="tf-area-truck">{truckCheck}</div>}
      {timeClock && <div className="tf-area-clock">{timeClock}</div>}
      <div className="tf-area-follow">{followThrough}</div>
    </div>
  );
}

export default function TechFieldHome({ section, truckCheck, toolGaps, stops, nextStop, loading, refreshing = false, error, notice, rainChance, onRetry, onOpen, busy, tools, timekeeping, visit, followThrough, handoffCards = null, scheduleChanges = null, timeClock = null, onboarding, heldVisits }) {
  if (section === 'tools') return (
    <div className="tf-page">
      <div className="tf-page-heading"><div><h1>Tools</h1><p className="tf-muted">Field references and reporting</p></div><Wrench aria-hidden="true" /></div>
      <div className="tf-tool-grid">{tools.map(({ label, description, icon, onClick, disabled }) => {
        const Icon = { protocol: BookOpen, lawn: Leaf, social: Camera, project: FileText, estimate: ClipboardList, truck: Truck }[icon];
        return <button type="button" key={label} className="tf-card tf-tool" onClick={onClick} disabled={disabled}><Icon aria-hidden="true" /><span><strong>{label}</strong><small>{description}</small></span><ChevronRight aria-hidden="true" /></button>;
      })}</div>
    </div>
  );
  if (section === 'more') return (
    <div className="tf-page">
      <h1>More</h1><p className="tf-muted">Your shift and field resources</p>
      {timekeeping}
    </div>
  );
  // The saved-copy warning must sit above the visit view too: a reopen at a
  // persisted ?visit= URL lands here, never on the route list.
  const savedNotice = notice && !error && <div role="status" className="tf-alert">{notice}<div><button type="button" className="tf-button" onClick={onRetry} disabled={loading || refreshing}>Try again</button></div></div>;
  if (visit) return <div className="tf-page">{savedNotice}{visit}</div>;
  const completed = stops.filter((stop) => stop.services.every((service) => service.status === 'completed')).length;
  const serviceCount = stops.reduce((count, stop) => count + stop.services.length, 0);
  // Phone: schedule changes, up next, time clock, route, follow-through, in
  // that order. Computer: up next + route on the left, the rest on the right
  // (tech-field.css .tf-today-grid; approved mockup 2026-10-03).
  return (
    <div className="tf-page">
      <TodayHeading loading={loading} refreshing={refreshing} error={error} completed={completed} stops={stops} serviceCount={serviceCount} onRetry={onRetry} />
      {onboarding}
      {rainChance >= 40 && <div className="tf-alert"><CloudRain size={18} aria-hidden="true" /> {rainChance}% rain today</div>}
      {error && <div role="alert" className="tf-alert tf-error">{error}<div><button type="button" className="tf-button" onClick={onRetry}>Retry route</button></div></div>}
      {savedNotice}
      {heldVisits}
      {!loading && !error && stops.length > 0 && <div className="tf-progress" aria-hidden="true">{stops.map((stop) => <span key={stop.key} className={stop.services.every((s) => s.status === 'completed') ? 'done' : stop.key === nextStop?.key ? 'current' : ''} />)}</div>}
      <div className="tf-today-grid">
        <RouteColumn loading={loading} error={error} stops={stops} nextStop={nextStop} completed={completed} onOpen={onOpen} busy={busy} toolGaps={toolGaps} />
        <SideColumn handoffCards={handoffCards} scheduleChanges={scheduleChanges} truckCheck={truckCheck} timeClock={timeClock} followThrough={followThrough} />
      </div>
    </div>
  );
}
