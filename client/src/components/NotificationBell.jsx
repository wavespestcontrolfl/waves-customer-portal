import { useState, useEffect, useRef } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export default function NotificationBell({ type = 'admin', customerId }) {
  // type: 'admin' or 'customer'
  // For admin: polls /api/admin/notifications/unread-count
  // For customer: polls /api/notifications/unread-count

  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('account'); // 'account' | 'whats_new'
  const panelRef = useRef(null);
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

  const tokenKey = type === 'admin' ? 'waves_admin_token' : 'waves_token';
  const basePath = type === 'admin' ? '/admin/notifications' : '/customer-notifications';

  const getHeaders = () => ({
    Authorization: `Bearer ${localStorage.getItem(tokenKey)}`,
    'Content-Type': 'application/json',
  });

  // Poll unread count every 30 seconds
  useEffect(() => {
    const fetchCount = () => {
      fetch(`${API_BASE}${basePath}/unread-count`, { headers: getHeaders() })
        .then(r => r.json())
        .then(d => setUnreadCount(d.count || 0))
        .catch(() => {});
    };
    fetchCount();
    const iv = setInterval(fetchCount, 30000);
    return () => clearInterval(iv);
  }, []);

  // Close on click outside
  useEffect(() => {
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Load notifications when opened
  const loadNotifications = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}${basePath}?limit=30`, { headers: getHeaders() });
      const d = await r.json();
      setNotifications(d.notifications || []);
    } catch {}
    setLoading(false);
  };

  const handleOpen = () => {
    if (!open) loadNotifications();
    setOpen(!open);
  };

  const markRead = async (id) => {
    await fetch(`${API_BASE}${basePath}/${id}/read`, { method: 'PUT', headers: getHeaders() }).catch(() => {});
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read_at: new Date().toISOString() } : n));
    setUnreadCount(prev => Math.max(0, prev - 1));
  };

  const markAllRead = async () => {
    await fetch(`${API_BASE}${basePath}/read-all`, { method: 'PUT', headers: getHeaders() }).catch(() => {});
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
    : { bg: '#FFFFFF', border: '#CBD5E1', text: '#1B2C5B', muted: '#64748B', teal: '#009CDE', unreadBg: '#E3F5FD', white: '#FFFFFF', badge: '#C8102E' };

  return (
    <div ref={panelRef} style={{ position: 'relative' }}>
      {/* Bell Button */}
      <button onClick={handleOpen} style={{
        background: 'none', border: 'none', cursor: 'pointer', position: 'relative',
        padding: 8, fontSize: 20, color: isDark ? '#64748B' : '#fff', minWidth: 44, minHeight: 44,
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

      {/* Panel — IMG_3718 style on mobile (full-screen, pill tabs, blue-dot rows); dropdown on desktop */}
      {open && (
        isMobile ? (
          <div style={{
            position: 'fixed', top: isDark ? 56 : 0, left: 0, right: 0, bottom: 56,
            background: '#FFFFFF', zIndex: 9999,
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
                  background: '#F4F4F5', color: '#18181B', fontSize: 18, lineHeight: 1,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>&#x2715;</button>
              </div>
            </div>

            {/* Pill tabs: Account / What's new */}
            <div style={{ padding: '8px 20px 16px', flexShrink: 0 }}>
              <div style={{
                display: 'flex', gap: 4, background: '#F4F4F5',
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

            {/* Notification list */}
            <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
              {loading && <div style={{ padding: 40, textAlign: 'center', color: '#71717A', fontSize: 14 }}>Loading…</div>}
              {!loading && tab === 'account' && notifications.length === 0 && (
                <div style={{ padding: 60, textAlign: 'center' }}>
                  <div style={{ fontSize: 14, color: '#71717A' }}>No notifications yet</div>
                </div>
              )}
              {!loading && tab === 'whats_new' && (
                <div style={{ padding: 60, textAlign: 'center' }}>
                  <div style={{ fontSize: 14, color: '#71717A' }}>Nothing new right now</div>
                </div>
              )}
              {!loading && tab === 'account' && notifications.map(n => (
                <div key={n.id}
                  onClick={() => {
                    if (!n.read_at) markRead(n.id);
                    if (n.link) { setOpen(false); window.location.href = n.link; }
                  }}
                  style={{
                    padding: '14px 20px', cursor: n.link ? 'pointer' : 'default',
                    borderBottom: '1px solid #F4F4F5',
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
          <div style={{
            position: 'fixed', top: isDark ? 56 : 0, right: 0, bottom: 0,
            width: '100%', maxWidth: 400,
            background: colors.bg, border: `1px solid ${colors.border}`,
            boxShadow: '-4px 0 20px rgba(0,0,0,0.15)', zIndex: 9999,
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
                <button onClick={() => setOpen(false)} style={{
                  background: 'none', border: 'none', color: colors.muted,
                  fontSize: 20, cursor: 'pointer', padding: 4, minWidth: 44, minHeight: 44,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>&#x2715;</button>
              </div>
            </div>

            {/* Notification List */}
            <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
              {loading && <div style={{ padding: 40, textAlign: 'center', color: colors.muted }}>Loading...</div>}
              {!loading && notifications.length === 0 && (
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
                    padding: '8px 20px', fontSize: 11, fontWeight: 700, color: colors.muted,
                    textTransform: 'uppercase', letterSpacing: 0.5,
                    background: isDark ? '#0f172a' : '#f5f5f5', position: 'sticky', top: 0,
                  }}>{group}</div>
                  {items.map(n => (
                    <div key={n.id}
                      onClick={() => {
                        if (!n.read_at) markRead(n.id);
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
        )
      )}
    </div>
  );
}
