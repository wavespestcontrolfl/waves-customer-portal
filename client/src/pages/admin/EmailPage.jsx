import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path.replace(/^\/api/, '')}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
}

// V2 token pass: teal/purple fold to zinc-900. Semantic green/amber/red preserved.
const D = {
  bg: '#F4F4F5', card: '#FFFFFF', border: '#E4E4E7',
  teal: '#18181B', green: '#15803D', amber: '#A16207',
  red: '#991B1B', purple: '#18181B',
  text: '#27272A', muted: '#71717A', white: '#FFFFFF',
  heading: '#09090B', inputBorder: '#D4D4D8',
};

const CATEGORY_COLORS = {
  lead_inquiry: D.green,
  customer_request: D.teal,
  complaint: D.red,
  vendor_invoice: D.purple,
  vendor_communication: D.purple,
  scheduling: D.amber,
  review_notification: D.amber,
  regulatory: D.red,
  marketing_newsletter: D.muted,
  internal: D.teal,
  spam: D.red,
  other: D.muted,
};

const CATEGORY_LABELS = {
  lead_inquiry: 'Lead',
  customer_request: 'Customer',
  complaint: 'Complaint',
  vendor_invoice: 'Invoice',
  vendor_communication: 'Vendor',
  scheduling: 'Scheduling',
  review_notification: 'Review',
  regulatory: 'Regulatory',
  marketing_newsletter: 'Newsletter',
  internal: 'Internal',
  spam: 'Spam',
  other: 'Other',
};

