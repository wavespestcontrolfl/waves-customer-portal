// client/src/pages/admin/CallLogTabV2.jsx
// Monochrome V2 of CallLogTab. Strict 1:1 on endpoints, state, actions:
//   GET  /ai/admin/calls[?search=...][?days=365&limit=200]
//   POST /admin/communications/call
//   PUT  /admin/call-recordings/calls/:id/disposition
// alert-fg reserved for Missed stat / missed-call row accent / Call Back button only.
import { useState, useEffect } from 'react';
import { Badge, Button, Card, CardBody, Input, Select, cn } from '../../components/ui';
import {
  ALL_NUMBERS,
  CALL_DISPOSITIONS,
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
  const [callFrom, setCallFrom] = useState('+19413187612');
  const [calling, setCalling] = useState(false);
  const [callResult, setCallResult] = useState(null);
  const [dispositions, setDispositions] = useState({});
  const [savingDisp, setSavingDisp] = useState(null);
  const [callFilter, setCallFilter] = useState('all');
  const [callLogSearch, setCallLogSearch] = useState('');

  const loadCalls = (search = '') => {
    const q = search
      ? `?search=${encodeURIComponent(search)}&limit=1000`
      : '?days=365&limit=200';
    adminFetch(`/ai/admin/calls${q}`)
      .then((d) => { setCalls(d.calls || []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { loadCalls(); }, []);
  useEffect(() => {
    const t = setTimeout(() => { loadCalls(callLogSearch.trim()); }, 300);
    return () => clearTimeout(t);
  }, [callLogSearch]);

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

  const handleDisposition = async (callId, value) => {
    if (value === 'spam' && !confirm('Block this number and delete the call log? This cannot be undone.')) return;
    setDispositions((prev) => ({ ...prev, [callId]: value }));
    setSavingDisp(callId);
    try {
      const r = await adminFetch(`/admin/call-recordings/calls/${callId}/disposition`, {
        method: 'PUT',
        body: JSON.stringify({ disposition: value }),
      });
      if (r.deleted) setCalls((prev) => prev.filter((c) => c.id !== callId));
    } catch (e) {
      alert('Tag failed: ' + e.message);
    } finally {
      setSavingDisp(null);
    }
  };

  const handleCallBack = (phone) => {
    setCallTo(phone);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleCreateLead = (phone, city, state) => {
    const params = new URLSearchParams({ phone: phone || '' });
    if (city) params.set('city', city);
    if (state) params.set('state', state);
    window.open(`/admin/customers/new?${params.toString()}`, '_blank');
  };

  if (loading) return <div className="p-10 text-center text-ink-tertiary text-13">Loading calls…</div>;

  const answered = calls.filter((c) => c.answered_by === 'human').length;
  const aiHandled = calls.filter((c) => c.answered_by === 'voice_agent').length;
  const voicemail = calls.filter((c) => c.answered_by === 'voicemail').length;
  const missed = calls.filter((c) => !c.answered_by || c.answered_by === 'missed').length;

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
    if (callFilter === 'ai_agent') return c.answered_by === 'voice_agent';
    if (callFilter === 'voicemail') return c.answered_by === 'voicemail';
    if (callFilter === 'missed') return !c.answered_by || c.answered_by === 'missed';
    return true;
  });

  return (
    <div className="flex flex-col gap-4">
      {/* Stats filter bar */}
      <div className="flex gap-2 flex-wrap">
        <StatButton label="Total" value={calls.length} filter="all" active={callFilter === 'all'} onClick={() => setCallFilter('all')} />
        <StatButton label="Answered" value={answered} filter="answered" active={callFilter === 'answered'} onClick={() => setCallFilter((p) => p === 'answered' ? 'all' : 'answered')} />
        <StatButton label="AI Agent" value={aiHandled} filter="ai_agent" active={callFilter === 'ai_agent'} onClick={() => setCallFilter((p) => p === 'ai_agent' ? 'all' : 'ai_agent')} />
        <StatButton label="Voicemail" value={voicemail} filter="voicemail" active={callFilter === 'voicemail'} onClick={() => setCallFilter((p) => p === 'voicemail' ? 'all' : 'voicemail')} />
        <StatButton label="Missed" value={missed} filter="missed" active={callFilter === 'missed'} alert onClick={() => setCallFilter((p) => p === 'missed' ? 'all' : 'missed')} />
      </div>

      {/* Source analytics */}
      {sortedSources.length > 0 && (
        <Card>
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
          <div className="text-11 uppercase tracking-label text-ink-tertiary mb-3">Make a Call</div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-11 uppercase tracking-label text-ink-tertiary mb-1">From</label>
              <Select value={callFrom} onChange={(e) => setCallFrom(e.target.value)}>
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
              <label className="block text-11 uppercase tracking-label text-ink-tertiary mb-1">To</label>
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
                className={callToSearch ? '' : 'font-mono u-nums'}
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
                      className="w-full text-left px-3 py-2 border-b border-zinc-200 last:border-0 hover:bg-zinc-50 text-13"
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
            <div className="text-11 uppercase tracking-label text-ink-tertiary">Call History</div>
            <Input
              type="text"
              placeholder="Search calls by name or phone…"
              value={callLogSearch}
              onChange={(e) => setCallLogSearch(e.target.value)}
              className="max-w-[360px] min-w-[200px]"
            />
          </div>

          {calls.length === 0 ? (
            <div className="p-5 text-center text-ink-tertiary text-13">No calls recorded yet.</div>
          ) : (
            <div className="max-h-[600px] overflow-y-auto">
              {filteredCalls.map((c) => {
                const isMissed = !c.answered_by || c.answered_by === 'missed';
                const answeredLabel = c.answered_by === 'human' ? 'Answered'
                  : c.answered_by === 'voice_agent' ? 'AI Agent'
                  : c.answered_by === 'voicemail' ? 'Voicemail' : 'Missed';
                const badgeTone = isMissed ? 'alert' : c.answered_by === 'human' ? 'strong' : 'neutral';
                const dur = c.duration_seconds
                  ? `${Math.floor(c.duration_seconds / 60)}:${String(c.duration_seconds % 60).padStart(2, '0')}`
                  : '--';
                const isUnknown = !c.first_name && !c.customer_id;
                const currentDisp = dispositions[c.id] || c.disposition || '';

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
                        <div className="text-13 text-ink-primary font-medium">
                          {c.first_name ? `${c.first_name} ${c.last_name || ''}` : (c.from_phone || 'Unknown')}
                          <span className="ml-2 text-11 text-ink-tertiary font-normal">
                            {c.direction === 'inbound' ? 'Inbound' : 'Outbound'}
                          </span>
                        </div>
                        <div className="text-11 text-ink-tertiary">
                          {c.from_phone}{c.to_phone ? ` → ${c.to_phone}` : ''} · {dur}
                          {c.caller_city ? ` · ${c.caller_city}, ${c.caller_state}` : ''}
                        </div>
                        {c.voice_agent_outcome && (
                          <div className="text-11 text-ink-secondary mt-0.5">Outcome: {c.voice_agent_outcome?.replace(/_/g, ' ')}</div>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        <Badge tone={badgeTone}>{answeredLabel}</Badge>
                        <span className="text-10 text-ink-tertiary">{timeAgo(c.created_at)}</span>
                      </div>
                    </div>

                    {/* Action row */}
                    <div className="mt-2 ml-8 flex gap-2 flex-wrap items-center">
                      <Select
                        value={currentDisp}
                        onChange={(e) => handleDisposition(c.id, e.target.value)}
                        className={cn('h-7 text-11 py-0 w-auto', savingDisp === c.id && 'opacity-50')}
                      >
                        {CALL_DISPOSITIONS.map((d) => (
                          <option key={d.value} value={d.value}>{d.label}</option>
                        ))}
                      </Select>

                      {isMissed && c.from_phone && (
                        <Button variant="danger" size="sm" onClick={() => handleCallBack(c.from_phone)}>
                          Call Back
                        </Button>
                      )}

                      {isUnknown && c.from_phone && (
                        <Button variant="secondary" size="sm" onClick={() => handleCreateLead(c.from_phone, c.caller_city, c.caller_state)}>
                          Create Lead
                        </Button>
                      )}
                    </div>

                    {/* Recording */}
                    {c.recording_url && (
                      <div className="mt-2 ml-8 p-2 bg-zinc-50 border-hairline rounded-md">
                        <div className="text-11 text-ink-tertiary font-medium mb-1">
                          Recording{c.recording_duration_seconds
                            ? ` (${Math.floor(c.recording_duration_seconds / 60)}:${String(c.recording_duration_seconds % 60).padStart(2, '0')})`
                            : ''}
                        </div>
                        <audio controls preload="none" className="w-full h-8">
                          <source src={c.recording_url} type="audio/mpeg" />
                        </audio>
                      </div>
                    )}

                    {/* Transcription */}
                    {c.transcription && (
                      <div className="mt-1.5 ml-8 p-2 bg-zinc-50 border-hairline rounded-md">
                        <div className="text-11 text-ink-tertiary font-medium mb-0.5">Transcription</div>
                        <div className="text-12 text-ink-secondary italic leading-relaxed">"{c.transcription}"</div>
                      </div>
                    )}
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
