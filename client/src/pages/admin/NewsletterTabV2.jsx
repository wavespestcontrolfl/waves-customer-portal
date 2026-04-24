// client/src/pages/admin/NewsletterTabV2.jsx
// PR 5 — In-house newsletter composer. Replaces Beehiiv.
// Four sub-views: Compose · History · Subscribers · Automations.
// Feature-gated via `newsletter-v1`; this file is only rendered when the
// flag is on (gating happens at the parent tab-list level).

import React, {
  useState, useEffect, useCallback, useMemo,
} from 'react';
import { Badge, Button, Card, cn } from '../../components/ui';
import EmailAutomationsPanelV2 from './EmailAutomationsPanelV2';

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
  { key: 'automations', label: 'Automations' },
];

// Starter HTML templates. Operator picks one → seeds the HTML body textarea.
// Deliberately minimal markup — SendGrid footer is appended automatically.
const TEMPLATES = [
  {
    key: 'blank',
    label: 'Blank',
    html: '',
  },
  {
    key: 'monthly',
    label: 'Monthly update',
    html: `<h1>Your Waves monthly update</h1>
<p>Hi neighbor — quick update from the Waves team on what's going on around Southwest Florida this month.</p>

<h2>What we're watching</h2>
<p>[Short paragraph — the pest or lawn concern that's hitting our service calls hardest right now.]</p>

<h2>Tip of the month</h2>
<p>[One practical thing a homeowner can do this week — 2-3 sentences.]</p>

<h2>What's new at Waves</h2>
<p>[Team news, new service, new territory, or a milestone.]</p>

<p>Questions? Just reply to this email — it goes to our team.</p>
<p>— Waves Pest Control</p>`,
  },
  {
    key: 'seasonal',
    label: 'Seasonal pest alert',
    html: `<h1>[Pest name] are showing up across SWFL</h1>
<p>Heads up — we've seen a noticeable uptick in [pest] activity across [city / region] this past week. Here's what to know and what to do.</p>

<h2>Why now</h2>
<p>[One short paragraph: weather, lifecycle, sandy-soil angle, etc.]</p>

<h2>Signs to watch for</h2>
<ul>
  <li>[Sign 1]</li>
  <li>[Sign 2]</li>
  <li>[Sign 3]</li>
</ul>

<h2>What to do</h2>
<p>[2-3 sentences of practical advice. Then soft mention of Waves being available if they want help.]</p>

<p>— Waves Pest Control</p>`,
  },
  {
    key: 'announcement',
    label: 'Service announcement',
    html: `<h1>[Announcement headline]</h1>
<p>We've got an update to share with our customers — [one-sentence summary].</p>

<h2>What's changing</h2>
<p>[Clear, plain-language paragraph.]</p>

<h2>What it means for you</h2>
<p>[How it affects existing customers. Be direct.]</p>

<h2>Questions?</h2>
<p>Reply to this email or give us a call — we'd rather over-communicate than leave you guessing.</p>

<p>— Waves Pest Control</p>`,
  },
  {
    key: 'roundup',
    label: 'Blog roundup',
    html: `<h1>This month on the Waves blog</h1>
<p>A quick roundup of what we published — in case any of it is useful to you this month.</p>

<h2><a href="https://www.wavespestcontrol.com/[slug-1]">[Post title 1]</a></h2>
<p>[1-2 sentence teaser.]</p>

<h2><a href="https://www.wavespestcontrol.com/[slug-2]">[Post title 2]</a></h2>
<p>[1-2 sentence teaser.]</p>

<h2><a href="https://www.wavespestcontrol.com/[slug-3]">[Post title 3]</a></h2>
<p>[1-2 sentence teaser.]</p>

<p>— Waves Pest Control</p>`,
  },
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
      {view === 'automations' && <EmailAutomationsPanelV2 />}
    </div>
  );
}

// ── Compose ────────────────────────────────────────────────────────

