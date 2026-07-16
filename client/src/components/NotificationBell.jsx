import { useState, useEffect, useRef, useId } from 'react';
import { createPortal } from 'react-dom';
import { ensurePushSubscription, isPushEnabled, syncPushSubscription } from '../lib/push-subscribe.js';
import useLockBodyScroll from '../hooks/useLockBodyScroll.js';
import useModalFocus from '../hooks/useModalFocus.js';
import {
  isNativeApp,
  nativePushPermissionState,
  requestNativePushPermission,
} from '../native/nativePush.js';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function tokenCustomerId(token) {
  if (!token) return null;
  try {
    const segment = token.split('.')[1];
    if (!segment) return null;
    const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')));
    return payload.customerId == null ? null : String(payload.customerId);
  } catch {
    return null;
  }
}

export default function NotificationBell({ type = 'admin', customerId }) {
  // type: 'admin' or 'customer'
  // For admin: polls /api/admin/notifications/unread-count
  // For customer: polls /api/notifications/unread-count

  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  // Web Push enable state — only relevant for admin bell. The strip
  // shows when the current device hasn't subscribed to push yet, and
  // hides itself once the user grants permission.
  const [pushOn, setPushOn] = useState(false);
  const [pushEnabling, setPushEnabling] = useState(false);
  const [pushError, setPushError] = useState(null);
  const bellRef = useRef(null);
  const requestGenerationRef = useRef(0);
  const [isMobile, setIsMobile] = useState(() => (
    typeof window !== 'undefined'
    && (typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 767px)').matches
      : window.innerWidth < 768)
  ));
  const titleId = useId();
  const panelId = useId();

  const tokenKey = type === 'admin' ? 'waves_admin_token' : 'waves_token';
  const basePath = type === 'admin' ? '/admin/notifications' : '/customer-notifications';

  const activeToken = typeof localStorage === 'undefined' ? '' : (localStorage.getItem(tokenKey) || '');
  const activeCustomerId = type === 'customer' ? (customerId || tokenCustomerId(activeToken)) : null;
  const identityKey = type === 'customer' ? (activeCustomerId || 'signed-out') : 'admin';

  const closePanel = () => setOpen(false);
  const panelRef = useModalFocus(open, closePanel);
  useLockBodyScroll(open);

  const getHeaders = () => ({
    Authorization: `Bearer ${localStorage.getItem(tokenKey)}`,
    'Content-Type': 'application/json',
  });

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      const sync = () => setIsMobile(window.innerWidth < 768);
      sync();
      window.addEventListener('resize', sync);
      return () => window.removeEventListener('resize', sync);
    }
    const media = window.matchMedia('(max-width: 767px)');
    const sync = (event) => setIsMobile(typeof event?.matches === 'boolean' ? event.matches : media.matches);
    sync();
    media.addEventListener?.('change', sync);
    return () => media.removeEventListener?.('change', sync);
  }, []);

  // A mounted bell survives a multi-property switch. Blank all customer data
  // immediately and invalidate in-flight requests before fetching under the
  // new identity, so property A can never render while property B is active.
  useEffect(() => {
    requestGenerationRef.current += 1;
    setOpen(false);
    setUnreadCount(0);
    setNotifications([]);
    setLoadError(null);
    setActionError(null);
  }, [identityKey, type]);

  // Poll unread count every 30 seconds
  useEffect(() => {
    let cancelled = false;
    const fetchCount = () => {
      if (type === 'customer' && !activeCustomerId) return;
      try {
        fetch(`${API_BASE}${basePath}/unread-count`, { headers: getHeaders() })
          .then((r) => {
            if (!r.ok) throw new Error(`Unread count failed (${r.status})`);
            return r.json();
          })
          .then((d) => { if (!cancelled) setUnreadCount(Number(d.count) || 0); })
          .catch(() => { /* keep the last confirmed count during transient polling failures */ });
      } catch { /* fetch can throw before returning a promise in test shims */ }
    };
    fetchCount();
    const iv = setInterval(fetchCount, 30000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [basePath, identityKey, type, activeCustomerId]);

  // Close on click outside. The panel is portaled to document.body, so it
  // is NOT a DOM descendant of the bell wrapper — check both refs.
  useEffect(() => {
    const handler = (e) => {
      if (bellRef.current && bellRef.current.contains(e.target)) return;
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Self-heal the push link on load and on PWA resume (admin only). iOS
  // Safari rotates/drops push endpoints, and the server deactivates a
  // subscription after a 404/410 send — previously nothing re-registered
  // the device until the user manually hit Enable again. The sync is a
  // no-op unless permission is already granted, so it never prompts.
  // Throttled because iOS fires visibilitychange on every app switch.
  useEffect(() => {
    if (type !== 'admin') return;
    let lastSyncAt = 0;
    const sync = () => {
      if (Date.now() - lastSyncAt < 60 * 60 * 1000) return;
      lastSyncAt = Date.now();
      syncPushSubscription({ apiBase: API_BASE, token: localStorage.getItem(tokenKey) })
        .then((r) => { if (r?.ok) setPushOn(true); })
        .catch(() => {});
    };
    sync();
    const onVisible = () => { if (document.visibilityState === 'visible') sync(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [type]);

  // Probe push state whenever the panel opens. Admin uses Web Push; the
  // customer native shell checks its OS permission without prompting.
  useEffect(() => {
    if (!open) return;
    if (type === 'admin') {
      isPushEnabled({
        apiBase: API_BASE,
        token: localStorage.getItem(tokenKey),
        verifyServer: true,
      }).then(setPushOn).catch(() => setPushOn(false));
      return;
    }
    if (isNativeApp()) {
      nativePushPermissionState()
        .then((state) => setPushOn(state === 'granted'))
        .catch(() => setPushOn(false));
    }
  }, [open, type]);

  const handleEnablePush = async () => {
    setPushEnabling(true);
    setPushError(null);
    try {
      if (type === 'customer' && isNativeApp()) {
        const result = await requestNativePushPermission();
        if (result !== 'granted') {
          throw new Error('Notifications are off. Enable them for Waves in your device Settings, then try again.');
        }
        setPushOn(true);
        return;
      }
      // Pass apiBase so push enrollment hits the same backend the rest
      // of the bell talks to. Without this, ensurePushSubscription
      // defaults to '/api' and breaks in any deployment where the
      // frontend is configured to talk to a different API origin.
      await ensurePushSubscription({
        apiBase: API_BASE,
        token: localStorage.getItem(tokenKey),
      });
      setPushOn(true);
    } catch (err) {
      setPushError(err.message || 'Push setup failed');
    } finally {
      setPushEnabling(false);
    }
  };

  // Load notifications when opened
  const loadNotifications = async () => {
    if (type === 'customer' && !activeCustomerId) return;
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    setNotifications([]);
    try {
      const r = await fetch(`${API_BASE}${basePath}?limit=30`, { headers: getHeaders() });
      if (!r.ok) throw new Error(`Notifications failed (${r.status})`);
      const d = await r.json();
      if (generation === requestGenerationRef.current) {
        setNotifications(Array.isArray(d.notifications) ? d.notifications : []);
      }
    } catch {
      if (generation === requestGenerationRef.current) {
        setLoadError('Notifications could not be loaded. Check your connection and try again.');
      }
    } finally {
      if (generation === requestGenerationRef.current) setLoading(false);
    }
  };

  const handleOpen = () => {
    if (!open) loadNotifications();
    setOpen(!open);
  };

  const markRead = async (id) => {
    const generation = requestGenerationRef.current;
    setActionError(null);
    try {
      const response = await fetch(`${API_BASE}${basePath}/${id}/read`, { method: 'PUT', headers: getHeaders() });
      if (!response.ok) throw new Error(`Mark read failed (${response.status})`);
      if (generation !== requestGenerationRef.current) return false;
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, read_at: new Date().toISOString() } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
      return true;
    } catch {
      if (generation === requestGenerationRef.current) {
        setActionError('That notification could not be marked as read. Please try again.');
      }
      return false;
    }
  };

  const markAllRead = async () => {
    const generation = requestGenerationRef.current;
    setActionError(null);
    try {
      const response = await fetch(`${API_BASE}${basePath}/read-all`, { method: 'PUT', headers: getHeaders() });
      if (!response.ok) throw new Error(`Mark all read failed (${response.status})`);
      if (generation !== requestGenerationRef.current) return;
      setNotifications(prev => prev.map(n => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
      setUnreadCount(0);
    } catch {
      if (generation === requestGenerationRef.current) {
        setActionError('Notifications could not be marked as read. Please try again.');
      }
    }
  };

  const activateNotification = async (notification) => {
    if (!notification.read_at) await markRead(notification.id);
    if (notification.link) {
      setOpen(false);
      window.location.assign(notification.link);
    }
  };

  const notificationKeyDown = (event, notification) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activateNotification(notification);
  };

  // Group by time: Today, Yesterday, This Week, Older
  const groupByTime = (notifs) => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const weekAgo = new Date(today.getTime() - 6 * 86400000);

    const groups = { 'Today': [], 'Yesterday': [], 'This Week': [], 'Older': [] };
    for (const n of notifs) {
      const d = new Date(n.created_at);
      if (d >= today) groups['Today'].push(n);
      else if (d >= yesterday) groups['Yesterday'].push(n);
      else if (d >= weekAgo) groups['This Week'].push(n);
      else groups['Older'].push(n);
    }
    return Object.entries(groups).filter(([, items]) => items.length > 0);
  };

  const timeAgo = (dateStr) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  // Colors — detect theme from type
  const isDark = type === 'admin';
  const colors = isDark
    ? { bg: '#FFFFFF', border: '#E2E8F0', text: '#334155', muted: '#64748B', teal: '#0A7EC2', unreadBg: '#F0F7FC', white: '#0F172A', badge: '#C0392B' }
    // Customer palette = glass tokens (#04395E ink, #0A7EC2 accent) — the
    // old marketing navy/#009CDE rendered inside the glassed portal panel.
    : { bg: '#FFFFFF', border: 'rgba(4,57,94,0.14)', text: '#04395E', muted: '#64748B', teal: '#0A7EC2', unreadBg: 'rgba(10,126,194,0.10)', white: '#FFFFFF', badge: '#C8102E' };

  return (
    <div ref={bellRef} style={{ position: 'relative' }}>
      {/* Bell Button */}
      <button onClick={handleOpen} aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} style={{
        background: 'none', border: 'none', cursor: 'pointer', position: 'relative',
        padding: 8, fontSize: 20, color: isDark ? '#64748B' : colors.text, minWidth: 44, minHeight: 44,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
        {unreadCount > 0 && (
          <span style={{
            position: 'absolute', top: 4, right: 2,
            background: colors.badge, color: '#fff', fontSize: 10, fontWeight: 800,
            minWidth: 18, height: 18, borderRadius: 9, display: 'flex',
            alignItems: 'center', justifyContent: 'center', padding: '0 4px',
          }}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Panel — IMG_3718 style on mobile (full-screen, pill tabs, blue-dot rows); dropdown on desktop.
          Portaled to <body>: the customer portal header is a glass surface
          (backdrop-filter), which makes it the containing block for fixed
          descendants — rendered in place, the panel would collapse to the
          header's box instead of covering the viewport. */}
      {open && createPortal(
        isMobile ? (
          // Customer: floating glass sheet (data-glass="modal" picks up the
          // liquid-glass material from glass-theme.css — same idiom as the
          // account menu). Inset so the rounded sheet floats over the scene
          // and clears the notch + bottom tab bar. Admin: unchanged white
          // full-screen panel (no glass theme mounted on /admin).
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            data-glass={isDark ? undefined : 'modal'}
            style={{
              '--glass-modal-radius': '24px',
              position: 'fixed',
            top: isDark ? 56 : 'calc(env(safe-area-inset-top, 0px) + 8px)',
            left: isDark ? 0 : 10,
            right: isDark ? 0 : 10,
            bottom: isDark ? 56 : 'calc(env(safe-area-inset-bottom, 0px) + 78px)',
            background: '#FFFFFF', zIndex: 9999,
            borderRadius: isDark ? 0 : 24,
            border: isDark ? 'none' : '1px solid #E7E2D7',
            boxShadow: isDark ? 'none' : '0 18px 45px rgba(27,44,91,0.10)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            {/* Header: close + "Notifications" title + mark-all */}
            <div style={{ padding: '16px 20px 8px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div id={titleId} style={{ fontSize: 24, fontWeight: 700, color: '#18181B', letterSpacing: '-0.01em' }}>Notifications</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {unreadCount > 0 && (
                  <button onClick={markAllRead} style={{
                    background: 'none', border: 'none', color: '#52525B',
                    fontSize: 14, fontWeight: 500, cursor: 'pointer', padding: '4px 8px', minHeight: 44,
                  }}>Mark all read</button>
                )}
                <button onClick={() => setOpen(false)} aria-label="Close" style={{
                  width: 44, height: 44, borderRadius: 22, border: 'none',
                  background: isDark ? '#F4F4F5' : 'rgba(255,255,255,0.6)',
                  color: '#18181B', fontSize: 18, lineHeight: 1,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>&#x2715;</button>
              </div>
            </div>

            {/* Enable Push strip — admin only, shown when not yet
                subscribed on this device. iOS reminder is folded into
                the error message that ensurePushSubscription throws. */}
            {type === 'admin' && !pushOn && (
              <PushEnableStrip
                enabling={pushEnabling}
                error={pushError}
                onClick={handleEnablePush}
              />
            )}
            {type === 'customer' && isNativeApp() && !pushOn && (
              <PushEnableStrip
                enabling={pushEnabling}
                error={pushError}
                onClick={handleEnablePush}
                customer
              />
            )}

            {(loadError || actionError) && (
              <div role="alert" style={{
                margin: '0 16px 8px', padding: '10px 12px', borderRadius: 10,
                background: '#FEF2F2', color: '#991B1B', fontSize: 14, lineHeight: 1.4,
              }}>
                {loadError || actionError}
                {loadError && (
                  <button type="button" onClick={loadNotifications} style={{
                    display: 'block', minHeight: 44, marginTop: 4, padding: '0 4px',
                    border: 0, background: 'transparent', color: '#075985',
                    fontSize: 14, fontWeight: 700, cursor: 'pointer',
                  }}>Try again</button>
                )}
              </div>
            )}

            {/* Notification list — overscroll containment keeps the sheet's
                scroll from chaining to the page behind it on iOS. */}
            <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>
              {loading && <div style={{ padding: 40, textAlign: 'center', color: '#71717A', fontSize: 14 }}>Loading…</div>}
              {!loading && !loadError && notifications.length === 0 && (
                <div style={{ padding: 60, textAlign: 'center' }}>
                  <div style={{ fontSize: 14, color: '#71717A' }}>No notifications yet</div>
                </div>
              )}
              {!loading && !loadError && notifications.map(n => (
                <div key={n.id}
                  role={(n.link || !n.read_at) ? 'button' : undefined}
                  tabIndex={(n.link || !n.read_at) ? 0 : undefined}
                  aria-label={(n.link || !n.read_at) ? `${n.title}${n.read_at ? '' : ', unread'}` : undefined}
                  onClick={() => activateNotification(n)}
                  onKeyDown={(event) => notificationKeyDown(event, n)}
                  style={{
                    padding: '14px 20px', cursor: (n.link || !n.read_at) ? 'pointer' : 'default',
                    borderBottom: `1px solid ${isDark ? '#F4F4F5' : 'rgba(27,44,91,0.08)'}`,
                    display: 'flex', gap: 12, alignItems: 'flex-start',
                  }}
                >
                  {/* Blue unread dot — reserves the same slot for read rows so text aligns */}
                  <div style={{ width: 8, flexShrink: 0, paddingTop: 8 }}>
                    {!n.read_at && (
                      <span style={{
                        display: 'block', width: 8, height: 8, borderRadius: '50%', background: '#2563EB',
                      }} />
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 15, fontWeight: 700, color: '#18181B', lineHeight: 1.3,
                    }}>{n.title}</div>
                    {n.body && (
                      <div style={{
                        fontSize: 14, color: '#52525B', marginTop: 4, lineHeight: 1.4,
                      }}>{n.body}</div>
                    )}
                    <div style={{ fontSize: 14, color: '#52525B', marginTop: 6 }}>
                      {timeAgo(n.created_at)}
                    </div>
                  </div>
                  {n.link && (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#18181B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
                      <path d="M7 17L17 7M17 7H8M17 7V16"/>
                    </svg>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          // Desktop: admin keeps the flush right-edge drawer; customer gets a
          // floating glass panel (data-glass="modal" material, inset so the
          // rounded corners read intentionally).
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            data-glass={isDark ? undefined : 'modal'}
            style={{
              '--glass-modal-radius': '24px',
              position: 'fixed', top: isDark ? 56 : 12, right: isDark ? 0 : 12, bottom: isDark ? 0 : 12,
            width: '100%', maxWidth: 400,
            background: colors.bg, border: `1px solid ${colors.border}`,
            borderRadius: isDark ? 0 : 24,
            boxShadow: isDark ? '-4px 0 20px rgba(0,0,0,0.15)' : '0 18px 45px rgba(27,44,91,0.10)',
            zIndex: 9999,
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            {/* Header */}
            <div style={{
              padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              flexShrink: 0,
            }}>
              <div id={titleId} style={{ fontSize: 18, fontWeight: 700, color: colors.text }}>Notifications</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {unreadCount > 0 && (
                  <button onClick={markAllRead} style={{
                    background: 'none', border: 'none', color: colors.teal,
                    fontSize: 14, fontWeight: 600, cursor: 'pointer', padding: '4px 8px', minHeight: 44,
                  }}>Mark all read</button>
                )}
                <button onClick={() => setOpen(false)} aria-label="Close notifications" style={{
                  background: 'none', border: 'none', color: colors.muted,
                  fontSize: 20, cursor: 'pointer', padding: 4, minWidth: 44, minHeight: 44,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>&#x2715;</button>
              </div>
            </div>

            {/* Enable Push strip — admin only, shown when not yet
                subscribed on this device. */}
            {type === 'admin' && !pushOn && (
              <PushEnableStrip
                enabling={pushEnabling}
                error={pushError}
                onClick={handleEnablePush}
              />
            )}
            {type === 'customer' && isNativeApp() && !pushOn && (
              <PushEnableStrip
                enabling={pushEnabling}
                error={pushError}
                onClick={handleEnablePush}
                customer
              />
            )}

            {(loadError || actionError) && (
              <div role="alert" style={{
                margin: '12px 16px 0', padding: '10px 12px', borderRadius: 10,
                background: '#FEF2F2', color: '#991B1B', fontSize: 14, lineHeight: 1.4,
              }}>
                {loadError || actionError}
                {loadError && (
                  <button type="button" onClick={loadNotifications} style={{
                    display: 'block', minHeight: 44, marginTop: 4, padding: '0 4px',
                    border: 0, background: 'transparent', color: '#075985',
                    fontSize: 14, fontWeight: 700, cursor: 'pointer',
                  }}>Try again</button>
                )}
              </div>
            )}

            {/* Notification List */}
            <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>
              {loading && <div style={{ padding: 40, textAlign: 'center', color: colors.muted }}>Loading...</div>}
              {!loading && !loadError && notifications.length === 0 && (
                <div style={{ padding: 60, textAlign: 'center' }}>
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12 }}>
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                  </svg>
                  <div style={{ fontSize: 14, color: colors.muted }}>No notifications yet</div>
                </div>
              )}
              {!loading && groupByTime(notifications).map(([group, items]) => (
                <div key={group}>
                  <div style={{
                    padding: '8px 20px', fontSize: 12, fontWeight: 700, color: colors.muted,
                    textTransform: 'uppercase', letterSpacing: 0.5,
                    background: isDark ? '#0f172a' : 'rgba(255,255,255,0.75)', position: 'sticky', top: 0,
                    backdropFilter: isDark ? 'none' : 'blur(8px)', WebkitBackdropFilter: isDark ? 'none' : 'blur(8px)',
                  }}>{group}</div>
                  {items.map(n => (
                    <div key={n.id}
                      role={(n.link || !n.read_at) ? 'button' : undefined}
                      tabIndex={(n.link || !n.read_at) ? 0 : undefined}
                      aria-label={(n.link || !n.read_at) ? `${n.title}${n.read_at ? '' : ', unread'}` : undefined}
                      onClick={() => activateNotification(n)}
                      onKeyDown={(event) => notificationKeyDown(event, n)}
                      style={{
                        padding: '12px 20px', cursor: (n.link || !n.read_at) ? 'pointer' : 'default',
                        borderBottom: `1px solid ${colors.border}`,
                        background: n.read_at ? 'transparent' : colors.unreadBg,
                        display: 'flex', gap: 12, alignItems: 'flex-start',
                        minHeight: 44,
                      }}
                    >
                      <span style={{ fontSize: 20, flexShrink: 0, marginTop: 2 }}>{n.icon || '\u{1F514}'}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 14, fontWeight: n.read_at ? 400 : 700, color: colors.text,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{n.title}</div>
                        {n.body && (
                          <div style={{
                            fontSize: 14, color: colors.muted, marginTop: 2, lineHeight: 1.4,
                            overflow: 'hidden', textOverflow: 'ellipsis',
                            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                          }}>{n.body}</div>
                        )}
                        <div style={{ fontSize: 14, color: colors.muted, marginTop: 4 }}>
                          {timeAgo(n.created_at)}
                        </div>
                      </div>
                      {!n.read_at && (
                        <span style={{
                          width: 8, height: 8, borderRadius: '50%', background: colors.teal,
                          flexShrink: 0, marginTop: 6,
                        }} />
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        ),
        document.body
      )}
    </div>
  );
}

// Inline strip rendered in both mobile + desktop bell views when the
// admin hasn't yet subscribed this device to Web Push. iOS PWA
// requirement is surfaced via the error-message path inside
// ensurePushSubscription, not pre-emptively here, so Android/desktop
// users don't see an irrelevant warning.
function PushEnableStrip({ enabling, error, onClick, customer = false }) {
  return (
    <div style={{
      padding: '12px 16px',
      background: '#F4F4F5',
      borderBottom: '1px solid #E4E4E7',
      fontSize: 14,
      color: '#18181B',
    }}>
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontWeight: 600 }}>Get push notifications on this device</span>
      </div>
      <div style={{ marginBottom: 8, color: '#52525B', fontSize: 14 }}>
        {customer
          ? 'Get service, appointment, and account updates even when the app is closed.'
          : 'Banner alerts for failed payments, overdue invoices, unmapped calls, and more.'}
      </div>
      <button
        onClick={onClick}
        disabled={enabling}
        style={{
          minHeight: 44,
          padding: '8px 14px',
          background: '#18181B',
          color: '#FFFFFF',
          border: 'none',
          borderRadius: 6,
          fontSize: 14,
          fontWeight: 500,
          cursor: enabling ? 'wait' : 'pointer',
        }}
      >
        {enabling ? 'Enabling…' : 'Enable push'}
      </button>
      {error && (
        <div style={{ marginTop: 8, color: '#991B1B', fontSize: 14, lineHeight: 1.4 }}>
          {error}
        </div>
      )}
    </div>
  );
}