const AUTO_ACTION_LABELS = {
  lead_inquiry: 'Lead created',
  spam: 'Blocked & trashed',
  marketing_newsletter: 'Unsubscribed',
  vendor_invoice: 'Expense logged',
  complaint: 'Flagged urgent',
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
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [digest, setDigest] = useState(null);
  const [tab, setTab] = useState('inbox'); // inbox | blocked
  const [blocked, setBlocked] = useState([]);
  const [blockInput, setBlockInput] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftResult, setDraftResult] = useState(null);

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

  const loadDigest = useCallback(async () => {
    try {
      const r = await adminFetch('/api/admin/email/daily-digest');
      const d = await r.json();
      setDigest(d);
    } catch { /* ignore */ }
  }, []);

  const loadEmails = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page, limit: 50, is_archived: showArchived });
      if (filter === 'unread') params.set('category', 'unread');
      else if (filter === 'starred') params.set('category', 'starred');
      else if (filter === 'vendor') params.set('category', 'vendor');
      else if (filter === 'leads') params.set('category', 'leads');
      else if (filter === 'invoices') params.set('category', 'invoices');
      else if (filter === 'customer') params.set('category', 'customer');
      else if (filter === 'complaints') params.set('category', 'complaints');
      if (search) params.set('search', search);

      const r = await adminFetch(`/api/admin/email/inbox?${params}`);
      const d = await r.json();
      setEmails(d.emails || []);
      setTotal(d.total || 0);
    } catch { /* ignore */ }
  }, [filter, search, page, showArchived]);

  const loadBlocked = useCallback(async () => {
    try {
      const r = await adminFetch('/api/admin/email/blocked');
      const d = await r.json();
      setBlocked(d.blocked || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => {
    if (status?.connected) { loadStats(); loadEmails(); loadDigest(); }
  }, [status, loadStats, loadEmails, loadDigest]);

  const openEmail = async (email) => {
    setSelectedEmail(email);
    setReplyText('');
    try {
      if (!email.is_read) {
        await adminFetch(`/api/admin/email/message/${email.id}/read`, { method: 'POST' });
        setEmails(prev => prev.map(e => e.id === email.id ? { ...e, is_read: true } : e));
        loadStats();
      }
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

  const handleReclassify = async (emailId) => {
    try {
      const r = await adminFetch(`/api/admin/email/message/${emailId}/reclassify`, { method: 'POST' });
      const d = await r.json();
      setEmails(prev => prev.map(e => e.id === emailId
        ? { ...e, classification: d.classification?.category, extracted_data: d.classification }
        : e
      ));
    } catch { /* ignore */ }
  };

  const handleReply = async () => {
    if (!replyText.trim() || !selectedEmail) return;
    setSending(true);
    try {
      await adminFetch('/api/admin/email/send', {
        method: 'POST',
        body: JSON.stringify({
          to: selectedEmail.from_address,
          subject: `Re: ${selectedEmail.subject || ''}`,
          body: replyText.replace(/\n/g, '<br>'),
          threadId: selectedEmail.gmail_thread_id,
        }),
      });
      setReplyText('');
      const r = await adminFetch(`/api/admin/email/thread/${selectedEmail.gmail_thread_id}`);
      const d = await r.json();
      setThread(d.thread || []);
    } catch { /* ignore */ }
    setSending(false);
  };

  const handleAiDraft = async () => {
    if (!selectedEmail) return;
    setDrafting(true);
    setDraftResult(null);
    try {
      const r = await adminFetch(`/api/admin/email/message/${selectedEmail.id}/ai-draft`, { method: 'POST' });
      const d = await r.json();
      if (d.reply_draft) {
        setReplyText(d.reply_draft);
        setDraftResult(d);
      }
    } catch { /* ignore */ }
    setDrafting(false);
  };

  const handleReplyViaSms = async () => {
    if (!selectedEmail) return;
    const smsBody = prompt(`SMS to ${selectedEmail.from_name || selectedEmail.from_address}:`);
    if (!smsBody) return;
    try {
      await adminFetch('/api/admin/email/send', {
        method: 'POST',
        body: JSON.stringify({
          to: selectedEmail.from_address,
          subject: `Re: ${selectedEmail.subject || ''}`,
          body: `[Replied via SMS instead]`,
          threadId: selectedEmail.gmail_thread_id,
        }),
      });
    } catch { /* non-critical — the SMS is what matters */ }
    // The actual SMS goes through the Intelligence Bar tool
    // This button pre-fills a quick path for Virginia
  };

  const handleBlock = async () => {
    if (!blockInput.trim()) return;
    try {
      const isEmail = blockInput.includes('@');
      await adminFetch('/api/admin/email/block', {
        method: 'POST',
        body: JSON.stringify({
          email_address: isEmail ? blockInput.trim() : null,
          domain: isEmail ? null : blockInput.trim(),
          reason: 'Manual block from admin portal',
        }),
      });
      setBlockInput('');
      loadBlocked();
    } catch { /* ignore */ }
  };

  const handleUnblock = async (id) => {
    try {
      await adminFetch(`/api/admin/email/blocked/${id}`, { method: 'DELETE' });
      setBlocked(prev => prev.filter(b => b.id !== id));
    } catch { /* ignore */ }
  };

  // Not connected — show connect card
  if (status && !status.connected) {
    return (
      <div style={{ padding: 32 }}>
        <h1 style={{ fontSize: 28, fontWeight: 400, letterSpacing: '-0.015em', color: D.heading, margin: '0 0 24px' }}>
          <span className="md:hidden" style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.1 }}>Email</span>
          <span className="hidden md:inline">Email</span>
        </h1>
        <div style={{ background: D.card, borderRadius: 12, padding: 40, textAlign: 'center', border: `1px solid ${D.border}`, maxWidth: 480, margin: '60px auto' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📧</div>
          <div style={{ fontSize: 20, fontWeight: 600, color: D.heading, marginBottom: 8 }}>Connect Gmail</div>
          <div style={{ fontSize: 14, color: D.muted, marginBottom: 24, lineHeight: 1.5 }}>
            Connect your contact@wavespestcontrol.com inbox to view, reply, and manage emails directly from the portal.
          </div>
          <a href="/api/admin/email/oauth/start" style={{
            display: 'inline-block', padding: '12px 32px', background: D.teal, color: '#fff',
            borderRadius: 8, fontSize: 15, fontWeight: 600, textDecoration: 'none',
          }}>Connect Gmail Account</a>
        </div>
      </div>
    );
  }

  if (!status) {
    return <div style={{ padding: 40, color: D.muted }}>Loading...</div>;
  }

  const filters = [
    { key: 'all', label: 'All', count: stats?.total },
    { key: 'unread', label: 'Unread', count: stats?.unread },
    { key: 'starred', label: 'Starred', count: stats?.starred },
    { key: 'leads', label: 'Leads', color: D.green },
    { key: 'invoices', label: 'Invoices', color: D.purple },
    { key: 'customer', label: 'Customer', color: D.teal },
    { key: 'complaints', label: 'Complaints', color: D.red },
    { key: 'vendor', label: 'Vendor', count: stats?.vendor },
  ];

  return (
    <div style={{ padding: '24px 32px' }}>
      {/* Header — mailbox subtitle + last-sync timestamp + Sync Now
          button all removed. The page tab itself labels the surface,
          and scheduler.js syncs Gmail → PostgreSQL every 2 min so a
          "synced just now" chip carried no real signal. */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 28, fontWeight: 400, color: D.heading, margin: 0 }}>Email</h1>
      </div>

      {/* Daily digest card */}
      {digest && digest.total_received > 0 && (
        <div style={{ background: D.card, borderRadius: 10, padding: '14px 20px', border: `1px solid ${D.border}`, marginBottom: 16, display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>Today</div>
          <div style={{ fontSize: 12, color: D.muted }}>
            <span style={{ color: D.text, fontFamily: "'JetBrains Mono', monospace" }}>{digest.total_received}</span> received
          </div>
          {digest.leads_created > 0 && (
            <div style={{ fontSize: 12, color: D.green }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{digest.leads_created}</span> leads created
            </div>
          )}
          {digest.spam_blocked > 0 && (
            <div style={{ fontSize: 12, color: D.red }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{digest.spam_blocked}</span> spam blocked
            </div>
          )}
          {digest.invoices_processed > 0 && (
            <div style={{ fontSize: 12, color: D.purple }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{digest.invoices_processed}</span> invoices
            </div>
          )}
          {digest.domains_blocked_today > 0 && (
            <div style={{ fontSize: 12, color: D.amber }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{digest.domains_blocked_today}</span> domains blocked
            </div>
          )}
        </div>
      )}

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

      {/* Tab toggle: Inbox | Blocked Senders */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, background: D.card, borderRadius: 8, padding: 3, width: 'fit-content', border: `1px solid ${D.border}` }}>
        {[
          { key: 'inbox', label: 'Inbox' },
          { key: 'blocked', label: 'Blocked Senders' },
        ].map(t => (
          <button key={t.key} onClick={() => { setTab(t.key); if (t.key === 'blocked') loadBlocked(); }} style={{
            padding: '7px 18px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
            background: tab === t.key ? D.teal : 'transparent',
            color: tab === t.key ? D.white : D.muted,
          }}>{t.label}</button>
        ))}
      </div>

      {/* BLOCKED SENDERS TAB */}
      {tab === 'blocked' && (
        <div>
          {/* Block input */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            <input
              value={blockInput}
              onChange={e => setBlockInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleBlock()}
              placeholder="Block domain or email (e.g. spammer.com or bad@example.com)"
              style={{
                flex: 1, padding: '10px 14px', background: D.card, border: `1px solid ${D.border}`, borderRadius: 8,
                color: D.text, fontSize: 13, outline: 'none',
              }}
            />
            <button onClick={handleBlock} style={{
              padding: '10px 20px', background: D.red, color: '#fff', border: 'none', borderRadius: 8,
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}>Block</button>
          </div>

          {/* Blocked list */}
          <div style={{ background: D.card, borderRadius: 12, border: `1px solid ${D.border}`, overflow: 'hidden' }}>
            {blocked.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: D.muted, fontSize: 14 }}>No blocked senders</div>
            ) : blocked.map(b => (
              <div key={b.id} style={{ padding: '12px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: `1px solid ${D.border}` }}>
                <div>
                  <div style={{ fontSize: 13, color: D.heading, fontWeight: 600 }}>
                    {b.domain || b.email_address}
                  </div>
                  <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>
                    {b.reason} {b.blocked_count > 0 && `\u2014 ${b.blocked_count} emails caught`}
                    <span style={{ marginLeft: 8 }}>{timeAgo(b.created_at)}</span>
                  </div>
                </div>
                <button onClick={() => handleUnblock(b.id)} style={{
                  padding: '5px 14px', fontSize: 11, borderRadius: 6, border: `1px solid ${D.border}`,
                  background: 'transparent', color: D.muted, cursor: 'pointer',
                }}>Unblock</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* INBOX TAB */}
      {tab === 'inbox' && (
        <>
          {/* Filter bar */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            {filters.map(f => (
              <button key={f.key} onClick={() => { setFilter(f.key); setPage(1); }} style={{
                padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
                background: filter === f.key ? (f.color || D.teal) + '22' : 'transparent',
                color: filter === f.key ? (f.color || D.teal) : D.muted,
              }}>
                {f.label}{f.count != null ? ` (${f.count})` : ''}
              </button>
            ))}
            <button onClick={() => { setShowArchived(!showArchived); setPage(1); }} style={{
              padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
              background: showArchived ? D.amber + '22' : 'transparent',
              color: showArchived ? D.amber : D.muted,
            }}>Archived</button>
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
              const extractedData = email.extracted_data
                ? (typeof email.extracted_data === 'string' ? JSON.parse(email.extracted_data) : email.extracted_data)
                : null;
              const category = email.classification;
              const categoryColor = CATEGORY_COLORS[category];
              const categoryLabel = CATEGORY_LABELS[category];
              const autoActionLabel = AUTO_ACTION_LABELS[category];

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
                        <div style={{ fontSize: 13, fontWeight: email.is_read ? 400 : 700, color: email.is_read ? D.muted : D.heading, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {email.from_name || email.from_address}
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, marginLeft: 8 }}>
                          {/* Category badge */}
                          {categoryLabel && (
                            <span style={{
                              fontSize: 10, padding: '2px 8px', borderRadius: 4,
                              background: categoryColor + '22', color: categoryColor, fontWeight: 600,
                            }}>{categoryLabel}</span>
                          )}
                          <span style={{ fontSize: 11, color: D.muted, fontFamily: "'JetBrains Mono', monospace" }}>
                            {timeAgo(email.received_at)}
                          </span>
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
                        {extractedData?.vendor_name && (
                          <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: D.purple + '22', color: D.purple, fontWeight: 600, flexShrink: 0 }}>
                            {extractedData.vendor_name}
                          </span>
                        )}
                      </div>
                      {/* Auto-action indicator */}
                      {autoActionLabel && (
                        <div style={{ fontSize: 11, color: categoryColor, marginTop: 4, opacity: 0.8 }}>
                          {'\u2713'} {autoActionLabel}
                        </div>
                      )}
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
                          { label: 'Reclassify', icon: '\uD83E\uDD16', action: () => handleReclassify(email.id) },
                        ].map(a => (
                          <button key={a.label} onClick={a.action} style={{
                            padding: '5px 12px', fontSize: 12, borderRadius: 6, border: `1px solid ${D.border}`,
                            background: 'transparent', color: D.muted, cursor: 'pointer',
                          }}>{a.icon} {a.label}</button>
                        ))}
                      </div>

                      {/* Classification detail */}
                      {extractedData && (
                        <div style={{ background: D.card, borderRadius: 8, padding: '10px 14px', border: `1px solid ${D.border}`, marginBottom: 16, fontSize: 12 }}>
                          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                            <span style={{ color: D.muted }}>AI classification:</span>
                            <span style={{ color: categoryColor, fontWeight: 600 }}>{categoryLabel || category}</span>
                            {extractedData.urgency && (
                              <span style={{ color: extractedData.urgency === 'high' ? D.red : D.amber }}>
                                Urgency: {extractedData.urgency}
                              </span>
                            )}
                            {extractedData.person_name && (
                              <span style={{ color: D.text }}>{extractedData.person_name}</span>
                            )}
                            {extractedData.phone && (
                              <span style={{ color: D.text, fontFamily: "'JetBrains Mono', monospace" }}>{extractedData.phone}</span>
                            )}
                            {extractedData.service_interest && (
                              <span style={{ color: D.green }}>{extractedData.service_interest}</span>
                            )}
                            {extractedData.invoice_amount && (
                              <span style={{ color: D.purple, fontFamily: "'JetBrains Mono', monospace" }}>${extractedData.invoice_amount}</span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Thread messages */}
                      {thread.map((msg) => (
                        <div key={msg.id} style={{ marginBottom: 16, background: D.card, borderRadius: 8, padding: 16, border: `1px solid ${D.border}` }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                            <div>
                              <span style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{msg.from_name || msg.from_address}</span>
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
                        {draftResult && (
                        <div style={{ fontSize: 11, color: D.green, marginTop: 4, marginBottom: 4 }}>
                          {'\u2713'} AI draft loaded — review and edit before sending
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                          <button onClick={handleAiDraft} disabled={drafting} style={{
                            padding: '8px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                            background: D.purple + '22', border: `1px solid ${D.purple}44`, color: D.purple,
                            opacity: drafting ? 0.5 : 1,
                          }}>{drafting ? 'Drafting...' : '\u2728 AI Draft'}</button>
                          <button onClick={handleReplyViaSms} style={{
                            padding: '8px 16px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                            background: 'transparent', border: `1px solid ${D.border}`, color: D.muted,
                          }}>{'\uD83D\uDCAC'} Reply via SMS</button>
                          <button onClick={handleReply} disabled={sending || !replyText.trim()} style={{
                            padding: '8px 20px', borderRadius: 6, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer',
                            background: D.teal, color: '#fff', opacity: sending || !replyText.trim() ? 0.5 : 1,
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
        </>
      )}
    </div>
  );
}