function ComposeView() {
  const [draftId, setDraftId] = useState(null);
  const [subject, setSubject] = useState('');
  const [subjectB, setSubjectB] = useState('');
  const [abEnabled, setAbEnabled] = useState(false);
  const [previewText, setPreviewText] = useState('');
  const [htmlBody, setHtmlBody] = useState('');
  const [textBody, setTextBody] = useState('');
  const [fromName, setFromName] = useState('Waves Pest Control');
  const [fromEmail, setFromEmail] = useState('newsletter@wavespestcontrol.com');
  const [testEmail, setTestEmail] = useState('contact@wavespestcontrol.com');
  const [status, setStatus] = useState('');
  const [activeCount, setActiveCount] = useState(null);
  const [segmentCount, setSegmentCount] = useState(null);

  // Segment
  const [segmentMode, setSegmentMode] = useState('all');   // all | customers | leads | custom
  const [segmentSources, setSegmentSources] = useState([]);

  // Schedule
  const [scheduleAt, setScheduleAt] = useState('');

  // AI modal
  const [aiOpen, setAiOpen] = useState(false);

  const segmentFilter = useMemo(() => {
    if (segmentMode === 'all') return null;
    const f = {};
    if (segmentMode === 'customers') f.customersOnly = true;
    if (segmentMode === 'leads') f.leadsOnly = true;
    if (segmentSources.length) f.sources = segmentSources;
    return Object.keys(f).length ? f : null;
  }, [segmentMode, segmentSources]);

  useEffect(() => {
    adminFetch('/admin/newsletter/subscribers?status=active&limit=1')
      .then((d) => setActiveCount(d.counts?.active || 0))
      .catch(() => setActiveCount(null));
  }, []);

  // Recalculate segment match count when the filter changes.
  useEffect(() => {
    let cancelled = false;
    adminFetch('/admin/newsletter/segment-preview', {
      method: 'POST',
      body: JSON.stringify({ segmentFilter }),
    })
      .then((d) => { if (!cancelled) setSegmentCount(d.count); })
      .catch(() => { if (!cancelled) setSegmentCount(null); });
    return () => { cancelled = true; };
  }, [segmentFilter]);

  const applyTemplate = (key) => {
    const t = TEMPLATES.find((x) => x.key === key);
    if (!t) return;
    if (htmlBody && !confirm('Replace the current HTML body with this template?')) return;
    setHtmlBody(t.html);
  };

  const saveDraft = async () => {
    setStatus('Saving...');
    try {
      const body = {
        subject,
        subjectB: abEnabled ? subjectB : null,
        previewText,
        htmlBody,
        textBody,
        fromName,
        fromEmail,
        segmentFilter,
      };
      if (draftId) {
        await adminFetch(`/admin/newsletter/sends/${draftId}`, { method: 'PATCH', body: JSON.stringify(body) });
        setStatus('Draft saved.');
      } else {
        const d = await adminFetch('/admin/newsletter/sends', { method: 'POST', body: JSON.stringify(body) });
        setDraftId(d.send.id);
        setStatus('Draft saved.');
      }
    } catch (e) { setStatus('Save failed: ' + e.message); }
  };

  const sendTest = async () => {
    if (!draftId) { setStatus('Save a draft first.'); return; }
    setStatus(`Sending test to ${testEmail}...`);
    try {
      await adminFetch(`/admin/newsletter/sends/${draftId}/test`, { method: 'POST', body: JSON.stringify({ email: testEmail }) });
      setStatus(`Test sent to ${testEmail}.`);
    } catch (e) { setStatus('Test failed: ' + e.message); }
  };

  const sendNow = async () => {
    if (!draftId) { setStatus('Save a draft first.'); return; }
    const audience = segmentCount ?? activeCount ?? '?';
    if (!confirm(`Send "${subject}" to ${audience} subscriber${audience === 1 ? '' : 's'}? This cannot be undone.`)) return;
    setStatus(`Sending to ${audience} subscribers...`);
    try {
      const res = await adminFetch(`/admin/newsletter/sends/${draftId}/send`, { method: 'POST' });
      setStatus(`Sent: ${res.delivered}/${res.recipients} delivered (${res.failed} failed).`);
      resetForm();
    } catch (e) { setStatus('Send failed: ' + e.message); }
  };

  const schedule = async () => {
    if (!draftId) { setStatus('Save a draft first.'); return; }
    if (!scheduleAt) { setStatus('Pick a date/time first.'); return; }
    const when = new Date(scheduleAt);
    if (when.getTime() <= Date.now()) { setStatus('Pick a time in the future.'); return; }
    setStatus('Scheduling...');
    try {
      const res = await adminFetch(`/admin/newsletter/sends/${draftId}/schedule`, {
        method: 'POST',
        body: JSON.stringify({ scheduledFor: when.toISOString() }),
      });
      setStatus(`Scheduled for ${new Date(res.send.scheduled_for).toLocaleString()}.`);
      resetForm();
    } catch (e) { setStatus('Schedule failed: ' + e.message); }
  };

  const resetForm = () => {
    setDraftId(null);
    setSubject(''); setSubjectB(''); setAbEnabled(false);
    setPreviewText(''); setHtmlBody(''); setTextBody('');
    setScheduleAt('');
  };

  const handleAiDraft = async ({ prompt, audience, tone, includeCTA }) => {
    const res = await adminFetch('/admin/newsletter/draft-ai', {
      method: 'POST',
      body: JSON.stringify({ prompt, audience, tone, includeCTA }),
    });
    const d = res.draft || {};
    if (d.subject) setSubject(d.subject);
    if (d.previewText) setPreviewText(d.previewText);
    if (d.htmlBody) setHtmlBody(d.htmlBody);
    if (d.textBody) setTextBody(d.textBody);
    setAiOpen(false);
    setStatus('AI draft inserted. Review before saving.');
  };

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-16 font-medium text-zinc-900">New campaign</h3>
          <p className="text-12 text-ink-secondary mt-0.5">
            {segmentCount !== null && segmentFilter
              ? `${segmentCount} of ${activeCount ?? '?'} subscribers match segment`
              : activeCount !== null
                ? `${activeCount} active subscriber${activeCount === 1 ? '' : 's'}`
                : 'Loading subscribers…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setAiOpen(true)} variant="secondary">Draft with AI</Button>
          {draftId && <Badge tone="neutral">Draft saved</Badge>}
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">Template</label>
          <div className="flex flex-wrap gap-1.5">
            {TEMPLATES.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => applyTemplate(t.key)}
                className="h-8 px-3 text-12 font-medium rounded-sm border-hairline border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 u-focus-ring"
              >{t.label}</button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">
            Subject {abEnabled && <span className="text-ink-tertiary normal-case">(A)</span>}
          </label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            placeholder="e.g. Florida spring pest alert — what to watch for"
          />
          <label className="mt-2 inline-flex items-center gap-2 text-12 text-ink-secondary">
            <input type="checkbox" checked={abEnabled} onChange={(e) => setAbEnabled(e.target.checked)} />
            A/B test a second subject (random 50/50 split)
          </label>
        </div>

        {abEnabled && (
          <div>
            <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">Subject (B)</label>
            <input
              type="text"
              value={subjectB}
              onChange={(e) => setSubjectB(e.target.value)}
              className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
              placeholder="Alternative subject line"
            />
          </div>
        )}

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

        <div>
          <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">Audience</label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {[
              { key: 'all', label: 'All active' },
              { key: 'customers', label: 'Customers only' },
              { key: 'leads', label: 'Non-customers only' },
              { key: 'custom', label: 'By source…' },
            ].map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => setSegmentMode(o.key)}
                className={cn(
                  'h-8 px-3 text-12 font-medium rounded-sm border-hairline u-focus-ring',
                  segmentMode === o.key
                    ? 'bg-zinc-900 text-white border-zinc-900'
                    : 'bg-white text-zinc-700 border-zinc-300 hover:bg-zinc-50',
                )}
              >{o.label}</button>
            ))}
          </div>
          {segmentMode === 'custom' && (
            <div className="flex flex-wrap gap-1.5">
              {['website', 'booking', 'checkout', 'quote', 'import', 'manual'].map((src) => {
                const on = segmentSources.includes(src);
                return (
                  <button
                    key={src}
                    type="button"
                    onClick={() => setSegmentSources((cur) => on ? cur.filter((x) => x !== src) : [...cur, src])}
                    className={cn(
                      'h-7 px-2.5 text-11 rounded-full border-hairline u-focus-ring',
                      on
                        ? 'bg-zinc-900 text-white border-zinc-900'
                        : 'bg-white text-ink-secondary border-zinc-300 hover:border-zinc-900',
                    )}
                  >{src}</button>
                );
              })}
            </div>
          )}
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

        <div className="flex items-center gap-2 pt-2">
          <label className="text-11 uppercase tracking-label text-ink-secondary">Schedule</label>
          <input
            type="datetime-local"
            value={scheduleAt}
            onChange={(e) => setScheduleAt(e.target.value)}
            className="bg-white border-hairline border-zinc-300 rounded-sm py-1.5 px-2 text-12 text-zinc-900 font-mono"
          />
          <Button onClick={schedule} variant="secondary" disabled={!draftId || !scheduleAt || !htmlBody}>Schedule send</Button>
          <span className="text-11 text-ink-tertiary ml-auto">America/New_York · fires within 1 min of target</span>
        </div>

        {status && (
          <div className="text-12 text-ink-secondary pt-2">{status}</div>
        )}
      </div>

      {aiOpen && <AiDraftModal onClose={() => setAiOpen(false)} onDraft={handleAiDraft} />}
    </Card>
  );
}

