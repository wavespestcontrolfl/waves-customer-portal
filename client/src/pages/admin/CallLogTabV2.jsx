// client/src/pages/admin/CallLogTabV2.jsx
// Monochrome V2 of CallLogTab. Endpoints:
//   GET  /ai/admin/calls[?search=...][?days=365&limit=200]
//   POST /admin/communications/call
// alert-fg reserved for Missed stat / missed-call row accent only.
//
// Audit focus:
// - Outbound call: POST /admin/communications/call rings the
//   operator's phone first, then bridges to the customer when the
//   operator presses 1. Confirm single-flight on the "Call" button so
//   double-click doesn't initiate two simultaneous bridge calls.
// - Search debounce: /ai/admin/calls?search= on a fast typer should
//   abort prior inflight requests so results render in order.
// - Missed-call alert tone: spec reserves alert-fg for the Missed
//   stat + missed-call row accent ONLY. Watch for decorative misuse.
// - Caller-ID enrichment: inbound calls run through Twilio Lookup;
//   confirm the row gracefully renders when enrichment returns null
//   (rural / unlisted numbers).
// - Day window: default ?days=365&limit=200 — at scale the list may
//   need pagination. Confirm there's a "Load more" path, not a
//   silent truncation that hides recent calls.
// - Disposition gap: missed calls that lack an operator-set
//   disposition should surface in a clear "needs review" state.
import { useState, useEffect, useRef } from 'react';
import { Badge, Button, Card, CardBody, Input, Select, cn } from '../../components/ui';
import {
  ALL_NUMBERS,
  NUMBER_LABEL_MAP,
} from './CommunicationsPage';

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
  const mins = Math.floor((Date.now() - new Date(dateStr)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function StatButton({ label, value, filter, active, onClick, alert }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 min-w-[110px] bg-white border-hairline rounded-md p-3 text-center transition-colors hover:bg-zinc-50',
        active ? 'border-zinc-900' : 'border-zinc-200',
      )}
    >
      <div className="text-11 uppercase tracking-label text-ink-tertiary mb-1">{label}</div>
      <div className={cn('text-22 font-mono u-nums', alert && value > 0 ? 'text-alert-fg' : 'text-ink-primary')}>{value}</div>
    </button>
  );
}

