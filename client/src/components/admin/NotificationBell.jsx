import { useState, useEffect, useRef } from 'react';
import { ensurePushSubscription, isPushEnabled } from '../../lib/push-subscribe.js';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = {
  bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', input: '#FFFFFF',
  teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B',
  text: '#334155', muted: '#64748B', white: '#fff',
};

const PRIORITY_DOT = { urgent: D.red, high: D.amber, normal: D.teal, low: D.muted };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

function timeAgo(date) {
  const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState([]);
  const [pushOn, setPushOn] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const panelRef = useRef(null);

  // Bell read endpoints live at /admin/notifications (admin-notifications.js),
  // NOT /admin/push (which only handles push subscriptions + VAPID + prefs).
  // The previous URLs returned 404 → the bell silently rendered "all caught
  // up" forever. Response shape: { count } for unread, { notifications, page, limit }
  // for the list. Live dashboard alerts (id prefixed `live:`) are merged
  // server-side so they appear here alongside persisted notifications.
  const loadCount = async () => {
    try { const r = await adminFetch('/admin/notifications/unread-count'); setUnread(r.count || 0); }
    catch { /* silent */ }
  };

  const loadList = async () => {
    try { const r = await adminFetch('/admin/notifications?limit=25'); setItems(r.notifications || []); }
    catch { setItems([]); }
  };

  useEffect(() => {
    loadCount();
    isPushEnabled().then(setPushOn);
    const t = setInterval(loadCount, 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!open) return;
    loadList();
    const onClick = (e) => { if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const enablePush = async () => {
    setEnabling(true);
    // Forward the same API_BASE the rest of the bell uses. Without this
    // ensurePushSubscription falls back to '/api', so on hosts where the
    // frontend is configured to talk to a different API (e.g. staging
    // pointing at a separate backend) push enable hits the wrong base
    // and fails silently while every other bell call succeeds.
    try { await ensurePushSubscription({ apiBase: API_BASE }); setPushOn(true); }
    catch (e) { alert('Push not enabled: ' + e.message); }
    finally { setEnabling(false); }
  };

  const handleClickItem = async (n) => {
    // Live alerts (id prefix `live:`) aren't persisted — skip the
    // mark-read API call. They auto-clear when their condition clears
    // (e.g. invoice gets paid → ar_overdue_60 vanishes on next poll).
    const isLive = String(n.id).startsWith('live:');
    if (!isLive) {
      try { await adminFetch(`/admin/notifications/${n.id}/read`, { method: 'PUT' }); } catch {}
    }
    if (n.link) window.location.href = n.link;
    else { setOpen(false); loadList(); loadCount(); }
  };

  const markAll = async () => {
    try { await adminFetch('/admin/notifications/read-all', { method: 'PUT' }); }
    finally { loadList(); loadCount(); }
  };

  return (
    <div ref={panelRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        style={{
          position: 'relative', width: 40, height: 40, borderRadius: 10,
          background: open ? `${D.teal}22` : 'transparent', border: `1px solid ${open ? D.teal : D.border}`,
          color: D.text, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
        }}
      >
        🔔
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: -4, right: -4, minWidth: 18, height: 18, padding: '0 5px',
            background: D.red, color: D.white, borderRadius: 9, fontSize: 10, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: "'JetBrains Mono', monospace",
          }}>{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 48, width: 380, maxHeight: 540, overflow: 'hidden',
          background: D.card, border: `1px solid ${D.border}`, borderRadius: 12,
          boxShadow: '0 12px 32px rgba(0,0,0,0.12)', zIndex: 1000, display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ padding: '12px 14px', borderBottom: `1px solid ${D.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 700, color: '#0F172A', fontSize: 14 }}>Notifications</div>
            <button onClick={markAll} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 12, cursor: 'pointer' }}>
              Mark all read
            </button>
          </div>

          {!pushOn && (
            <div style={{ padding: 12, background: `${D.teal}11`, borderBottom: `1px solid ${D.border}`, fontSize: 12, color: D.text }}>
              <div style={{ marginBottom: 6 }}>📱 Get push notifications on this device</div>
              <button
                onClick={enablePush}
                disabled={enabling}
                style={{ padding: '6px 12px', background: D.teal, color: D.white, border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
              >
                {enabling ? 'Enabling…' : 'Enable push'}
              </button>
            </div>
          )}

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {items.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: D.muted, fontSize: 13 }}>
                You're all caught up.
              </div>
            ) : items.map((n) => {
              const meta = n.metadata ? (typeof n.metadata === 'string' ? safeJSON(n.metadata) : n.metadata) : {};
              const priority = meta?.priority || 'normal';
              const isUnread = !n.read_at;
              return (
                <div
                  key={n.id}
                  onClick={() => handleClickItem(n)}
                  style={{
                    padding: '10px 12px', borderBottom: `1px solid ${D.border}`,
                    cursor: n.link ? 'pointer' : 'default', display: 'flex', gap: 10,
                    background: isUnread ? `${D.teal}08` : 'transparent',
                  }}
                >
                  <div style={{ width: 8, height: 8, borderRadius: 4, background: PRIORITY_DOT[priority], marginTop: 6, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ fontWeight: isUnread ? 700 : 500, color: '#0F172A', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {n.icon} {n.title}
                      </div>
                      <div style={{ fontSize: 11, color: D.muted, fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>
                        {timeAgo(n.created_at)}
                      </div>
                    </div>
                    {n.body && (
                      <div style={{ fontSize: 12, color: D.muted, marginTop: 2, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                        {n.body}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ padding: 8, borderTop: `1px solid ${D.border}`, textAlign: 'center' }}>
            <a href="/admin/communications#notifications" style={{ color: D.teal, fontSize: 12, textDecoration: 'none' }}>
              Notification settings →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function safeJSON(s) { try { return JSON.parse(s); } catch { return {}; } }