// ── AI draft modal ────────────────────────────────────────────────

function AiDraftModal({ onClose, onDraft }) {
  const [prompt, setPrompt] = useState('');
  const [audience, setAudience] = useState('Existing Waves customers');
  const [tone, setTone] = useState('Neighborly, owner-operator');
  const [includeCTA, setIncludeCTA] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const run = async () => {
    if (prompt.trim().length < 8) { setErr('Describe the newsletter (at least 8 characters)'); return; }
    setLoading(true); setErr('');
    try {
      await onDraft({ prompt, audience, tone, includeCTA });
    } catch (e) {
      setErr(e.message);
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white border-hairline border-zinc-300 rounded-sm shadow-xl w-full max-w-lg p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-16 font-medium text-zinc-900">Draft with AI</h3>
          <button type="button" onClick={onClose} className="text-ink-tertiary hover:text-zinc-900 text-14">✕</button>
        </div>

        <div>
          <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">What's the newsletter about?</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            placeholder="e.g. Spring uptick in no-see-ums and what homeowners can do this week. Want to mention our mosquito service as a soft CTA."
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">Audience</label>
            <input
              type="text"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            />
          </div>
          <div>
            <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">Tone</label>
            <input
              type="text"
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            />
          </div>
        </div>

        <label className="inline-flex items-center gap-2 text-12 text-ink-secondary">
          <input type="checkbox" checked={includeCTA} onChange={(e) => setIncludeCTA(e.target.checked)} />
          Include a call to action at the end
        </label>

        {err && <div className="text-12 text-alert-fg">{err}</div>}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-hairline border-zinc-200">
          <Button onClick={onClose} variant="secondary" disabled={loading}>Cancel</Button>
          <Button onClick={run} disabled={loading}>{loading ? 'Drafting…' : 'Draft it'}</Button>
        </div>
      </div>
    </div>
  );
}

// ── History ────────────────────────────────────────────────────────

function HistoryView() {
  const [sends, setSends] = useState([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    adminFetch('/admin/newsletter/sends')
      .then((d) => setSends(d.sends || []))
      .catch(() => setSends([]))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const cancelSchedule = async (id) => {
    if (!confirm('Cancel this scheduled send and return it to draft?')) return;
    try {
      await adminFetch(`/admin/newsletter/sends/${id}/cancel-schedule`, { method: 'POST' });
      load();
    } catch (e) { alert('Cancel failed: ' + e.message); }
  };

  const importBeehiiv = async () => {
    if (!confirm('Import all past newsletters from Beehiiv? Existing imported rows will be refreshed with the latest stats.')) return;
    setImporting(true); setImportMsg('');
    try {
      const r = await adminFetch('/admin/newsletter/import-beehiiv', { method: 'POST' });
      setImportMsg(`Imported ${r.imported} new · refreshed ${r.updated}`);
      load();
    } catch (e) { setImportMsg('Import failed: ' + e.message); }
    finally { setImporting(false); }
  };

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-16 font-medium text-zinc-900">Past sends</h3>
        <div className="flex items-center gap-2">
          {importMsg && <span className="text-11 text-ink-secondary">{importMsg}</span>}
          <Button onClick={importBeehiiv} variant="secondary" disabled={importing}>
            {importing ? 'Importing…' : 'Import from Beehiiv'}
          </Button>
          <span className="text-11 text-ink-tertiary u-nums">{sends.length} campaign{sends.length === 1 ? '' : 's'}</span>
        </div>
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
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="text-14 font-medium text-zinc-900 truncate">{s.subject}</span>
                    {s.subject_b && <Badge tone="muted">A/B</Badge>}
                    {s.segment_filter && <Badge tone="muted">Segmented</Badge>}
                    {s.external_source === 'beehiiv' && <Badge tone="muted">Beehiiv</Badge>}
                    <StatusChip status={s.status} />
                    {s.external_web_url && (
                      <a
                        href={s.external_web_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-11 text-ink-secondary hover:text-zinc-900 underline decoration-dotted"
                      >View on web ↗</a>
                    )}
                  </div>
                  <div className="text-11 text-ink-tertiary">
                    {s.created_by_name || 'Admin'} · {
                      s.status === 'scheduled' && s.scheduled_for
                        ? `scheduled for ${new Date(s.scheduled_for).toLocaleString()}`
                        : s.sent_at ? new Date(s.sent_at).toLocaleString() : 'draft (not sent)'
                    }
                  </div>
                  {s.subject_b && (
                    <div className="text-11 text-ink-tertiary mt-0.5 truncate">B: {s.subject_b}</div>
                  )}
                </div>
                <div className="flex items-center gap-5 text-12 flex-shrink-0">
                  {s.status === 'scheduled' ? (
                    <button
                      type="button"
                      onClick={() => cancelSchedule(s.id)}
                      className="text-11 px-2 py-1 border-hairline border-zinc-300 rounded-sm text-ink-secondary hover:text-zinc-900 hover:border-zinc-900 u-focus-ring"
                    >Cancel schedule</button>
                  ) : (
                    <>
                      <Stat label="Sent" value={s.recipient_count || 0} />
                      <Stat label="Delivered" value={`${s.delivered_count || 0} (${pct}%)`} />
                      <Stat label="Bounced" value={s.bounced_count || 0} alert={s.bounced_count > 0} />
                      <Stat label="Unsub" value={s.unsubscribed_count || 0} />
                    </>
                  )}
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
  if (status === 'scheduled') return <Badge tone="neutral">Scheduled</Badge>;
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
                  {s.customer_id && <Badge tone="muted">Customer</Badge>}
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
