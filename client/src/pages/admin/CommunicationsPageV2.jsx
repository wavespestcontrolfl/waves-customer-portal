// client/src/pages/admin/CommunicationsPageV2.jsx
// Monochrome V2 of CommunicationsPage. Strict 1:1 on endpoints, payloads,
// state shape, threading logic, unread tracking, and AI-draft flow.
//
// Endpoints preserved:
//   GET  /admin/communications/log[?search=...]
//   GET  /admin/communications/stats
//   POST /admin/communications/sms
//   GET  /admin/communications/ai-auto-reply-status
//   POST /admin/communications/ai-auto-reply
//   POST /admin/communications/ai-draft
//   GET  /admin/customers?search=...
//
// Scope: Full V2 redesign of all tabs. CallLogTabV2, SmsTemplatesTabV2,
// CSRCoachTabV2, EmailAutomationsPanelV2, and PushSettingsV2 each render
// behind the comms-v2 flag. V1 CommunicationsPage still uses the V1 inline
// tabs and V1 separate panels.
import React, {
  useState, useEffect, useCallback, useMemo,
} from 'react';
import {
  ALL_NUMBERS,
  NUMBER_LABEL_MAP,
} from './CommunicationsPage';
import CallLogTabV2 from './CallLogTabV2';
import { SmsTemplatesTabV2, CSRCoachTabV2 } from './CommunicationsTabsV2';
import EmailAutomationsPanelV2 from './EmailAutomationsPanelV2';
import NewsletterTabV2 from './NewsletterTabV2';
import PushSettingsV2 from '../../components/admin/PushSettingsV2';
import { Badge, Button, Card, cn } from '../../components/ui';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
    },
    ...options,
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const mins = Math.floor((Date.now() - d) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

function formatTimestamp(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (isToday) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (isYesterday) return 'Yesterday ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const TABS = [
  { key: 'sms', label: 'SMS' },
  { key: 'calls', label: 'Calls' },
  { key: 'templates', label: 'Templates', desktopOnly: true },
  { key: 'email', label: 'Email', desktopOnly: true },
  { key: 'csr', label: 'CSR Coach', desktopOnly: true },
  { key: 'notifications', label: 'Notifications', desktopOnly: true },
];

// ── V2 helpers ────────────────────────────────────────────────

function StatCardV2({ label, value, sub, active, alert, onClick }) {
  const clickable = typeof onClick === 'function';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={cn(
        'flex-1 min-w-[140px] bg-white border-hairline rounded-md p-3.5 text-left',
        'transition-colors',
        clickable && 'hover:bg-zinc-50 cursor-pointer',
        active ? 'border-zinc-900' : 'border-zinc-200',
        !clickable && 'cursor-default',
      )}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-11 uppercase tracking-label text-ink-tertiary">
          {label}
        </span>
      </div>
      <div
        className={cn(
          'text-22 font-medium u-nums',
          alert ? 'text-alert-fg' : 'text-zinc-900',
        )}
      >
        {value}
      </div>
      {sub && <div className="text-11 text-ink-tertiary mt-0.5">{sub}</div>}
    </button>
  );
}

function StatusBadgeV2({ status }) {
  if (!status) return null;
  const strong = status === 'delivered' || status === 'received';
  const alert = status === 'failed';
  return (
    <Badge tone={alert ? 'alert' : strong ? 'strong' : 'neutral'}>
      {status}
    </Badge>
  );
}

function TypeBadgeV2({ type }) {
  if (!type) return null;
  return <Badge tone="neutral">{type.replace(/_/g, ' ')}</Badge>;
}

