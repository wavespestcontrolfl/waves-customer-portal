import { useState, useEffect, useCallback } from 'react';

const API = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#FFFFFF', card: '#F8FAFC', border: '#E2E8F0', teal: '#0A7EC2', red: '#C0392B', text: '#334155', muted: '#64748B', white: '#fff' };

function timeAgo(dateStr) {
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function SmsInboxWidget() {
  const [messages, setMessages] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [expanded, setExpanded] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);

  const token = localStorage.getItem('adminToken');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const fetchInbox = useCallback(async () => {
    try {
      const r = await fetch(`${API}/admin/dashboard-ops/inbox`, { headers });
      if (!r.ok) return;
      const data = await r.json();
      setMessages(data.messages || []);
      setUnreadCount(data.unreadCount || 0);
    } catch {}
  }, [token]);

  useEffect(() => {
    fetchInbox();
    const iv = setInterval(fetchInbox, 30000);
    return () => clearInterval(iv);
  }, [fetchInbox]);

  const handleExpand = async (msg) => {
    if (expanded === msg.id) { setExpanded(null); return; }
    setExpanded(msg.id);
    setReplyText('');
    if (!msg.isRead) {
      try {
        await fetch(`${API}/admin/dashboard-ops/inbox/${msg.id}/read`, { method: 'POST', headers });
        setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, isRead: true } : m));
        setUnreadCount(prev => Math.max(0, prev - 1));
      } catch {}
    }
  };

  const handleReply = async (msgId) => {
    if (!replyText.trim() || sending) return;
    setSending(true);
    try {
      const r = await fetch(`${API}/admin/dashboard-ops/inbox/${msgId}/reply`, {
        method: 'POST', headers, body: JSON.stringify({ body: replyText }),
      });
      if (r.ok) { setReplyText(''); setExpanded(null); }
    } catch {}
    setSending(false);
  };

  return (
    <div style={{ background: D.bg, borderRadius: 12, border: `1px solid ${D.border}`, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: `1px solid ${D.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: D.text }}>Messages</span>
          {unreadCount > 0 && (
            <span style={{ background: D.red, color: D.white, fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 10, minWidth: 20, textAlign: 'center' }}>
              {unreadCount}
            </span>
          )}
        </div>
        <a href="/admin/communications" style={{ color: D.teal, fontSize: 13, textDecoration: 'none' }}>View all &rarr;</a>
      </div>

      {/* Message list */}
      <div style={{ maxHeight: 380, overflowY: 'auto' }}>
        {messages.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: D.muted, fontSize: 13 }}>No messages</div>
        )}
        {messages.map(msg => (
          <div key={msg.id} style={{ borderBottom: `1px solid ${D.border}` }}>
            <div
              onClick={() => handleExpand(msg)}
              style={{
                padding: '12px 16px', cursor: 'pointer',
                borderLeft: msg.isRead ? '3px solid transparent' : `3px solid ${D.teal}`,
                background: expanded === msg.id ? D.card : 'transparent',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: msg.isRead ? 400 : 600, color: D.text }}>
                  {msg.customerName || msg.fromPhone}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {!msg.isRead && <span style={{ width: 7, height: 7, borderRadius: '50%', background: D.teal, display: 'inline-block' }} />}
                  <span style={{ fontSize: 11, color: D.muted }}>{timeAgo(msg.createdAt)}</span>
                </div>
              </div>
              <div style={{ fontSize: 12, color: D.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {(msg.messageBody || '').substring(0, 80)}
              </div>
            </div>

            {/* Expanded view */}
            {expanded === msg.id && (
              <div style={{ padding: '0 16px 14px', background: D.card }}>
                <div style={{ fontSize: 13, color: D.text, lineHeight: 1.5, marginBottom: 10, whiteSpace: 'pre-wrap' }}>
                  {msg.messageBody}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={replyText}
                    onChange={e => setReplyText(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleReply(msg.id)}
                    placeholder="Quick reply..."
                    style={{
                      flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid #CBD5E1',
                      background: '#FFFFFF', color: '#0F172A', fontSize: 13, outline: 'none',
                    }}
                  />
                  <button
                    onClick={() => handleReply(msg.id)}
                    disabled={sending || !replyText.trim()}
                    style={{
                      padding: '8px 16px', borderRadius: 8, border: 'none',
                      background: D.teal, color: D.white, fontSize: 13, fontWeight: 600,
                      cursor: sending ? 'wait' : 'pointer', opacity: sending || !replyText.trim() ? 0.5 : 1,
                    }}
                  >
                    Send
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
