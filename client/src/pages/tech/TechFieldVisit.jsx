import { ArrowLeft, MapPin, Navigation } from 'lucide-react';
import { stopStatusLabel, TERMINAL_STATUSES } from './routeStops';

function RouteError({ error, busy, onRetry }) {
  return <div className="tf-alert tf-error" role="alert">{error}{busy && <p role="status">Current action is still in progress.</p>}<div><button type="button" className="tf-button" onClick={onRetry}>Retry route</button></div></div>;
}

export default function TechFieldVisit({ stop, loading, error, onBack, onRetry, busy, enRouteState, onSiteState, onEnRoute, onSite, onSync, onMove, children }) {
  const back = <button type="button" className="tf-button" onClick={onBack} disabled={busy}><ArrowLeft aria-hidden="true" />Today</button>;
  const routeError = error && <RouteError error={error} busy={busy} onRetry={onRetry} />;
  if (loading) return <>{back}<p role="status">Loading visit…</p></>;
  if (error && !busy) return <>{back}{routeError}</>;
  if (!stop) return <>{back}<div className="tf-card tf-card-main"><h1>Visit unavailable</h1><p>This stop is no longer on your assigned route for today.</p><button type="button" className="tf-button" onClick={onRetry}>Refresh route</button></div></>;

  const service = stop.primary;
  const status = service.status;
  const feedback = [onSiteState, enRouteState].find((state) => state.serviceId === service.id && state.message);
  const pending = !!(enRouteState.pendingId || onSiteState.pendingId);
  const live = stop.services.filter((row) => !TERMINAL_STATUSES.has(row.status));
  const outOfSync = live.some((row) => ['on_site', 'en_route'].includes(row.status))
    && live.some((row) => row.status !== status || (row.trackState && service.trackState && row.trackState !== service.trackState));
  return <>
    {back}
    {routeError}
    {/* Keep pending contact state mounted while stale visit controls are hidden. */}
    <div hidden={Boolean(error)}>
    <div className="tf-section-title"><p className="tf-muted">{stopStatusLabel(stop)}</p><h1>{service.customerName || service.customer_name || 'Current visit'}</h1><p className="tf-muted">{service.address}</p></div>
    <div className="tf-tags">{stop.services.map((row) => <span key={row.id} className="tf-tag">{row.serviceTypeDisplay || row.serviceType || row.service_type || 'Service'} · {(row.status || 'pending').replace(/_/g, ' ')}</span>)}</div>
    <div className="tf-actions">
      {service.address && <a className="tf-button" href={`https://maps.google.com/?q=${encodeURIComponent(service.address)}`} target="_blank" rel="noopener noreferrer"><Navigation aria-hidden="true" />Directions</a>}
      {!outOfSync && ['pending', 'confirmed', 'rescheduled'].includes(status) && <button type="button" className="tf-button" disabled={pending} onClick={() => onEnRoute(service.id)}>En route</button>}
      {!outOfSync && status === 'en_route' && <button type="button" className="tf-button" disabled={pending} onClick={() => onSite(service.id)}><MapPin aria-hidden="true" />On site</button>}
      {outOfSync && <button type="button" className="tf-button" disabled={pending} onClick={() => onSync(stop)}>Sync stop</button>}
      {live.length > 0 && <button type="button" className="tf-button" disabled={pending} onClick={() => onMove(service)}>Quick Move</button>}
    </div>
    {pending && <p role="status">Updating visit…</p>}
    {feedback && <p role="status" className={`tf-alert ${feedback.isError ? 'tf-error' : ''}`}>{feedback.message}</p>}
    {children}
    </div>
  </>;
}
