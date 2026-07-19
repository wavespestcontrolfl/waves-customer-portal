import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ensurePushSubscription, isPushEnabled, syncPushSubscription } from '../lib/push-subscribe.js';
import { isNativeApp, nativePushPermissionState, requestNativePushPermission } from '../native/nativePush.js';
import api from '../utils/api';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export default function NotificationBell({ type = 'admin', customerId }) {
  // type: 'admin' or 'customer'
  // For admin: polls /api/admin/notifications/unread-count
  // For customer: polls /api/notifications/unread-count

  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [tab, setTab] = useState('account'); // 'account' | 'whats_new'
  // Web Push enable state — only relevant for admin bell. The strip
  // shows when the current device hasn't subscribed to push yet, and
  // hides itself once the user grants permission.
  const [pushOn, setPushOn] = useState(false);
  const [pushEnabling, setPushEnabling] = useState(false);
  const [pushError, setPushError] = useState(null);
  const bellRef = useRef(null);
  const panelRef = useRef(null);
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

  const tokenKey = type === 'admin' ? 'waves_admin_token' : 'waves_token';
  const basePath = type === 'admin' ? '/admin/notifications' : '/customer-notifications';

  const getHeaders = () => ({
    Authorization: `Bearer ${localStorage.getItem(tokenKey)}`,
    'Content-Type': 'application/json',
  });

  // Customer requests go through the shared api client: customer access
  // tokens expire after 15 minutes and only the client can rotate the
  // refresh session on a 401 (and it rejects on error responses, so a 401
  // body is never mistaken for an empty notification list). The admin bell
  // keeps its separate raw-fetch flow — admin auth is a different token.
  const requestJson = (path, options = {}) => {
    if (type !== 'admin') return api.request(path, options);
    return fetch(`${API_BASE}${path}`, { ...options, headers: getHeaders() })
      .then((r) => {
        if (!r.ok) {
          const err = new Error(`Request failed (${r.status})`);
          err.status = r.status;
          throw err;
        }
        return r.json();
      });
  };

  // Poll unread count every 30 seconds
  useEffect(() => {
    const fetchCount = () => {
      requestJson(`${basePath}/unread-count`)
        .then(d => setUnreadCount(d.count || 0))
        .catch(() => {});
    };
    fetchCount();
    const iv = setInterval(fetchCount, 30000);
    return () => clearInterval(iv);
  }, []);

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

  // Lock the page scroll while the customer panel is open — on iOS a touch
  // scroll on the panel otherwise chains to the page behind it.
  useEffect(() => {
    if (!open || type === 'admin') return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [open, type]);

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

  // Probe Web Push state when the panel opens (admin only). Re-runs on
  // each open so a user who enabled push elsewhere doesn't see a stale
  // "Enable push" strip. Admins get operational Web Push. In the native
  // customer app this strip is the ONLY push opt-in surface — startup never
  // prompts for permission (nativePush.js delegates that explicit gesture
  // here), so without it a fresh install could never grant APNs permission.
  // Customer web stays strip-free.
  const showPushStrip = (type === 'admin' || isNativeApp()) && !pushOn;
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

  // Load notifications when opened. A failed load is recorded — rendering
  // "No notifications yet" (or stale rows) for an outage would present a
  // broken inbox as a confirmed-empty one. Monotonic sequence: reopening
  // while a request is in flight starts a new one, and only the latest
  // issued request may write — a slow older failure must not hide a newer
  // successful list behind the retry screen.
  const loadSeqRef = useRef(0);
  const loadNotifications = async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const d = await requestJson(`${basePath}?limit=30`);
      if (seq !== loadSeqRef.current) return;
      setNotifications(d.notifications || []);
    } catch {
      if (seq !== loadSeqRef.current) return;
      setLoadFailed(true);
    }
    setLoading(false);
  };

  const handleOpen = () => {
    if (!open) loadNotifications();
    setOpen(!open);
  };

  // Escape closes the panel and returns focus to the bell — outside-click
  // alone left keyboard users with no way to dismiss it.
  const bellButtonRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        bellButtonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const markRead = async (id) => {
    // Only reflect the read state the server actually accepted — a rejected
    // write (expired token the refresh couldn't save) must not clear badges.
    try {
      await requestJson(`${basePath}/${id}/read`, { method: 'PUT' });
    } catch { return; }
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read_at: new Date().toISOString() } : n));
    setUnreadCount(prev => Math.max(0, prev - 1));
  };

  const markAllRead = async () => {
    try {
      await requestJson(`${basePath}/read-all`, { method: 'PUT' });
    } catch { return; }
    setNotifications(prev => prev.map(n => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
    setUnreadCount(0);
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
      <button ref={bellButtonRef} onClick={handleOpen} aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'} aria-haspopup="dialog" aria-expanded={open} style={{
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
          <div ref={panelRef} role="dialog" aria-label="Notifications" data-glass={isDark ? undefined : 'modal'} style={{
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
              <div style={{ fontSize: 24, fontWeight: 700, color: '#18181B', letterSpacing: '-0.01em' }}>Notifications</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {unreadCount > 0 && (
                  <button onClick={markAllRead} style={{
                    background: 'none', border: 'none', color: '#52525B',
                    fontSize: 13, fontWeight: 500, cursor: 'pointer', padding: '4px 8px',
                  }}>Mark all read</button>
                )}
                <button onClick={() => setOpen(false)} aria-label="Close" style={{
                  width: 36, height: 36, borderRadius: 18, border: 'none',
                  background: isDark ? '#F4F4F5' : 'rgba(255,255,255,0.6)',
                  color: '#18181B', fontSize: 18, lineHeight: 1,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>&#x2715;</button>
              </div>
            </div>

            {/* Pill tabs: Account / What's new */}
            <div style={{ padding: '8px 20px 16px', flexShrink: 0 }}>
              <div style={{
                display: 'flex', gap: 4,
                background: isDark ? '#F4F4F5' : 'rgba(27,44,91,0.07)',
                borderRadius: 999, padding: 4, width: 'fit-content',
              }}>
                {[
                  { key: 'account', label: 'Account' },
                  { key: 'whats_new', label: "What's new" },
                ].map(({ key, label }) => {
                  const active = tab === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setTab(key)}
                      style={{
                        padding: '8px 20px', borderRadius: 999, border: 'none',
                        background: active ? '#FFFFFF' : 'transparent',
                        color: active ? '#18181B' : '#71717A',
                        fontSize: 14, fontWeight: 600, cursor: 'pointer',
                        boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                      }}
                    >{label}</button>
                  );
                })}
              </div>
            </div>

            {/* Enable Push strip — admin only, shown when not yet
                subscribed on this device. iOS reminder is folded into
                the error message that ensurePushSubscription throws. */}
            {showPushStrip && (
              <PushEnableStrip
                enabling={pushEnabling}
                error={pushError}
                onClick={handleEnablePush}
              />
            )}

            {/* Notification list — overscroll containment keeps the sheet's
                scroll from chaining to the page behind it on iOS. */}
            <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>
              {loading && <div style={{ padding: 40, textAlign: 'center', color: '#71717A', fontSize: 14 }}>Loading…</div>}
              {!loading && loadFailed && tab === 'account' && (
                <div style={{ padding: 60, textAlign: 'center' }}>
                  <div style={{ fontSize: 14, color: '#71717A' }}>Notifications couldn&apos;t be loaded.</div>
                  <button type="button" onClick={loadNotifications} style={{
                    marginTop: 12, padding: '8px 14px', borderRadius: 8, border: '1px solid #D8D0C0',
                    background: '#fff', color: '#04395E', fontSize: 14, fontWeight: 800, cursor: 'pointer',
                  }}>Try again</button>
                </div>
              )}
              {!loading && !loadFailed && tab === 'account' && notifications.length === 0 && (
                <div style={{ padding: 60, textAlign: 'center' }}>
                  <div style={{ fontSize: 14, color: '#71717A' }}>No notifications yet</div>
                </div>
              )}
              {!loading && tab === 'whats_new' && (
                <div style={{ padding: 60, textAlign: 'center' }}>
                  <div style={{ fontSize: 14, color: '#71717A' }}>Nothing new right now</div>
                </div>
              )}
              {!loading && !loadFailed && tab === 'account' && notifications.map(n => (
                <div key={n.id}
                  onClick={async () => {
                    if (!n.read_at) await markRead(n.id);
                    if (n.link) { setOpen(false); window.location.href = n.link; }
                  }}
                  style={{
                    padding: '14px 20px', cursor: n.link ? 'pointer' : 'default',
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
                    <div style={{ fontSize: 12, color: '#A1A1AA', marginTop: 6 }}>
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
          <div ref={panelRef} role="dialog" aria-label="Notifications" data-glass={isDark ? undefined : 'modal'} style={{
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
              <div style={{ fontSize: 16, fontWeight: 700, color: colors.text }}>Notifications</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {unreadCount > 0 && (
                  <button onClick={markAllRead} style={{
                    background: 'none', border: 'none', color: colors.teal,
                    fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '4px 8px',
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
            {showPushStrip && (
              <PushEnableStrip
                enabling={pushEnabling}
                error={pushError}
                onClick={handleEnablePush}
              />
            )}

            {/* Notification List */}
            <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>
              {loading && <div style={{ padding: 40, textAlign: 'center', color: colors.muted }}>Loading...</div>}
              {!loading && loadFailed && (
                <div style={{ padding: 60, textAlign: 'center' }}>
                  <div style={{ fontSize: 14, color: colors.muted }}>Notifications couldn&apos;t be loaded.</div>
                  <button type="button" onClick={loadNotifications} style={{
                    marginTop: 12, padding: '8px 14px', borderRadius: 8, border: `1px solid ${colors.border || '#D8D0C0'}`,
                    background: 'transparent', color: colors.text || colors.muted, fontSize: 14, fontWeight: 700, cursor: 'pointer',
                  }}>Try again</button>
                </div>
              )}
              {!loading && !loadFailed && notifications.length === 0 && (
                <div style={{ padding: 60, textAlign: 'center' }}>
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12 }}>
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                  </svg>
                  <div style={{ fontSize: 14, color: colors.muted }}>No notifications yet</div>
                </div>
              )}
              {!loading && !loadFailed && groupByTime(notifications).map(([group, items]) => (
                <div key={group}>
                  <div style={{
                    padding: '8px 20px', fontSize: 11, fontWeight: 700, color: colors.muted,
                    textTransform: 'uppercase', letterSpacing: 0.5,
                    background: isDark ? '#0f172a' : 'rgba(255,255,255,0.75)', position: 'sticky', top: 0,
                    backdropFilter: isDark ? 'none' : 'blur(8px)', WebkitBackdropFilter: isDark ? 'none' : 'blur(8px)',
                  }}>{group}</div>
                  {items.map(n => (
                    <div key={n.id}
                      onClick={async () => {
                        if (!n.read_at) await markRead(n.id);
                        if (n.link) { setOpen(false); window.location.href = n.link; }
                      }}
                      style={{
                        padding: '12px 20px', cursor: n.link ? 'pointer' : 'default',
                        borderBottom: `1px solid ${colors.border}`,
                        background: n.read_at ? 'transparent' : colors.unreadBg,
                        display: 'flex', gap: 12, alignItems: 'flex-start',
                        minHeight: 44,
                      }}
                    >
                      <span style={{ fontSize: 20, flexShrink: 0, marginTop: 2 }}>{n.icon || '\u{1F514}'}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 13, fontWeight: n.read_at ? 400 : 700, color: colors.text,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{n.title}</div>
                        {n.body && (
                          <div style={{
                            fontSize: 12, color: colors.muted, marginTop: 2, lineHeight: 1.4,
                            overflow: 'hidden', textOverflow: 'ellipsis',
                            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                          }}>{n.body}</div>
                        )}
                        <div style={{ fontSize: 11, color: colors.muted, marginTop: 4 }}>
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
function PushEnableStrip({ enabling, error, onClick }) {
  return (
    <div style={{
      padding: '12px 16px',
      background: '#F4F4F5',
      borderBottom: '1px solid #E4E4E7',
      fontSize: 13,
      color: '#18181B',
    }}>
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontWeight: 600 }}>Get push notifications on this device</span>
      </div>
      <div style={{ marginBottom: 8, color: '#52525B', fontSize: 12 }}>
        Banner alerts for failed payments, overdue invoices, unmapped calls, and more.
      </div>
      <button
        onClick={onClick}
        disabled={enabling}
        style={{
          padding: '8px 14px',
          background: '#18181B',
          color: '#FFFFFF',
          border: 'none',
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 500,
          cursor: enabling ? 'wait' : 'pointer',
        }}
      >
        {enabling ? 'Enabling…' : 'Enable push'}
      </button>
      {error && (
        <div style={{ marginTop: 8, color: '#C8312F', fontSize: 12, lineHeight: 1.4 }}>
          {error}
        </div>
      )}
    </div>
  );
}