function SmsLogItemV2({ msg: m, onReply }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = m.body && m.body.length > 80;
  return (
    <div
      className="py-2.5 border-b border-hairline border-zinc-200 cursor-pointer"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            'text-14 leading-5 flex-shrink-0 w-5 text-center',
            m.direction === 'outbound' ? 'text-zinc-900' : 'text-ink-secondary',
          )}
          aria-hidden
        >
          {m.direction === 'outbound' ? '↑' : '↓'}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            <span className="font-mono text-12 text-ink-secondary u-nums">
              {m.from} → {m.to}
            </span>
            {m.customerName && (
              <span className="text-11 text-zinc-900">({m.customerName})</span>
            )}
          </div>
          <div
            className={cn(
              'text-13 leading-normal break-words',
              expanded ? 'whitespace-pre-wrap text-zinc-900' : 'text-ink-secondary',
            )}
          >
            {expanded ? m.body : isLong ? m.body.slice(0, 80) + '…' : m.body}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <div className="flex gap-1">
            <StatusBadgeV2 status={m.status} />
            <TypeBadgeV2 type={m.messageType} />
          </div>
          <span className="font-mono text-11 text-ink-tertiary">
            {timeAgo(m.createdAt)}
          </span>
        </div>
      </div>
      {expanded && (
        <div className="mt-2 ml-7 flex gap-2">
          {m.direction === 'inbound' && (
            <Button
              size="sm"
              variant="primary"
              onClick={(e) => { e.stopPropagation(); onReply(m.from, m.to); }}
            >
              Reply
            </Button>
          )}
          {m.direction === 'outbound' && (
            <Button
              size="sm"
              variant="primary"
              onClick={(e) => { e.stopPropagation(); onReply(m.to, m.from); }}
            >
              Send Again
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={(e) => {
              e.stopPropagation();
              navigator.clipboard.writeText(m.body || '');
            }}
          >
            Copy
          </Button>
        </div>
      )}
    </div>
  );
}

