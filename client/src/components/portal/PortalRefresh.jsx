import { useRef, useState } from 'react';
import { usePortalRefresh } from '../../hooks/usePortalRead';
import { COLORS } from '../../theme-brand';

const buttonStyle = { minHeight: 48, padding: '8px 14px', borderRadius: 10, border: `1px solid ${COLORS.glassNavy}`, background: 'transparent', color: COLORS.glassNavy, font: 'inherit', fontSize: 14, cursor: 'pointer' };
const noticeStyle = { display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderRadius: 12, marginBottom: 16, color: COLORS.glassNavy };
const statusStyle = { fontSize: 14 };

function refreshMessage(portal, pullRefreshing, pull) {
  if (!portal.online) return 'You’re offline. Showing saved information.';
  if (pullRefreshing || portal.refreshing) return 'Refreshing…';
  if (pull >= 80) return 'Release to refresh';
  if (pull > 0) return 'Pull down to refresh';
  return '';
}

export function PortalRefreshArea({ children, available = true, onlineContent }) {
  const portal = usePortalRefresh();
  const start = useRef(null);
  const [pull, setPull] = useState(0);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const active = portal?.enabled && available;
  const showNotice = !portal?.online || pull > 0 || pullRefreshing;
  const refreshUnavailable = portal?.refreshing || !portal?.online;
  const presentation = showNotice ? {
    container: { 'data-glass': 'soft', style: noticeStyle },
    status: { style: statusStyle },
    button: { 'data-glass-accent': '' },
  } : {
    container: {},
    status: { className: 'sr-only' },
    button: { className: 'sr-only focus:not-sr-only' },
  };
  const reset = () => { start.current = null; setPull(0); };
  const onTouchStart = (event) => {
    if (!active || portal.refreshing || !portal.online || event.touches.length !== 1) return;
    if ((document.scrollingElement?.scrollTop || 0) > 0) return;
    if (event.target.closest('button, a, input, textarea, select, [role="dialog"]')) return;
    // An inner scroller keeps its own gesture even at the top of the document.
    for (let el = event.target; el && el !== event.currentTarget; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY)) return;
    }
    start.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  };
  const onTouchMove = (event) => {
    if (!start.current) return;
    if (event.touches.length !== 1) { reset(); return; }
    const dx = Math.abs(event.touches[0].clientX - start.current.x);
    const dy = event.touches[0].clientY - start.current.y;
    if (dx > 30 || dy < 0) { reset(); return; }
    setPull(Math.min(110, dy));
  };
  const refreshManually = async () => {
    if (refreshUnavailable) return;
    setPullRefreshing(true);
    try { await portal.refresh({ preserveVerified: false }); }
    finally { setPullRefreshing(false); }
  };
  const onTouchEnd = () => {
    if (pull >= 80) void refreshManually();
    reset();
  };
  return <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={reset}>
    {active && <div {...presentation.container}>
      <span role="status" {...presentation.status}>
        {refreshMessage(portal, pullRefreshing, pull)}
      </span>
      <button
        type="button"
        {...presentation.button}
        style={{ ...buttonStyle, ...(refreshUnavailable ? { opacity: 0.55 } : {}) }}
        onClick={() => { void refreshManually(); }}
        aria-disabled={refreshUnavailable || undefined}
      >
        {portal.refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>}
    {(!portal?.enabled || portal.online) && onlineContent}
    {children}
  </div>;
}

export function SavedPortalRead({ title, read, children, titleAs: Heading = 'h2' }) {
  const updated = read.updatedAt ? new Date(read.updatedAt).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }) : null;
  return <section data-glass="card" style={{ padding: 20, marginBottom: 16, borderRadius: 14, color: COLORS.glassNavy }}>
    <Heading style={{ fontSize: 20, margin: '0 0 12px' }}>{title}</Heading>
    {read.error && !read.offline && <p role="status" style={{ fontSize: 16, lineHeight: 1.5 }}>Couldn’t refresh these details. Showing the last loaded information.</p>}
    <p role="status" style={{ fontSize: 16, lineHeight: 1.5, margin: '0 0 12px' }}>
      {updated ? `Saved ${updated} ET. These details may have changed.` : 'These details have not been loaded in this session.'}
    </p>
    {children}
    <p style={{ fontSize: 14, lineHeight: 1.5 }}>Reconnect to update details, make changes, or open full report files.</p>
    <button type="button" data-glass-accent="" style={buttonStyle} disabled={read.offline || read.pending} onClick={() => { void read.refresh(); }}>{read.pending ? 'Updating…' : 'Try again'}</button>
  </section>;
}
