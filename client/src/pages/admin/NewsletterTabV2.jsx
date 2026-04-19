// client/src/pages/admin/NewsletterTabV2.jsx
// PR 5 — In-house newsletter composer. Replaces Beehiiv.
// Three sub-views: Compose · History · Subscribers.
// Feature-gated via `newsletter-v1`; this file is only rendered when the
// flag is on (gating happens at the parent tab-list level).

import React, {
  useState, useEffect, useCallback, useMemo,
} from 'react';
import { Badge, Button, Card, cn } from '../../components/ui';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
    },
    ...options,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    return data;
  });
}

const SUB_TABS = [
  { key: 'compose', label: 'Compose' },
  { key: 'history', label: 'History' },
  { key: 'subscribers', label: 'Subscribers' },
];

export default function NewsletterTabV2() {
  const [view, setView] = useState('compose');

  return (
    <div className="space-y-4">
      <div className="flex gap-1.5 flex-wrap">
        {SUB_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setView(t.key)}
            className={cn(
              'h-8 px-3 text-11 uppercase font-medium tracking-label rounded-sm border-hairline u-focus-ring transition-colors',
              view === t.key
                ? 'bg-zinc-900 text-white border-zinc-900'
                : 'bg-white text-zinc-700 border-zinc-300 hover:bg-zinc-50',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {view === 'compose' && <ComposeView />}
      {view === 'history' && <HistoryView />}
      {view === 'subscribers' && <SubscribersView />}
    </div>
  );
}

// ── Compose ────────────────────────────────────────────────────────

function ComposeView() {
  const [draftId, setDraftId] = useState(null);
  const [subject, setSubject] = useState('');
  const [previewText, setPreviewText] = useState('');
  const [htmlBody, setHtmlBody] = useState('');
  const [textBody, setTextBody] = useState('');
  const [fromName, setFromName] = useState('Waves Pest Control');
  const [fromEmail, setFromEmail] = useState('newsletter@wavespestcontrol.com');
  const [testEmail, setTestEmail] = useState('contact@wavespestcontrol.com');
  const [status, setStatus] = useState('');
  const [activeCount, setActiveCount] = useState(null);

  useEffect(() => {
    adminFetch('/admin/newsletter/subscribers?status=active&limit=1')
      .then((d) => setActiveCount(d.counts?.active || 0))
      .catch(() => setActiveCount(null));
  }, []);

  const saveDraft = async () => {
    setStatus('Saving...');
    try {
      if (draftId) {
        await adminFetch(`/admin/newsletter/sends/${draftId}`, {
          method: 'PATCH',
          body: JSON.stringify({ subject, previewText, htmlBody, textBody, fromName, fromEmail }),
        });
        setStatus('Draft saved.');
      } else {
        const d = await adminFetch('/admin/newsletter/sends', {
          method: 'POST',
          body: JSON.stringify({ subject, previewText, htmlBody, textBody, fromName, fromEmail }),
        });
        setDraftId(d.send.id);
        setStatus('Draft saved.');
      }
    } catch (e) { setStatus('Save failed: ' + e.message); }
  };

  const sendTest = async () => {
    if (!draftId) { setStatus('Save a draft first.'); return; }
    setStatus(`Sending test to ${testEmail}...`);
    try {
      await adminFetch(`/admin/newsletter/sends/${draftId}/test`, {
        method: 'POST',
        body: JSON.stringify({ email: testEmail }),
      });
      setStatus(`Test sent to ${testEmail}.`);
    } catch (e) { setStatus('Test failed: ' + e.message); }
  };

  const sendNow = async () => {
    if (!draftId) { setStatus('Save a draft first.'); return; }
    if (!confirm(`Send "${subject}" to ${activeCount ?? '?'} active subscribers? This cannot be undone.`)) return;
    setStatus(`Sending to ${activeCount} subscribers...`);
    try {
      const res = await adminFetch(`/admin/newsletter/sends/${draftId}/send`, { method: 'POST' });
      setStatus(`Sent: ${res.delivered}/${res.recipients} delivered (${res.failed} failed).`);
      setDraftId(null);
      setSubject(''); setPreviewText(''); setHtmlBody(''); setTextBody('');
    } catch (e) { setStatus('Send failed: ' + e.message); }
  };

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-16 font-medium text-zinc-900">New campaign</h3>
          <p className="text-12 text-ink-secondary mt-0.5">
            {activeCount !== null ? `${activeCount} active subscriber${activeCount === 1 ? '' : 's'}` : 'Loading subscribers…'}
          </p>
        </div>
        {draftId && <Badge tone="neutral">Draft saved</Badge>}
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">Subject</label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            placeholder="e.g. Florida spring pest alert — what to watch for"
          />
        </div>

        <div>
          <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">Preview text</label>
          <input
            type="text"
            value={previewText}
            onChange={(e) => setPreviewText(e.target.value)}
            className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            placeholder="One-line preview that renders after the subject in Gmail/Apple Mail."
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">From name</label>
            <input
              type="text"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            />
          </div>
          <div>
            <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">From email</label>
            <input
              type="text"
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
              className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900 font-mono focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            />
          </div>
        </div>

        <div>
          <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">HTML body</label>
          <textarea
            value={htmlBody}
            onChange={(e) => setHtmlBody(e.target.value)}
            rows={12}
            className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900 font-mono focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            placeholder="<h1>Subject line</h1><p>Your newsletter content here. The unsubscribe footer is appended automatically.</p>"
          />
          <p className="text-11 text-ink-tertiary mt-1">
            The unsubscribe footer + List-Unsubscribe header are added automatically — do not include your own.
          </p>
        </div>

        <div>
          <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">
            Plain-text fallback <span className="text-ink-tertiary normal-case">(optional — improves deliverability)</span>
          </label>
          <textarea
            value={textBody}
            onChange={(e) => setTextBody(e.target.value)}
            rows={4}
            className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            placeholder="Same content in plain text for mail clients that don't render HTML."
          />
        </div>

        <div className="flex items-center gap-3 pt-2 border-t border-hairline border-zinc-200">
          <Button onClick={saveDraft} variant="secondary" disabled={!subject}>
            {draftId ? 'Update draft' : 'Save draft'}
          </Button>
          <div className="flex items-center gap-2 ml-auto">
            <input
              type="text"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              className="bg-white border-hairline border-zinc-300 rounded-sm py-1.5 px-2 text-12 text-zinc-900 font-mono w-56"
              placeholder="test@wavespestcontrol.com"
            />
            <Button onClick={sendTest} variant="secondary" disabled={!draftId}>Send test</Button>
            <Button onClick={sendNow} disabled={!draftId || !htmlBody}>Send to all</Button>
          </div>
        </div>

        {status && (
          <div className="text-12 text-ink-secondary pt-2">{status}</div>
        )}
      </div>
    </Card>
  );
}

// ── History ────────────────────────────────────────────────────────

function HistoryView() {
  const [sends, setSends] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    adminFetch('/admin/newsletter/sends')
      .then((d) => setSends(d.sends || []))
      .catch(() => setSends([]))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-16 font-medium text-zinc-900">Past sends</h3>
        <span className="text-11 text-ink-tertiary u-nums">{sends.length} campaign{sends.length === 1 ? '' : 's'}</span>
      </div>

      {loading ? (
        <div className="text-13 text-ink-secondary p-6 text-center">Loading…</div>
      ) : sends.length === 0 ? (
        <div className="text-13 text-ink-secondary p-8 text-center">No campaigns yet. Compose your first newsletter in the Compose tab.</div>
      ) : (
        <div className="space-y-0 -mx-5">
          {sends.map((s) => {
            const pct = s.recipient_count ? Math.round((s.delivered_count / s.recipient_count) * 100) : 0;
            return (
              <div key={s.id} className="px-5 py-3 border-b border-hairline border-zinc-200 flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-14 font-medium text-zinc-900 truncate">{s.subject}</span>
                    <StatusChip status={s.status} />
                  </div>
                  <div className="text-11 text-ink-tertiary">
                    {s.created_by_name || 'Admin'} · {s.sent_at ? new Date(s.sent_at).toLocaleString() : 'draft (not sent)'}
                  </div>
                </div>
                <div className="flex items-center gap-5 text-12 flex-shrink-0">
                  <Stat label="Sent" value={s.recipient_count || 0} />
                  <Stat label="Delivered" value={`${s.delivered_count || 0} (${pct}%)`} />
                  <Stat label="Bounced" value={s.bounced_count || 0} alert={s.bounced_count > 0} />
                  <Stat label="Unsub" value={s.unsubscribed_count || 0} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function StatusChip({ status }) {
  if (status === 'sent') return <Badge tone="strong">Sent</Badge>;
  if (status === 'sending') return <Badge tone="neutral">Sending…</Badge>;
  if (status === 'failed') return <Badge tone="alert">Failed</Badge>;
  return <Badge tone="muted">Draft</Badge>;
}

function Stat({ label, value, alert }) {
  return (
    <div className="text-right">
      <div className={cn('u-nums font-medium', alert ? 'text-alert-fg' : 'text-zinc-900')}>{value}</div>
      <div className="text-11 text-ink-tertiary">{label}</div>
    </div>
  );
}

// ── Subscribers ───────────────────────────────────────────────────

function SubscribersView() {
  const [subs, setSubs] = useState([]);
  const [counts, setCounts] = useState({});
  const [filter, setFilter] = useState('active');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (filter !== 'all') qs.set('status', filter);
    if (q) qs.set('q', q);
    adminFetch(`/admin/newsletter/subscribers?${qs}`)
      .then((d) => {
        setSubs(d.subscribers || []);
        setCounts(d.counts || {});
      })
      .catch(() => setSubs([]))
      .finally(() => setLoading(false));
  }, [filter, q]);
  useEffect(() => { load(); }, [load]);

  const addSubscriber = async () => {
    const email = prompt('Email address to add:');
    if (!email) return;
    setStatus('Adding...');
    try {
      await adminFetch('/admin/newsletter/subscribers', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      setStatus(`Added ${email}.`);
      load();
    } catch (e) { setStatus('Failed: ' + e.message); }
  };

  const removeSubscriber = async (id, email) => {
    if (!confirm(`Unsubscribe ${email}?`)) return;
    try {
      await adminFetch(`/admin/newsletter/subscribers/${id}`, { method: 'DELETE' });
      load();
    } catch (e) { alert('Failed: ' + e.message); }
  };

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-16 font-medium text-zinc-900">Subscribers</h3>
        <Button onClick={addSubscriber} variant="secondary">+ Add subscriber</Button>
      </div>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {['active', 'unsubscribed', 'bounced', 'all'].map((f) => {
          const active = filter === f;
          const count = f === 'all'
            ? Object.values(counts).reduce((a, b) => a + b, 0)
            : counts[f] || 0;
          return (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-12 font-medium border-hairline u-focus-ring',
                active
                  ? 'bg-zinc-900 text-white border-zinc-900'
                  : 'bg-white text-ink-secondary border-zinc-300 hover:border-zinc-900',
              )}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
              <span className={cn('u-nums text-11', active ? 'text-zinc-300' : 'text-ink-tertiary')}>{count}</span>
            </button>
          );
        })}
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search email…"
          className="ml-auto bg-white border-hairline border-zinc-300 rounded-sm py-1.5 px-2 text-12 text-zinc-900 w-64"
        />
      </div>

      {status && <div className="text-12 text-ink-secondary mb-2">{status}</div>}

      {loading ? (
        <div className="text-13 text-ink-secondary p-6 text-center">Loading…</div>
      ) : subs.length === 0 ? (
        <div className="text-13 text-ink-secondary p-8 text-center">No subscribers in this filter.</div>
      ) : (
        <div className="-mx-5">
          {subs.map((s) => (
            <div key={s.id} className="px-5 py-2.5 border-b border-hairline border-zinc-200 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-13 text-zinc-900 font-mono truncate">{s.email}</span>
                  {s.status === 'unsubscribed' && <Badge tone="muted">Unsubscribed</Badge>}
                  {s.status === 'bounced' && <Badge tone="alert">Bounced</Badge>}
                </div>
                <div className="text-11 text-ink-tertiary">
                  {s.first_name || s.last_name ? `${s.first_name || ''} ${s.last_name || ''}`.trim() + ' · ' : ''}
                  Source: {s.source || 'unknown'} · Joined {new Date(s.subscribed_at).toLocaleDateString()}
                  {s.bounce_count > 0 && ` · ${s.bounce_count} bounce${s.bounce_count === 1 ? '' : 's'}`}
                </div>
              </div>
              {s.status === 'active' && (
                <button
                  type="button"
                  onClick={() => removeSubscriber(s.id, s.email)}
                  className="text-11 px-2 py-1 border-hairline border-zinc-300 rounded-sm text-ink-secondary hover:text-zinc-900 hover:border-zinc-900 u-focus-ring"
                >Unsubscribe</button>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