function ConversationViewV2({ thread, messages, onReply, onBack }) {
  const contactPhone = thread.contactPhone;
  const contactName = thread.customerName || contactPhone;
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 mb-4 pb-3 border-b border-hairline border-zinc-200">
        <Button size="sm" variant="secondary" onClick={onBack}>Back</Button>
        <div className="flex-1 min-w-0">
          <div className="text-14 font-medium text-zinc-900 truncate">{contactName}</div>
          <div className="font-mono text-12 text-ink-secondary">{contactPhone}</div>
        </div>
        <Button
          size="sm"
          variant="primary"
          onClick={() => onReply(contactPhone, thread.ourNumber)}
        >
          Reply
        </Button>
      </div>
      <div className="flex-1 max-h-[500px] overflow-y-auto flex flex-col gap-2">
        {messages.map((m) => {
          const isOut = m.direction === 'outbound';
          return (
            <div
              key={m.id}
              className={cn('flex', isOut ? 'justify-end' : 'justify-start')}
            >
              <div
                className={cn(
                  'max-w-[75%] px-3.5 py-2.5 rounded-md border-hairline',
                  isOut
                    ? 'bg-zinc-900 text-white border-zinc-900 rounded-br-xs'
                    : 'bg-zinc-50 text-zinc-900 border-zinc-200 rounded-bl-xs',
                )}
              >
                <div className="text-13 leading-normal whitespace-pre-wrap break-words">
                  {m.body}
                </div>
                <div
                  className={cn(
                    'flex items-center gap-1.5 mt-1',
                    isOut ? 'justify-end' : 'justify-start',
                  )}
                >
                  <span
                    className={cn(
                      'text-11',
                      isOut ? 'text-white/70' : 'text-ink-tertiary',
                    )}
                  >
                    {formatTimestamp(m.createdAt)}
                  </span>
                  {m.messageType && (
                    <span
                      className={cn(
                        'text-11 uppercase tracking-label',
                        isOut ? 'text-white/70' : 'text-ink-tertiary',
                      )}
                    >
                      {m.messageType.replace(/_/g, ' ')}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── SMS tab ───────────────────────────────────────────────────

function SmsTab() {
  const [messages, setMessages] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [smsFilter, setSmsFilter] = useState('all');

  const [aiAutoReply, setAiAutoReply] = useState(false);
  const [togglingAi, setTogglingAi] = useState(false);

  // Compose
  const [toNumber, setToNumber] = useState('');
  const [toSearch, setToSearch] = useState('');
  const [toResults, setToResults] = useState([]);
  const [fromNumber, setFromNumber] = useState('+19413187612');
  const [msgBody, setMsgBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState(null);
  const [aiDrafting, setAiDrafting] = useState(false);

  // Filters
  const [dirFilter, setDirFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');

  // Threading
  const [smsView, setSmsView] = useState('threads');
  const [activeThread, setActiveThread] = useState(null);
  const [threadReadAt, setThreadReadAt] = useState(() => {
    try {
      const raw = localStorage.getItem('waves_sms_thread_read_at');
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const [smsSearch, setSmsSearch] = useState('');
  // PR 4 — status filter chips, reply-from lock.
  const [statusFilter, setStatusFilter] = useState('all');
  const [threadLock, setThreadLock] = useState(null);

  const loadData = useCallback((search = '') => {
    const logUrl = search
      ? `/admin/communications/log?search=${encodeURIComponent(search)}&limit=1000`
      : '/admin/communications/log';
    Promise.all([
      adminFetch(logUrl).catch(() => ({ messages: [] })),
      adminFetch('/admin/communications/stats').catch(() => null),
    ]).then(([logData, statsData]) => {
      setMessages(logData.messages || []);
      setStats(statsData);
      setLoading(false);
    });
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const t = setTimeout(() => { loadData(smsSearch.trim()); }, 300);
    return () => clearTimeout(t);
  }, [smsSearch, loadData]);

  useEffect(() => {
    adminFetch('/admin/communications/ai-auto-reply-status')
      .then((d) => setAiAutoReply(d.enabled))
      .catch(() => {});
  }, []);

  const toggleAiAutoReply = async () => {
    setTogglingAi(true);
    try {
      const r = await adminFetch('/admin/communications/ai-auto-reply', {
        method: 'POST',
        body: JSON.stringify({ enabled: !aiAutoReply }),
      });
      setAiAutoReply(r.enabled);
    } catch { /* ignore */ }
    setTogglingAi(false);
  };

  const handleSend = async () => {
    if (!toNumber.trim() || !msgBody.trim()) return;
    setSending(true);
    setSendResult(null);
    try {
      await adminFetch('/admin/communications/sms', {
        method: 'POST',
        body: JSON.stringify({
          to: toNumber.trim(),
          body: msgBody.trim(),
          messageType: 'manual',
          fromNumber,
        }),
      });
      setSendResult({ ok: true, text: 'Message sent.' });
      setToNumber('');
      setMsgBody('');
      loadData();
    } catch (e) {
      setSendResult({ ok: false, text: `Failed: ${e.message}` });
    } finally {
      setSending(false);
    }
  };

  const handleAiDraft = async () => {
    if (!toNumber.trim()) { alert('Enter a To number first'); return; }
    setAiDrafting(true);
    try {
      const lastMsg = messages.find(
        (m) =>
          m.direction === 'inbound' &&
          (m.from === toNumber.trim() ||
            m.from?.includes(
              toNumber.trim().replace(/\D/g, '').slice(-10),
            )),
      );
      const d = await adminFetch('/admin/communications/ai-draft', {
        method: 'POST',
        body: JSON.stringify({
          customerPhone: toNumber.trim(),
          lastMessage: lastMsg?.body || '',
        }),
      });
      if (d.draft) setMsgBody(d.draft.slice(0, 160));
    } catch (e) {
      alert('AI draft failed: ' + e.message);
    } finally {
      setAiDrafting(false);
    }
  };

  const threads = useMemo(() => {
    const threadMap = {};
    const sorted = [...messages].sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
    );
    const allNums = new Set();
    ALL_NUMBERS.forEach((g) => g.numbers.forEach((n) => allNums.add(n.number)));
    sorted.forEach((m) => {
      let contactPhone, ourNumber;
      if (m.direction === 'inbound') {
        contactPhone = m.from; ourNumber = m.to;
      } else {
        contactPhone = m.to; ourNumber = m.from;
      }
      const key = contactPhone?.replace(/\D/g, '').slice(-10) || 'unknown';
      if (!threadMap[key]) {
        threadMap[key] = {
          contactPhone,
          ourNumber,
          customerName: m.customerName || null,
          messages: [],
          lastMessage: null,
          lastTimestamp: null,
          lastDirection: null,
          unread: false,
        };
      }
      const thread = threadMap[key];
      thread.messages.push(m);
      if (m.customerName) thread.customerName = m.customerName;
      if (ourNumber && allNums.has(ourNumber)) thread.ourNumber = ourNumber;
      thread.lastMessage = m.body;
      thread.lastTimestamp = m.createdAt;
      thread.lastDirection = m.direction;
    });
    const threadList = Object.values(threadMap).map((t) => {
      t.messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      t.unanswered = t.lastDirection === 'inbound';
      return t;
    });
    threadList.sort((a, b) => new Date(b.lastTimestamp) - new Date(a.lastTimestamp));
    return threadList;
  }, [messages]);

  const phoneLast10 = (p) => (p || '').replace(/\D/g, '').slice(-10);

  const filteredThreads = threads.filter((t) => {
    // PR 4 — status filter chips (stacked on top of message-type smsFilter).
    if (statusFilter !== 'all') {
      const key = phoneLast10(t.contactPhone);
      const lastReadAt = threadReadAt[key];
      const hasUnseen = t.unanswered && (!lastReadAt || new Date(t.lastTimestamp) > new Date(lastReadAt));
      if (statusFilter === 'unread' && !hasUnseen) return false;
      if (statusFilter === 'unanswered' && !t.unanswered) return false;
      if (statusFilter === 'unknown' && t.customerName) return false;
    }
    if (smsFilter === 'all') return true;
    if (smsFilter === 'sent') return t.messages.some((m) => m.direction === 'outbound');
    if (smsFilter === 'received') return t.messages.some((m) => m.direction === 'inbound');
    if (smsFilter === 'auto_reply')
      return t.messages.some((m) => m.messageType === 'auto_reply' || m.messageType === 'ai_draft');
    if (smsFilter === 'reminder')
      return t.messages.some((m) =>
        ['reminder', 'confirmation', 'appointment_confirmation'].includes(m.messageType),
      );
    if (smsFilter === 'review_request')
      return t.messages.some((m) => m.messageType === 'review_request');
    if (smsFilter === 'estimate')
      return t.messages.some((m) => m.messageType === 'estimate');
    return true;
  });

  const chipCounts = useMemo(() => {
    let unread = 0, unanswered = 0, unknown = 0;
    threads.forEach((t) => {
      const key = phoneLast10(t.contactPhone);
      const lastReadAt = threadReadAt[key];
      if (t.unanswered && (!lastReadAt || new Date(t.lastTimestamp) > new Date(lastReadAt))) unread++;
      if (t.unanswered) unanswered++;
      if (!t.customerName) unknown++;
    });
    return { all: threads.length, unread, unanswered, unknown };
  }, [threads, threadReadAt]);

  const handleThreadReply = (contactPhone, ourNumber) => {
    setToNumber(contactPhone);
    if (ourNumber) {
      setFromNumber(ourNumber);
      setThreadLock({ contactPhone, ourNumber, label: NUMBER_LABEL_MAP[ourNumber] || ourNumber });
    }
    setSmsView('threads');
    setActiveThread(null);
    setTimeout(() => {
      const el = document.getElementById('sms-compose-v2');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  };

  const totalSent = stats?.totalSent
    || stats?.channelStats?.reduce((s, c) => s + (c.sent || 0), 0)
    || 0;
  const totalReceived = stats?.totalReceived
    || stats?.locationStats?.reduce((s, l) => s + (l.received || 0), 0)
    || 0;
  const channelStats = stats?.channelStats || [];
  const messageTypes = [...new Set(messages.map((m) => m.messageType).filter(Boolean))];

  const filtered = messages.filter((m) => {
    if (dirFilter === 'inbound' && m.direction !== 'inbound') return false;
    if (dirFilter === 'outbound' && m.direction !== 'outbound') return false;
    if (typeFilter !== 'all' && m.messageType !== typeFilter) return false;
    return true;
  });

  if (loading) {
    return (
      <div className="p-10 text-center text-13 text-ink-secondary">
        Loading communications…
      </div>
    );
  }

  return (
    <div>
      {/* Stats + auto-reply */}
      <div className="hidden md:flex items-center gap-2 mb-4 flex-wrap">
        <StatCardV2
          label="Sent This Month"
          value={totalSent}
          active={smsFilter === 'sent'}
          onClick={() => setSmsFilter((f) => (f === 'sent' ? 'all' : 'sent'))}
        />
        <StatCardV2
          label="Received This Month"
          value={totalReceived}
          active={smsFilter === 'received'}
          onClick={() => setSmsFilter((f) => (f === 'received' ? 'all' : 'received'))}
        />
        <StatCardV2
          label="Auto-Replies"
          value={channelStats.find((c) => c.type === 'auto_reply')?.sent || 0}
          active={smsFilter === 'auto_reply'}
          alert={(channelStats.find((c) => c.type === 'auto_reply')?.sent || 0) === 0}
          onClick={() => setSmsFilter((f) => (f === 'auto_reply' ? 'all' : 'auto_reply'))}
        />
        <StatCardV2
          label="Reminders"
          value={
            channelStats.find((c) => c.type === 'reminder')?.sent
            || channelStats.find((c) => c.type === 'confirmation')?.sent
            || 0
          }
          active={smsFilter === 'reminder'}
          onClick={() => setSmsFilter((f) => (f === 'reminder' ? 'all' : 'reminder'))}
        />
        <StatCardV2
          label="Review Requests"
          value={channelStats.find((c) => c.type === 'review_request')?.sent || 0}
          active={smsFilter === 'review_request'}
          onClick={() => setSmsFilter((f) => (f === 'review_request' ? 'all' : 'review_request'))}
        />
        <StatCardV2
          label="Estimates"
          value={channelStats.find((c) => c.type === 'estimate')?.sent || 0}
          active={smsFilter === 'estimate'}
          onClick={() => setSmsFilter((f) => (f === 'estimate' ? 'all' : 'estimate'))}
        />
      </div>

      {/* Compose */}
      <Card id="sms-compose-v2" className="p-5 mb-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="text-14 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-secondary">
            Send SMS
          </div>
          <button
            type="button"
            onClick={toggleAiAutoReply}
            disabled={togglingAi}
            aria-pressed={aiAutoReply}
            className="flex items-center gap-2 min-h-[44px] md:min-h-0 px-1 md:px-0 u-focus-ring"
          >
            <span className="text-13 md:text-11 text-ink-secondary">AI Auto-Reply</span>
            <span
              className={cn(
                'h-6 w-10 rounded-full border-hairline transition-colors relative',
                aiAutoReply ? 'bg-zinc-900 border-zinc-900' : 'bg-white border-zinc-300',
              )}
            >
              <span
                className={cn(
                  'absolute top-0.5 h-4 w-4 rounded-full transition-all',
                  aiAutoReply ? 'left-5 bg-white' : 'left-0.5 bg-zinc-400',
                )}
              />
            </span>
          </button>
        </div>

        {/* PR 4 — thread-reply lock banner */}
        {threadLock && (
          <div className="flex items-center gap-2 px-3 py-2 bg-zinc-50 border-hairline border-zinc-900 rounded-sm mb-3">
            <Badge tone="strong">Locked</Badge>
            <span className="text-12 text-zinc-900 flex-1">
              Replying from <strong>{threadLock.label}</strong> to continue thread with {threadLock.contactPhone}
            </span>
            <button
              type="button"
              onClick={() => setThreadLock(null)}
              className="text-13 md:text-11 min-h-[44px] md:min-h-0 inline-flex items-center px-2 text-ink-secondary underline hover:text-zinc-900 u-focus-ring"
            >Override</button>
          </div>
        )}

        <label className="block text-13 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-secondary mb-1">
          From{threadLock && ' (locked to thread)'}
        </label>
        <select
          value={fromNumber}
          onChange={(e) => setFromNumber(e.target.value)}
          disabled={!!threadLock}
          className={cn(
            'w-full bg-white border-hairline rounded-sm py-2 px-3 text-16 md:text-13 text-zinc-900 mb-3 min-h-[44px] md:min-h-0',
            'focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900',
            threadLock ? 'border-zinc-900 opacity-60 cursor-not-allowed' : 'border-zinc-300',
          )}
        >
          {ALL_NUMBERS.map((group) => (
            <optgroup key={group.group} label={group.group}>
              {group.numbers.map((n) => (
                <option key={n.number} value={n.number}>
                  {n.formatted} — {n.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        <label className="block text-13 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-secondary mb-1">To</label>
        <input
          type="text"
          placeholder="Search by name or enter phone number…"
          value={toSearch || toNumber}
          onChange={async (e) => {
            const val = e.target.value;
            if (/^[\d\s()\-+]+$/.test(val)) {
              setToNumber(val);
              setToSearch('');
              setToResults([]);
            } else {
              setToSearch(val);
              setToNumber('');
              if (val.length >= 2) {
                try {
                  const r = await fetch(
                    `${API_BASE}/admin/customers?search=${encodeURIComponent(val)}&limit=8`,
                    { headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` } },
                  );
                  if (r.ok) {
                    const d = await r.json();
                    setToResults(d.customers || []);
                  }
                } catch { /* ignore */ }
              } else {
                setToResults([]);
              }
            }
          }}
          className={cn(
            'w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-16 md:text-13 text-zinc-900 min-h-[44px] md:min-h-0',
            'focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900',
            toResults.length ? 'mb-0' : 'mb-3',
          )}
        />
        {toResults.length > 0 && (
          <div className="bg-white border-hairline border-zinc-300 border-t-0 rounded-b-sm max-h-[180px] overflow-y-auto mb-3">
            {toResults.map((c) => (
              <div
                key={c.id}
                onClick={() => {
                  setToNumber(c.phone || '');
                  setToSearch(`${c.firstName} ${c.lastName} — ${c.phone || ''}`);
                  setToResults([]);
                }}
                className="px-3 py-2 cursor-pointer border-b border-hairline border-zinc-200 text-13 text-zinc-900 hover:bg-zinc-50"
              >
                <span className="font-medium">{c.firstName} {c.lastName}</span>
                <span className="text-ink-secondary ml-2 font-mono">
                  {c.phone || 'no phone'}
                </span>
              </div>
            ))}
          </div>
        )}

        {activeThread && (() => {
          const lastInbound = activeThread.messages.find((m) => m.direction === 'inbound');
          if (!lastInbound) return null;
          return (
            <div className="mb-3 px-3 py-2.5 bg-zinc-50 border-hairline border-zinc-200 rounded-sm">
              <div className="text-13 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-tertiary mb-1">
                Last message from customer
              </div>
              <div className="text-15 md:text-13 text-zinc-900 leading-normal whitespace-pre-wrap">
                {lastInbound.body}
              </div>
              <div className="text-12 md:text-11 text-ink-tertiary mt-1">
                {formatTimestamp(lastInbound.createdAt)}
              </div>
            </div>
          );
        })()}

        <label className="block text-13 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-secondary mb-1">Message</label>
        <textarea
          placeholder="Type your message…"
          value={msgBody}
          onChange={(e) => setMsgBody(e.target.value)}
          rows={3}
          className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-16 md:text-13 text-zinc-900 resize-y focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
        />
        <div className="text-right text-13 md:text-11 font-mono text-ink-tertiary u-nums mt-1 mb-3">
          {msgBody.length} chars
        </div>

        <div className="flex gap-2">
          <Button
            variant="primary"
            className="flex-1"
            onClick={handleSend}
            disabled={sending || !toNumber.trim() || !msgBody.trim()}
          >
            {sending ? 'Sending…' : 'Send'}
          </Button>
          <Button
            variant="secondary"
            onClick={handleAiDraft}
            disabled={aiDrafting || !toNumber.trim()}
          >
            {aiDrafting ? 'Drafting…' : 'AI Draft'}
          </Button>
        </div>

        {sendResult && (
          <div
            className={cn(
              'mt-2.5 text-12',
              sendResult.ok ? 'text-zinc-900' : 'text-alert-fg',
            )}
          >
            {sendResult.text}
          </div>
        )}
      </Card>

      {/* View toggle — desktop power-user feature; mobile just shows Conversations */}
      <div className="hidden md:flex items-center gap-3 mb-3 flex-wrap">
        <div className="flex border-hairline border-zinc-300 rounded-sm p-0.5 bg-white">
          <button
            type="button"
            onClick={() => { setSmsView('threads'); setActiveThread(null); }}
            className={cn(
              'px-3.5 py-2.5 md:py-1 min-h-[44px] md:min-h-0 text-14 md:text-12 normal-case md:uppercase tracking-normal md:tracking-label rounded-xs u-focus-ring transition-colors',
              (smsView === 'threads' || smsView === 'conversation')
                ? 'bg-zinc-900 text-white'
                : 'text-ink-secondary hover:bg-zinc-50',
            )}
          >
            Conversations
          </button>
          <button
            type="button"
            onClick={() => { setSmsView('log'); setActiveThread(null); }}
            className={cn(
              'px-3.5 py-2.5 md:py-1 min-h-[44px] md:min-h-0 text-14 md:text-12 normal-case md:uppercase tracking-normal md:tracking-label rounded-xs u-focus-ring transition-colors',
              smsView === 'log'
                ? 'bg-zinc-900 text-white'
                : 'text-ink-secondary hover:bg-zinc-50',
            )}
          >
            Log View
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="mb-3">
        <input
          type="text"
          placeholder="Search all SMS by name, phone, or message text…"
          value={smsSearch}
          onChange={(e) => setSmsSearch(e.target.value)}
          className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-16 md:text-13 text-zinc-900 min-h-[44px] md:min-h-0 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
        />
      </div>

      {/* Thread list / conversation / log */}
      {smsView === 'conversation' && activeThread ? (
        <Card className="p-5">
          <ConversationViewV2
            thread={activeThread}
            messages={activeThread.messages.slice().reverse()}
            onReply={handleThreadReply}
            onBack={() => { setSmsView('threads'); setActiveThread(null); }}
          />
        </Card>
      ) : smsView === 'threads' ? (
        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="text-14 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-secondary">
              Conversations
              <span className="ml-2 u-nums">({filteredThreads.length})</span>
            </div>
          </div>

          {/* PR 4 — filter chip row */}
          <div className="flex gap-1.5 mb-3 flex-wrap">
            {[
              { key: 'all', label: 'All', count: chipCounts.all },
              { key: 'unread', label: 'Unread', count: chipCounts.unread },
              { key: 'unanswered', label: 'Unanswered', count: chipCounts.unanswered },
              { key: 'unknown', label: 'Unknown', count: chipCounts.unknown },
            ].map((chip) => {
              const active = statusFilter === chip.key;
              return (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => setStatusFilter(chip.key)}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-3 py-2.5 md:py-1 min-h-[44px] md:min-h-0 rounded-full text-14 md:text-12 font-medium border-hairline u-focus-ring',
                    active
                      ? 'bg-zinc-900 text-white border-zinc-900'
                      : 'bg-white text-ink-secondary border-zinc-300 hover:border-zinc-900 hover:text-zinc-900',
                  )}
                >
                  {chip.label}
                  <span className={cn('u-nums text-11', active ? 'text-zinc-300' : 'text-ink-tertiary')}>
                    {chip.count}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="max-h-[600px] overflow-y-auto">
            {filteredThreads.length === 0 ? (
              <div className="p-5 text-center text-13 text-ink-secondary">
                No conversations found.
              </div>
            ) : (
              filteredThreads.map((t, i) => {
                const preview = t.lastMessage
                  ? t.lastMessage.length > 60
                    ? t.lastMessage.slice(0, 60) + '…'
                    : t.lastMessage
                  : '';
                const threadKey = t.contactPhone?.replace(/\D/g, '').slice(-10);
                const lastReadAt = threadReadAt[threadKey];
                const hasUnseen = t.unanswered
                  && (!lastReadAt || new Date(t.lastTimestamp) > new Date(lastReadAt));
                const isUnknown = !t.customerName;
                return (
                  <div
                    key={i}
                    onClick={() => {
                      setActiveThread(t);
                      setSmsView('conversation');
                      setToNumber(t.contactPhone);
                      if (t.ourNumber) {
                        setFromNumber(t.ourNumber);
                        setThreadLock({ contactPhone: t.contactPhone, ourNumber: t.ourNumber, label: NUMBER_LABEL_MAP[t.ourNumber] || t.ourNumber });
                      }
                      setThreadReadAt((prev) => {
                        const next = { ...prev, [threadKey]: t.lastTimestamp };
                        try {
                          localStorage.setItem('waves_sms_thread_read_at', JSON.stringify(next));
                        } catch { /* ignore */ }
                        return next;
                      });
                    }}
                    className={cn(
                      'w-full text-left px-3.5 py-3.5 md:py-3 border-b border-hairline border-zinc-200 flex items-start gap-3 cursor-pointer',
                      'hover:bg-zinc-50 transition-colors',
                      hasUnseen && 'bg-alert-bg/40',
                    )}
                  >
                    <div className="w-2.5 flex-shrink-0 mt-2">
                      {hasUnseen && (
                        <span
                          className="block w-2 h-2 rounded-full bg-alert-fg"
                          aria-label="Unread"
                        />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-0.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-16 md:text-14 font-medium text-zinc-900 truncate">
                            {t.customerName || t.contactPhone}
                          </span>
                          {isUnknown && <Badge tone="neutral">Unknown</Badge>}
                        </div>
                        <span className="font-mono text-12 md:text-11 text-ink-tertiary flex-shrink-0 ml-2">
                          {timeAgo(t.lastTimestamp)}
                        </span>
                      </div>
                      {t.customerName && (
                        <div className="font-mono text-13 md:text-11 text-ink-tertiary mb-0.5">
                          {t.contactPhone}
                        </div>
                      )}
                      <div className="text-15 md:text-12 text-ink-secondary truncate leading-snug">
                        <span className="mr-1" aria-hidden>
                          {t.lastDirection === 'inbound' ? '↓' : '↑'}
                        </span>
                        {preview}
                      </div>
                    </div>
                    <span className="hidden md:inline font-mono text-11 text-ink-tertiary u-nums flex-shrink-0 mt-0.5">
                      {t.messages.length} msg{t.messages.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </Card>
      ) : (
        <Card className="p-5">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <div className="text-14 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-secondary">
              SMS Log
            </div>
            <div className="flex gap-2">
              <select
                value={dirFilter}
                onChange={(e) => setDirFilter(e.target.value)}
                className="bg-white border-hairline border-zinc-300 rounded-xs py-2 md:py-1 px-2 text-16 md:text-12 text-zinc-900 min-h-[44px] md:min-h-0 focus:outline-none focus:ring-2 focus:ring-zinc-900"
              >
                <option value="all">All directions</option>
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
              </select>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="bg-white border-hairline border-zinc-300 rounded-xs py-2 md:py-1 px-2 text-16 md:text-12 text-zinc-900 min-h-[44px] md:min-h-0 focus:outline-none focus:ring-2 focus:ring-zinc-900"
              >
                <option value="all">All types</option>
                {messageTypes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="max-h-[600px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="p-5 text-center text-13 text-ink-secondary">
                No messages found.
              </div>
            ) : (
              filtered.map((m) => (
                <SmsLogItemV2
                  key={m.id}
                  msg={m}
                  onReply={(phone, from) => {
                    setToNumber(phone);
                    setFromNumber(from);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                />
              ))
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────

export default function CommunicationsPageV2() {
  const [tab, setTab] = useState('sms');
  const newsletterEnabled = useFeatureFlag('newsletter-v1');

  // PR 5 — Newsletter tab appears only when the flag is on. Inserted between
  // Email (automations) and CSR so the two email-ish surfaces are adjacent.
  const tabs = useMemo(() => {
    const base = [...TABS];
    if (newsletterEnabled) {
      const emailIdx = base.findIndex((t) => t.key === 'email');
      base.splice(emailIdx + 1, 0, { key: 'newsletter', label: 'Newsletter', desktopOnly: true });
    }
    return base;
  }, [newsletterEnabled]);

  return (
    <div className="bg-surface-page min-h-full p-4 md:p-6 font-sans text-zinc-900 max-w-[1200px]">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          {/* Mobile h1 matches MobileSettingsPage Square style (inline 700 escapes V2 400/500 font restriction). Desktop stays on the V2 28/normal spec. */}
          <h1
            className="md:hidden text-zinc-900"
            style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-0.015em', lineHeight: 1.1, margin: 0 }}
          >
            Communications
          </h1>
          <h1 className="hidden md:block text-28 font-normal tracking-display text-zinc-900">
            Communications
          </h1>
        </div>
      </div>

      <div className="flex gap-1.5 mb-5 mt-4 flex-wrap">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              'h-11 md:h-9 px-4 text-14 md:text-12 normal-case md:uppercase font-medium tracking-normal md:tracking-label rounded-sm border-hairline u-focus-ring transition-colors',
              t.desktopOnly && 'hidden md:inline-flex items-center',
              tab === t.key
                ? 'bg-zinc-900 text-white border-zinc-900'
                : 'bg-white text-zinc-700 border-zinc-300 hover:bg-zinc-50',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'sms' && <SmsTab />}
      {tab === 'calls' && <CallLogTabV2 />}
      {tab === 'templates' && <SmsTemplatesTabV2 />}
      {tab === 'email' && <EmailAutomationsPanelV2 />}
      {tab === 'newsletter' && newsletterEnabled && <NewsletterTabV2 />}
      {tab === 'csr' && <CSRCoachTabV2 />}
      {tab === 'notifications' && <PushSettingsV2 />}
    </div>
  );
}
