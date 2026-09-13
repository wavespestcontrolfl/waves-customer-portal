import { ArrowRight, BookOpen, Camera, ChevronRight, ClipboardList, CloudRain, FileText, Leaf, MapPin, Navigation, RefreshCw, Wrench } from 'lucide-react';
import { serviceWindowLabel, stopPropertyAlerts, stopStatusLabel, stopSummaryLabel, stopWindow } from './routeStops';

function StopCard({ stop, onOpen, disabled, featured = false, index }) {
  const service = stop.primary;
  const name = service.customerName || service.customer_name || 'Customer';
  const active = stop.services.some((row) => ['on_site', 'en_route'].includes(row.status));
  const serviceLabel = stopSummaryLabel(stop) || service.serviceTypeDisplay || service.serviceType || service.service_type || 'Service';
  if (!featured) return (
    <button type="button" className="tf-stop" onClick={() => onOpen(stop)} disabled={disabled}>
      <span className="tf-stop-number">{index + 1}</span>
      <span className="tf-stop-copy">
        <span className="tf-muted">{serviceWindowLabel(stopWindow(stop)) || 'Time not set'} · {stopStatusLabel(stop)}</span>
        <strong>{name}</strong>
        <span className="tf-muted">{service.address}</span>
        <span className="tf-muted">{serviceLabel}</span>
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
        <div className="tf-tags"><span className="tf-tag">{serviceLabel}</span></div>
        {stopPropertyAlerts(stop).map((alert, i) => (
          <div key={i} className={`tf-alert ${alert?.type === 'chemical' ? 'tf-error' : ''}`}>
            {typeof alert === 'string' ? alert : alert.text}
          </div>
        ))}
        {service.address && <a className="tf-button" href={`https://maps.google.com/?q=${encodeURIComponent(service.address)}`} target="_blank" rel="noopener noreferrer"><Navigation aria-hidden="true" />Directions</a>}
        <div className="tf-actions"><button type="button" className="tf-button tf-primary" onClick={() => onOpen(stop)} disabled={disabled}>Open visit <ArrowRight aria-hidden="true" /></button></div>
      </div>
    </article>
  );
}

export default function TechFieldHome({ section, stops, nextStop, loading, error, rainChance, onRetry, onOpen, busy, tools, timekeeping, visit, followThrough }) {
  if (section === 'tools') return (
    <div className="tf-page">
      <div className="tf-page-heading"><div><h1>Tools</h1><p className="tf-muted">Field references and reporting</p></div><Wrench aria-hidden="true" /></div>
      <div className="tf-tool-grid">{tools.map(({ label, description, icon, onClick, disabled }) => {
        const Icon = { protocol: BookOpen, lawn: Leaf, social: Camera, project: FileText, estimate: ClipboardList }[icon];
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
  if (visit) return <div className="tf-page">{visit}</div>;
  const completed = stops.filter((stop) => stop.services.every((service) => service.status === 'completed')).length;
  return (
    <div className="tf-page">
      <div className="tf-page-heading">
        <div><h1>Today</h1><p className="tf-muted">{new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric' })}</p></div>
        <button type="button" className="tf-button" aria-label="Refresh route" onClick={onRetry} disabled={loading}><RefreshCw aria-hidden="true" /></button>
      </div>
      {rainChance >= 40 && <div className="tf-alert"><CloudRain size={18} aria-hidden="true" /> {rainChance}% rain today</div>}
      {followThrough}
      {error && <div role="alert" className="tf-alert tf-error">{error}<div><button type="button" className="tf-button" onClick={onRetry}>Retry route</button></div></div>}
      {loading ? <p role="status">Loading your route…</p> : !error && <>
        <div className="tf-progress-label"><strong>{completed} of {stops.length} stops complete</strong><span className="tf-muted">{stops.reduce((count, stop) => count + stop.services.length, 0)} services</span></div>
        <div className="tf-progress" aria-hidden="true">{stops.map((stop) => <span key={stop.key} className={stop.services.every((s) => s.status === 'completed') ? 'done' : stop.key === nextStop?.key ? 'current' : ''} />)}</div>
        <div className="tf-today-grid">
          <div>{nextStop ? <StopCard stop={nextStop} featured onOpen={onOpen} disabled={busy} /> : <div className="tf-card tf-card-main"><MapPin aria-hidden="true" /><h2>{stops.length === 0 ? 'No stops scheduled today' : completed === stops.length ? 'All stops completed' : 'No remaining stops'}</h2><p className="tf-muted">Refresh to check for schedule updates.</p></div>}</div>
          {stops.length > 0 && <section><h2 className="tf-section-title">Your route</h2><div className="tf-route">{stops.map((stop, index) => <StopCard key={stop.key} stop={stop} index={index} onOpen={onOpen} disabled={busy} />)}</div></section>}
        </div>
      </>}
    </div>
  );
}