export default function CallLogTabV2() {
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [callTo, setCallTo] = useState('');
  const [callToSearch, setCallToSearch] = useState('');
  const [callToResults, setCallToResults] = useState([]);
  const [callFrom, setCallFrom] = useState('+19412975749');
  const [calling, setCalling] = useState(false);
  const [callResult, setCallResult] = useState(null);
  const [callFilter, setCallFilter] = useState('all');
  const [callLogSearch, setCallLogSearch] = useState('');
  const [processingCallSid, setProcessingCallSid] = useState(null);
  const [processResult, setProcessResult] = useState(null);
  // Auto-processed sids — once we kick off a transcription run for a call
  // we don't retry it during this session, even if it errors. Avoids hammering
  // Gemini in a loop on a permanently-broken row.
  const autoAttemptedRef = useRef(new Set());
  const [autoProcessingSid, setAutoProcessingSid] = useState(null);
  // Transcript expand/collapse per call id. Default to expanded so the
  // operator sees the preview the moment it lands.
  const [expandedTranscripts, setExpandedTranscripts] = useState(() => new Set());
  const toggleTranscript = (id) => setExpandedTranscripts((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const loadCalls = (search = '') => {
    const q = search
      ? `?search=${encodeURIComponent(search)}&limit=1000`
      : '?days=365&limit=200';
    return adminFetch(`/ai/admin/calls${q}`)
      .then((d) => { setCalls(d.calls || []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { loadCalls(); }, []);
  useEffect(() => {
    const t = setTimeout(() => { loadCalls(callLogSearch.trim()); }, 300);
    return () => clearTimeout(t);
  }, [callLogSearch]);

  // Calls that need backend Gemini processing — has a recording but the
  // processor never finished extracting (no terminal status) and nothing
  // was transcribed. Voicemail/spam/processed rows are intentionally skipped.
  const needsAutoProcess = (c) => {
    if (!c?.twilio_call_sid || !c.recording_url) return false;
    if (c.transcription && c.transcription.length > 0) return false;
    const status = c.processing_status;
    if (status === 'processed' || status === 'voicemail' || status === 'spam') return false;
    if (autoAttemptedRef.current.has(c.twilio_call_sid)) return false;
    return true;
  };

  // Serial auto-processor: pick the next unprocessed call and run it through
  // the Gemini pipeline (transcribe + extract → customer/lead/estimate).
  // One at a time so we don't fan out a bunch of slow Gemini requests.
  useEffect(() => {
    if (autoProcessingSid || processingCallSid) return;
    const next = calls.find(needsAutoProcess);
    if (!next) return;

    const sid = next.twilio_call_sid;
    autoAttemptedRef.current.add(sid);
    setAutoProcessingSid(sid);

    (async () => {
      try {
        await adminFetch(`/admin/call-recordings/process/${sid}`, { method: 'POST' });
      } catch {
        // Non-blocking — leave the row as-is; admin can manually reprocess.
      } finally {
        setAutoProcessingSid(null);
        // Refresh so the new transcription / extraction shows up, which
        // also re-runs this effect for the next pending call.
        loadCalls(callLogSearch.trim());
      }
    })();
  }, [calls, autoProcessingSid, processingCallSid]);

  const handleCall = async () => {
    if (!callTo.trim()) return;
    setCalling(true);
    setCallResult(null);
    try {
      await adminFetch('/admin/communications/call', {
        method: 'POST',
        body: JSON.stringify({ to: callTo.trim(), fromNumber: callFrom }),
      });
      setCallResult({ ok: true, text: 'Call initiated. Your phone will ring shortly.' });
      setCallTo('');
      setTimeout(loadCalls, 3000);
    } catch (e) {
      setCallResult({ ok: false, text: `Failed: ${e.message}` });
    } finally {
      setCalling(false);
    }
  };

  const handleCreateLead = (phone, city, state) => {
    const params = new URLSearchParams({ phone: phone || '' });
    if (city) params.set('city', city);
    if (state) params.set('state', state);
    window.open(`/admin/customers/new?${params.toString()}`, '_blank');
  };

  const handleProcessCall = async (callSid, alreadyProcessed) => {
    if (!callSid || processingCallSid) return;
    setProcessingCallSid(callSid);
    setProcessResult(null);
    // Always force on user-initiated taps — the concurrent-run guard exists
    // to dedup webhook double-fires, not to block a manual retry. Without
    // force, a row stuck at processing_status='processing' (e.g. an earlier
    // run that crashed before reaching a terminal state) is unrecoverable.
    const force = true;
    try {
      const res = await adminFetch(
        `/admin/call-recordings/process/${callSid}${force ? '?force=true' : ''}`,
        { method: 'POST' },
      );
      if (res?.success === false) {
        setProcessResult({ ok: false, callSid, text: `Process failed: ${res.error || 'unknown error'}` });
      } else if (res?.skipped) {
        setProcessResult({ ok: true, callSid, text: `Skipped — ${res.reason || 'no work to do'}` });
      } else {
        const extracted = res?.extracted || {};
        const parts = [];
        const name = [extracted.first_name, extracted.last_name].filter(Boolean).join(' ');
        if (name) parts.push(`Name: ${name}`);
        if (extracted.email) parts.push(`Email: ${extracted.email}`);
        const addr = extracted.address_line1 || extracted.address;
        if (addr) parts.push(`Address: ${addr}`);
        const detail = parts.length ? ` — ${parts.join(' · ')}` : '';
        setProcessResult({ ok: true, callSid, text: `Processed${detail}` });
      }
      await loadCalls(callLogSearch.trim());
    } catch (err) {
      setProcessResult({ ok: false, callSid, text: `Process failed: ${err.message || 'unknown error'}` });
    } finally {
      setProcessingCallSid(null);
    }
  };

  if (loading) return <div className="p-10 text-center text-ink-tertiary text-13">Loading calls…</div>;

  // A call is only "missed" if Twilio didn't classify it AND nothing was
  // captured — no duration, no recording, no transcript. Otherwise a real
  // conversation happened and it should show as "Discussion".
  const hadConversation = (c) => (
    Number(c.duration_seconds) > 5
    || !!c.recording_url
    || !!c.transcription
  );
  const isReallyMissed = (c) => (!c.answered_by || c.answered_by === 'missed') && !hadConversation(c);
  const answered = calls.filter((c) => c.answered_by === 'human').length;
  const voicemail = calls.filter((c) => c.answered_by === 'voicemail').length;
  const missed = calls.filter(isReallyMissed).length;

  const now = new Date();
  const thisMonthCalls = calls.filter((c) => {
    const cd = new Date(c.created_at);
    return cd.getMonth() === now.getMonth() && cd.getFullYear() === now.getFullYear();
  });
  const sourceNumberCounts = {};
  thisMonthCalls.forEach((c) => {
    const num = c.to_phone || 'Unknown';
    const label = NUMBER_LABEL_MAP[num] || num;
    sourceNumberCounts[label] = (sourceNumberCounts[label] || 0) + 1;
  });
  const sortedSources = Object.entries(sourceNumberCounts).sort((a, b) => b[1] - a[1]);

  const filteredCalls = calls.filter((c) => {
    if (callFilter === 'all') return true;
    if (callFilter === 'answered') return c.answered_by === 'human';
    if (callFilter === 'voicemail') return c.answered_by === 'voicemail';
    if (callFilter === 'missed') return isReallyMissed(c);
    return true;
  });

  return (
    <div className="flex flex-col gap-4">
      {/* Stats filter bar — desktop only */}
      <div className="hidden md:flex gap-2 flex-wrap">
        <StatButton label="Total" value={calls.length} filter="all" active={callFilter === 'all'} onClick={() => setCallFilter('all')} />
        <StatButton label="Answered" value={answered} filter="answered" active={callFilter === 'answered'} onClick={() => setCallFilter((p) => p === 'answered' ? 'all' : 'answered')} />
        <StatButton label="Voicemail" value={voicemail} filter="voicemail" active={callFilter === 'voicemail'} onClick={() => setCallFilter((p) => p === 'voicemail' ? 'all' : 'voicemail')} />
        <StatButton label="Missed" value={missed} filter="missed" active={callFilter === 'missed'} alert onClick={() => setCallFilter((p) => p === 'missed' ? 'all' : 'missed')} />
      </div>

      {/* Source analytics — desktop only */}
      {sortedSources.length > 0 && (
        <Card className="hidden md:block">
          <CardBody>
            <div className="text-11 uppercase tracking-label text-ink-tertiary mb-3">Calls Per Source (This Month)</div>
            <div className="flex flex-wrap gap-2">
              {sortedSources.slice(0, 12).map(([label, count]) => (
                <div key={label} className="flex items-center gap-2 px-3 py-1 bg-zinc-50 border-hairline rounded-md">
                  <span className="text-12 text-ink-secondary">{label}</span>
                  <span className="text-13 font-mono u-nums text-ink-primary">{count}</span>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Make a Call */}
      <Card>
        <CardBody>
          <div className="text-14 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-tertiary mb-3">Make a Call</div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-13 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-tertiary mb-1">From</label>
              <Select
                value={callFrom}
                onChange={(e) => setCallFrom(e.target.value)}
                className="h-11 md:h-9 text-16 md:text-13 min-h-[44px] md:min-h-0"
              >
                {ALL_NUMBERS.map((group) => (
                  <optgroup key={group.group} label={group.group}>
                    {group.numbers.map((n) => (
                      <option key={n.number} value={n.number}>{n.formatted} — {n.label}</option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </div>
            <div className="relative">
              <label className="block text-13 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-tertiary mb-1">To</label>
              <Input
                type="text"
                placeholder="Search by name or enter phone number…"
                value={callToSearch || callTo}
                onChange={async (e) => {
                  const val = e.target.value;
                  if (/^[\d\s()\-+]+$/.test(val)) {
                    setCallTo(val);
                    setCallToSearch('');
                    setCallToResults([]);
                  } else {
                    setCallToSearch(val);
                    setCallTo('');
                    if (val.length >= 2) {
                      try {
                        const r = await fetch(`${API_BASE}/admin/customers?search=${encodeURIComponent(val)}&limit=8`, {
                          headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
                        });
                        if (r.ok) { const d = await r.json(); setCallToResults(d.customers || []); }
                      } catch {}
                    } else { setCallToResults([]); }
                  }
                }}
                className={cn(
                  callToSearch ? '' : 'font-mono u-nums',
                  'h-11 md:h-9 text-16 md:text-13 min-h-[44px] md:min-h-0',
                )}
              />
              {callToResults.length > 0 && (
                <div className="mt-1 bg-white border-hairline rounded-md max-h-[180px] overflow-y-auto">
                  {callToResults.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setCallTo(c.phone || '');
                        setCallToSearch(`${c.firstName} ${c.lastName} — ${c.phone || ''}`);
                        setCallToResults([]);
                      }}
                      className="w-full text-left px-3 py-3 md:py-2 min-h-[44px] md:min-h-0 border-b border-zinc-200 last:border-0 hover:bg-zinc-50 text-14 md:text-13"
                    >
                      <span className="font-medium text-ink-primary">{c.firstName} {c.lastName}</span>
                      <span className="ml-2 text-ink-tertiary">{c.phone || 'no phone'}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <Button
            variant="primary"
            onClick={handleCall}
            disabled={calling || !callTo.trim()}
          >
            {calling ? 'Calling…' : 'Call'}
          </Button>

          {callResult && (
            <div className={cn('mt-3 text-12', callResult.ok ? 'text-ink-secondary' : 'text-alert-fg')}>
              {callResult.text}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Call history */}
      <Card>
        <CardBody>
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <div className="text-14 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-tertiary">Call History</div>
            <Input
              type="text"
              placeholder="Search calls by name or phone…"
              value={callLogSearch}
              onChange={(e) => setCallLogSearch(e.target.value)}
              className="max-w-[360px] min-w-[200px] h-11 md:h-9 text-16 md:text-13 min-h-[44px] md:min-h-0"
            />
          </div>

          {calls.length === 0 ? (
            <div className="p-5 text-center text-ink-tertiary text-13">No calls recorded yet.</div>
          ) : (
            <div className="md:max-h-[600px] md:overflow-y-auto">
              {filteredCalls.map((c) => {
                const conversed = hadConversation(c);
                const isMissed = (!c.answered_by || c.answered_by === 'missed') && !conversed;
                const answeredLabel = c.answered_by === 'human' ? 'Answered'
                  : c.answered_by === 'voicemail' ? 'Voicemail'
                  : conversed ? 'Discussion'
                  : 'Missed';
                const badgeTone = isMissed ? 'alert'
                  : c.answered_by === 'human' ? 'strong'
                  : conversed ? 'strong'
                  : 'neutral';
                const dur = c.duration_seconds
                  ? `${Math.floor(c.duration_seconds / 60)}:${String(c.duration_seconds % 60).padStart(2, '0')}`
                  : '--';
                const isUnknown = !c.first_name && !c.customer_id;

                return (
                  <div
                    key={c.id}
                    className={cn(
                      'py-3 pl-3 border-b border-zinc-200',
                      isMissed ? 'bg-alert-bg/40 border-l-[3px] border-l-alert-fg' : 'border-l-[3px] border-l-transparent',
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <span className="w-5 text-center text-14 text-ink-secondary">{c.direction === 'inbound' ? '↓' : '↑'}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-15 md:text-13 text-ink-primary font-medium">
                          {c.first_name ? `${c.first_name} ${c.last_name || ''}` : (c.from_phone || 'Unknown')}
                          <span className="ml-2 text-12 md:text-11 text-ink-tertiary font-normal">
                            {c.direction === 'inbound' ? 'Inbound' : 'Outbound'}
                          </span>
                        </div>
                        <div className="text-13 md:text-11 text-ink-tertiary">
                          {c.from_phone}{c.to_phone ? ` → ${c.to_phone}` : ''} · {dur}
                          {c.caller_city ? ` · ${c.caller_city}, ${c.caller_state}` : ''}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        <Badge tone={badgeTone}>{answeredLabel}</Badge>
                        <span className="text-12 md:text-10 text-ink-tertiary">{timeAgo(c.created_at)}</span>
                      </div>
                    </div>

                    {/* Action row — Create Lead for unknown inbound callers.
                        Transcription + Gemini extraction (name / email /
                        address → customers + estimates) runs automatically
                        in the background; a discreet Reprocess link is kept
                        so admins can re-run extraction on already-processed
                        rows. */}
                    {((isUnknown && c.from_phone) || c.twilio_call_sid) && (
                      <div className="mt-2 ml-8 flex gap-2 flex-wrap items-center">
                        {isUnknown && c.from_phone && (
                          <Button variant="secondary" size="sm" onClick={() => handleCreateLead(c.from_phone, c.caller_city, c.caller_state)}>
                            Create Lead
                          </Button>
                        )}
                        {c.twilio_call_sid && (() => {
                          const isAuto = autoProcessingSid === c.twilio_call_sid;
                          const isManual = processingCallSid === c.twilio_call_sid;
                          const isProcessed = c.processing_status === 'processed';
                          if (isAuto || isManual) {
                            return (
                              <span className="text-12 text-ink-tertiary italic">
                                {isProcessed ? 'Reprocessing…' : 'Auto-transcribing…'}
                              </span>
                            );
                          }
                          if (isProcessed) {
                            return (
                              <button
                                type="button"
                                onClick={() => handleProcessCall(c.twilio_call_sid, true)}
                                disabled={!!processingCallSid || !!autoProcessingSid}
                                className="text-11 uppercase tracking-label text-ink-tertiary hover:text-ink-primary u-focus-ring"
                              >
                                Reprocess
                              </button>
                            );
                          }
                          return null;
                        })()}
                        {processResult && processResult.callSid === c.twilio_call_sid && (
                          <span className={cn('text-12', processResult.ok ? 'text-ink-secondary' : 'text-alert-fg')}>
                            {processResult.text}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Recording — proxy through the admin audio endpoint so
                        the browser gets past Twilio's Basic-auth gate. */}
                    {c.recording_url && (
                      <div className="mt-2 ml-8 p-2 bg-zinc-50 border-hairline rounded-md">
                        <div className="text-13 md:text-11 text-ink-tertiary font-medium mb-1">
                          Recording{c.recording_duration_seconds
                            ? ` (${Math.floor(c.recording_duration_seconds / 60)}:${String(c.recording_duration_seconds % 60).padStart(2, '0')})`
                            : ''}
                        </div>
                        <audio controls preload="none" className="w-full h-8">
                          <source src={`${API_BASE}/admin/call-recordings/audio/${c.recording_sid || c.id}?token=${encodeURIComponent(localStorage.getItem('waves_admin_token') || '')}`} type="audio/mpeg" />
                        </audio>
                      </div>
                    )}

                    {/* Transcription — collapsible. Transcripts are noisy,
                        keep them out of the way until the admin wants them. */}
                    {c.transcription && (() => {
                      const open = expandedTranscripts.has(c.id);
                      const preview = c.transcription.length > 120
                        ? c.transcription.slice(0, 120).trim() + '…'
                        : c.transcription;
                      return (
                        <div className="mt-1.5 ml-8 bg-zinc-50 border-hairline rounded-md">
                          <button
                            type="button"
                            onClick={() => toggleTranscript(c.id)}
                            className="w-full flex items-center justify-between gap-2 p-2 text-left u-focus-ring"
                            aria-expanded={open}
                          >
                            <span className="text-13 md:text-11 text-ink-tertiary font-medium">
                              Transcription{c.transcription.length > 120 ? ` · ${c.transcription.length} chars` : ''}
                            </span>
                            <span aria-hidden className="text-12 text-ink-tertiary">{open ? '▾' : '▸'}</span>
                          </button>
                          <div className="px-2 pb-2 text-14 md:text-12 text-ink-secondary italic leading-relaxed">
                            "{open ? c.transcription : preview}"
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
