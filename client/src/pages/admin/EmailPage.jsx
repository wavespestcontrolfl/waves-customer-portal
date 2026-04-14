import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path.replace(/^\/api/, '')}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
}

const D = {
  bg: '#0f1923', card: '#1e293b', border: '#334155',
  teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b',
  red: '#ef4444', purple: '#a855f7',
  text: '#e2e8f0', muted: '#94a3b8', white: '#fff',
};

function timeAgo(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function EmailPage() {
  const [status, setStatus] = useState(null);
  const [stats, setStats] = useState(null);
  const [emails, setEmails] = useState([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [thread, setThread] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const r = await adminFetch('/api/admin/email/oauth/status');
      const d = await r.json();
      setStatus(d);
    } catch { setStatus({ connected: false }); }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const r = await adminFetch('/api/admin/email/stats');
      const d = await r.json();
      setStats(d);
    } catch { /* ignore */ }
  }, []);

  const loadEmails = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page, limit: 50, is_archived: showArchived });
      if (filter === 'unread') params.set('category', 'unread');
      else if (filter === 'starred') params.set('category', 'starred');
      else if (filter === 'vendor') params.set('category', 'vendor');
      if (search) params.set('search', search);

      const r = await adminFetch(`/api/admin/email/inbox?${params}`);
      const d = await r.json();
      setEmails(d.emails || []);
      setTotal(d.total || 0);
    } catch { /* ignore */ }
  }, [filter, search, page, showArchived]);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => { if (status?.connected) { loadStats(); loadEmails(); } }, [status, loadStats, loadEmails]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await adminFetch('/api/admin/email/sync', { method: 'POST' });
      await loadEmails();
      await loadStats();
    } catch { /* ignore */ }
    setSyncing(false);
  };

  const openEmail = async (email) => {
    setSelectedEmail(email);
    setReplyText('');
    try {
      // Mark as read
      if (!email.is_read) {
        await adminFetch(`/api/admin/email/message/${email.id}/read`, { method: 'POST' });
        setEmails(prev => prev.map(e => e.id === email.id ? { ...e, is_read: true } : e));
        loadStats();
      }
      // Load thread
      const r = await adminFetch(`/api/admin/email/thread/${email.gmail_thread_id}`);
      const d = await r.json();
      setThread(d.thread || []);
    } catch { /* ignore */ }
  };

  const handleStar = async (e, email) => {
    e.stopPropagation();
    try {
      const r = await adminFetch(`/api/admin/email/message/${email.id}/star`, { method: 'POST' });
      const d = await r.json();
      setEmails(prev => prev.map(em => em.id === email.id ? { ...em, is_starred: d.is_starred } : em));
    } catch { /* ignore */ }
  };

  const handleArchive = async (emailId) => {
    try {
      await adminFetch(`/api/admin/email/message/${emailId}/archive`, { method: 'POST' });
      setEmails(prev => prev.filter(e => e.id !== emailId));
      if (selectedEmail?.id === emailId) setSelectedEmail(null);
      loadStats();
    } catch { /* ignore */ }
  };

  const handleTrash = async (emailId) => {
    try {
      await adminFetch(`/api/admin/email/message/${emailId}/trash`, { method: 'POST' });
      setEmails(prev => prev.filter(e => e.id !== emailId));
      if (selectedEmail?.id === emailId) setSelectedEmail(null);
      loadStats();
    } catch { /* ignore */ }
  };

  const handleReply = async () => {
    if (!replyText.trim() || !selectedEmail) return;
    setSending(true);
    try {
      await adminFetch('/api/admin/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: selectedEmail.from_address,
          subject: `Re: ${selectedEmail.subject || ''}`,
          body: replyText.replace(/\n/g, '<br>'),
          threadId: selectedEmail.gmail_thread_id,
        }),
      });
      setReplyText('');
      // Reload thread
      const r = await adminFetch(`/api/admin/email/thread/${selectedEmail.gmail_thread_id}`);
      const d = await r.json();
      setThread(d.thread || []);
    } catch { /* ignore */ }
    setSending(false);
  };

  // Not connected — show connect card
  if (status && !status.connected) {
    return (
      <div style={{ padding: 32 }}>
        <div style={{ fontSize: 28, fontWeight: 700, color: D.white, marginBottom: 24 }}>Email</div>
        <div style={{ background: D.card, borderRadius: 12, padding: 40, textAlign: 'center', border: `1px solid ${D.border}`, maxWidth: 480, margin: '60px auto' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📧</div>
          <div style={{ fontSize: 20, fontWeight: 600, color: D.white, marginBottom: 8 }}>Connect Gmail</div>
          <div style={{ fontSize: 14, color: D.muted, marginBottom: 24, lineHeight: 1.5 }}>
            Connect your contact@wavespestcontrol.com inbox to view, reply, and manage emails directly from the portal.
          </div>
          <a href="/api/admin/email/oauth/start" style={{
            display: 'inline-block', padding: '12px 32px', background: D.teal, color: D.white,
            borderRadius: 8, fontSize: 15, fontWeight: 600, textDecoration: 'none',
          }}>Connect Gmail Account</a>
        </div>
      </div>
    );
  }

  // Loading
  if (!status) {
    return <div style={{ padding: 40, color: D.muted }}>Loading...</div>;
  }

  const filters = [
    { key: 'all', label: 'All', count: stats?.total },
    { key: 'unread', label: 'Unread', count: stats?.unread },
    { key: 'starred', label: 'Starred', count: stats?.starred },
    { key: 'vendor', label: 'Vendor', count: stats?.vendor },
  ];

  return (
    <div style={{ padding: '24px 32px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 700, color: D.white }}>Email</div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>
            contact@wavespestcontrol.com
            {status?.lastSync && ` \u2014 synced ${timeAgo(status.lastSync)}`}
          </div>
        </div>
        <button onClick={handleSync} disabled={syncing} style={{
          padding: '8px 20px', background: D.teal, color: D.white, border: 'none', borderRadius: 8,
          fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: syncing ? 0.6 : 1,
        }}>{syncing ? 'Syncing...' : 'Sync Now'}</button>
      </div>

      {/* Stats bar */}
      {stats && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
          {[
            { label: 'Unread', value: stats.unread, color: stats.unread > 0 ? D.red : D.muted },
            { label: 'Today', value: stats.today, color: D.teal },
            { label: 'Vendor', value: stats.vendor, color: D.purple },
            { label: 'Total', value: stats.total, color: D.muted },
          ].map(s => (
            <div key={s.label} style={{ background: D.card, borderRadius: 8, padding: '12px 20px', border: `1px solid ${D.border}`, flex: 1 }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: s.color, fontFamily: "'JetBrains Mono', monospace" }}>{s.value}</div>
              <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        {filters.map(f => (
          <button key={f.key} onClick={() => { setFilter(f.key); setPage(1); }} style={{
            padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
            background: filter === f.key ? D.teal + '22' : 'transparent',
            color: filter === f.key ? D.teal : D.muted,
          }}>
            {f.label}{f.count != null ? ` (${f.count})` : ''}
          </button>
        ))}
        <button onClick={() => { setShowArchived(!showArchived); setPage(1); }} style={{
          padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
          background: showArchived ? D.amber + '22' : 'transparent',
          color: showArchived ? D.amber : D.muted,
        }}>
          {showArchived ? 'Archived' : 'Archived'}
        </button>
        <div style={{ flex: 1 }} />
        <input
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search emails..."
          style={{
            padding: '8px 14px', background: D.card, border: `1px solid ${D.border}`, borderRadius: 8,
            color: D.text, fontSize: 13, width: 240, outline: 'none',
          }}
        />
      </div>

      {/* Email list */}
      <div style={{ background: D.card, borderRadius: 12, border: `1px solid ${D.border}`, overflow: 'hidden' }}>
        {emails.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: D.muted, fontSize: 14 }}>No emails found</div>
        ) : emails.map(email => {
          const isSelected = selectedEmail?.id === email.id;
          const vendorData = email.classification === 'vendor' && email.extracted_data
            ? (typeof email.extracted_data === 'string' ? JSON.parse(email.extracted_data) : email.extracted_data)
            : null;

          return (
            <div key={email.id}>
              <div
                onClick={() => openEmail(email)}
                style={{
                  padding: '14px 20px', cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'flex-start',
                  borderBottom: `1px solid ${D.border}`,
                  background: isSelected ? D.teal + '11' : (email.is_read ? 'transparent' : D.bg + '88'),
                }}
              >
                {/* Star */}
                <span onClick={e => handleStar(e, email)} style={{ cursor: 'pointer', fontSize: 16, flexShrink: 0, marginTop: 2 }}>
                  {email.is_starred ? '\u2B50' : '\u2606'}
                </span>

                {/* Unread dot */}
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: email.is_read ? 'transparent' : D.teal, flexShrink: 0, marginTop: 7 }} />

                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                    <div style={{ fontSize: 13, fontWeight: email.is_read ? 400 : 700, color: email.is_read ? D.muted : D.white, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {email.from_name || email.from_address}
                    </div>
                    <div style={{ fontSize: 11, color: D.muted, flexShrink: 0, marginLeft: 8, fontFamily: "'JetBrains Mono', monospace" }}>
                      {timeAgo(email.received_at)}
                    </div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: email.is_read ? 400 : 600, color: email.is_read ? D.muted : D.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 2 }}>
                    {email.subject || '(no subject)'}
                    {email.has_attachments && ' \uD83D\uDCCE'}
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <div style={{ fontSize: 12, color: D.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {email.snippet}
                    </div>
                    {vendorData && (
                      <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: D.purple + '22', color: D.purple, fontWeight: 600, flexShrink: 0 }}>
                        {vendorData.vendor_name}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Expanded thread view */}
              {isSelected && (
                <div style={{ background: D.bg, borderBottom: `1px solid ${D.border}`, padding: '20px 24px' }}>
                  {/* Actions */}
                  <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                    {[
                      { label: 'Archive', icon: '\uD83D\uDCE5', action: () => handleArchive(email.id) },
                      { label: 'Trash', icon: '\uD83D\uDDD1\uFE0F', action: () => handleTrash(email.id) },
                    ].map(a => (
                      <button key={a.label} onClick={a.action} style={{
                        padding: '5px 12px', fontSize: 12, borderRadius: 6, border: `1px solid ${D.border}`,
                        background: 'transparent', color: D.muted, cursor: 'pointer',
                      }}>{a.icon} {a.label}</button>
                    ))}
                  </div>

                  {/* Thread messages */}
                  {thread.map((msg, i) => (
                    <div key={msg.id} style={{ marginBottom: 16, background: D.card, borderRadius: 8, padding: 16, border: `1px solid ${D.border}` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                        <div>
                          <span style={{ fontSize: 13, fontWeight: 600, color: D.white }}>{msg.from_name || msg.from_address}</span>
                          <span style={{ fontSize: 12, color: D.muted, marginLeft: 8 }}>&lt;{msg.from_address}&gt;</span>
                        </div>
                        <span style={{ fontSize: 11, color: D.muted, fontFamily: "'JetBrains Mono', monospace" }}>
                          {new Date(msg.received_at).toLocaleString()}
                        </span>
                      </div>
                      {msg.to_address && <div style={{ fontSize: 11, color: D.muted, marginBottom: 8 }}>To: {msg.to_address}</div>}
                      <div
                        style={{ fontSize: 13, color: D.text, lineHeight: 1.6, wordBreak: 'break-word' }}
                        dangerouslySetInnerHTML={{ __html: msg.body_html || (msg.body_text || '').replace(/\n/g, '<br>') }}
                      />
                      {msg.attachments?.length > 0 && (
                        <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {msg.attachments.map(att => (
                            <a
                              key={att.id}
                              href={`/api/admin/email/message/${msg.id}/attachment/${att.gmail_attachment_id}`}
                              target="_blank" rel="noopener noreferrer"
                              style={{
                                padding: '6px 12px', background: D.card, border: `1px solid ${D.border}`, borderRadius: 6,
                                fontSize: 12, color: D.teal, textDecoration: 'none',
                              }}
                            >
                              {'\uD83D\uDCCE'} {att.filename} ({Math.round((att.size_bytes || 0) / 1024)}KB)
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Reply box */}
                  <div style={{ background: D.card, borderRadius: 8, padding: 16, border: `1px solid ${D.border}` }}>
                    <div style={{ fontSize: 12, color: D.muted, marginBottom: 8 }}>Reply to {email.from_name || email.from_address}</div>
                    <textarea
                      value={replyText}
                      onChange={e => setReplyText(e.target.value)}
                      placeholder="Type your reply..."
                      rows={4}
                      style={{
                        width: '100%', padding: 12, background: D.bg, border: `1px solid ${D.border}`, borderRadius: 6,
                        color: D.text, fontSize: 13, resize: 'vertical', outline: 'none', fontFamily: "'DM Sans', sans-serif",
                        boxSizing: 'border-box',
                      }}
                    />
                    <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                      <button disabled style={{
                        padding: '8px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                        background: 'transparent', border: `1px solid ${D.border}`, color: D.muted, cursor: 'not-allowed',
                      }}>AI Draft (Session 2)</button>
                      <button onClick={handleReply} disabled={sending || !replyText.trim()} style={{
                        padding: '8px 20px', borderRadius: 6, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer',
                        background: D.teal, color: D.white, opacity: sending || !replyText.trim() ? 0.5 : 1,
                      }}>{sending ? 'Sending...' : 'Send Reply'}</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      {total > 50 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} style={{
            padding: '6px 14px', borderRadius: 6, fontSize: 12, border: `1px solid ${D.border}`,
            background: 'transparent', color: page === 1 ? D.muted : D.text, cursor: page === 1 ? 'default' : 'pointer',
          }}>Previous</button>
          <span style={{ padding: '6px 14px', fontSize: 12, color: D.muted }}>
            Page {page} of {Math.ceil(total / 50)}
          </span>
          <button onClick={() => setPage(p => p + 1)} disabled={page >= Math.ceil(total / 50)} style={{
            padding: '6px 14px', borderRadius: 6, fontSize: 12, border: `1px solid ${D.border}`,
            background: 'transparent', color: page >= Math.ceil(total / 50) ? D.muted : D.text, cursor: page >= Math.ceil(total / 50) ? 'default' : 'pointer',
          }}>Next</button>
        </div>
      )}
    </div>
  );
}
