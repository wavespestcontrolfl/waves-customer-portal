import { useCallback, useEffect, useRef, useState } from 'react';
import { adminFetch } from '../../utils/admin-fetch';
import { TIMEZONE, etDateString, formatETDateOnly } from '../../lib/timezone';

const API = '/admin/call-recordings';
const post = (path, body) => adminFetch(path, { method: 'POST', body: JSON.stringify(body) });
const patch = (path, body) => adminFetch(path, { method: 'PATCH', body: JSON.stringify(body) });
const when = (value) => value ? new Date(value).toLocaleString('en-US', {
  timeZone: TIMEZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}) : 'Time needs review';
const clock = (value) => new Date(value).toLocaleTimeString('en-US', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit' });
const windowLabel = (w) => w ? `${when(w.start_at)} to ${clock(w.end_at)}` : 'No arrival window';
const who = (r) => [r.customer_first_name || r.first_name, r.customer_last_name || r.last_name].filter(Boolean).join(' ') || 'Caller';
const phone = (r) => r.phone || r.customer_phone || (r.direction === 'outbound' ? r.to_phone : r.from_phone);
const scheduleLink = (v) => `/admin/dispatch?tab=schedule&date=${String(v.scheduled_date || '').slice(0, 10)}&appointment=${encodeURIComponent(v.id)}`;

// One behavior layer; the admin and tech adapters supply their own native
// style systems. Both read and settle the same server records.
export default function FollowThroughCards({ ui, onCallbacksEnabled, onQuickMove }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(null);
  const busyRef = useRef(false);
  const request = useRef(0);
  const mounted = useRef(true);
  const load = useCallback(async (offset = 0) => {
    const seq = ++request.current;
    try {
      const next = await adminFetch(`${API}/follow-through?offset=${offset}`);
      if (!mounted.current || seq !== request.current) return;
      setData((old) => offset && old ? { ...next,
        callbacks: [...(old.callbacks || []), ...(next.callbacks || [])], proposals: [...(old.proposals || []), ...(next.proposals || [])],
        no_shows: [...(old.no_shows || []), ...(next.no_shows || [])] } : next);
      onCallbacksEnabled?.(next.callbacks_enabled === true);
      setError('');
    } catch (err) { if (mounted.current && seq === request.current) setError(err.message || 'Could not load follow-through.'); }
  }, [onCallbacksEnabled]);
  useEffect(() => {
    mounted.current = true;
    load();
    const refresh = () => { if (!document.hidden && !busyRef.current) load(); };
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => { mounted.current = false; request.current += 1; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [load]);
  const act = async (id, action, success = '') => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(id); setError(''); setNotice('');
    try {
      const result = await action();
      if (result?.success === false) throw new Error(result.error || 'The action could not finish.');
      if (mounted.current) setNotice(success);
      await load();
    } catch (err) {
      await load();
      if (mounted.current) setError(err.message || 'That action did not finish.');
    } finally { busyRef.current = false; if (mounted.current) setBusy(null); }
  };
  const { Card, Button, Text, Select, Link } = ui;
  const enabled = data?.callbacks_enabled || data?.proposals_enabled || data?.no_shows_enabled;
  if (!enabled && !error) return null;
  const callbacks = data?.callbacks || [];
  const snoozed = callbacks.filter((r) => r.snoozed_until && new Date(r.snoozed_until).getTime() > Date.now());
  const renderCallback = (r) => {
    const overdue = r.due_at && new Date(r.due_at).getTime() < Date.now();
    return <Card key={r.id}>
      <Text tone="title">Call {who(r)}</Text>
      <Text tone={overdue || !r.due_at ? 'alert' : 'muted'}>{overdue ? 'Overdue · ' : 'Due '}{when(r.due_at)}</Text>
      <Text>{r.description}</Text>
      {r.evidence?.[0]?.quote && <Text>“{r.evidence[0].quote}”</Text>}
      <Text tone="muted">{phone(r)} · Call {when(r.call_started_at)}{r.owner_name ? ` · ${r.owner_name}` : ''}</Text>
      {r.snoozed_until && new Date(r.snoozed_until) > new Date() && <Text tone="muted">Snoozed until {when(r.snoozed_until)}</Text>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!!busy || !phone(r)} onClick={() => act(r.id, () => post('/admin/communications/call', {
          to: phone(r), customerId: r.customer_id || undefined, relatedCommitmentId: r.id, expected_at: r.updated_at,
        }), 'The staff phone is ringing. Press 1 to connect.')}>Call</Button>
        <Button secondary disabled={!!busy} onClick={() => act(r.id, () => patch(`${API}/commitments/${r.id}`, { action: 'fulfill', expected_at: r.updated_at }))}>Done</Button>
        <Select aria-label={`Snooze callback for ${who(r)}`} value="" disabled={!!busy} onChange={(e) => {
          const snooze = e.target.value;
          if (snooze) act(r.id, () => patch(`${API}/commitments/${r.id}`, { action: 'snooze', snooze, expected_at: r.updated_at }));
        }}><option value="">Snooze…</option><option value="two_hours">2 hours</option><option value="tomorrow">Next working morning</option></Select>
      </div>
      <Link href={`/admin/communications#tab=calls&call=${r.call_log_id}`}>Open call</Link>
    </Card>;
  };
  return <section aria-label="Follow-through" className="space-y-3 mb-5">
    <div className="flex items-center justify-between gap-2"><Text tone="title">Follow-through</Text><Button secondary disabled={!!busy} onClick={() => load()}>Refresh</Button></div>
    {error && <div role="alert"><Text tone="alert">{error}</Text></div>}
    {notice && <div role="status"><Text>{notice}</Text></div>}
    {callbacks.filter((r) => !snoozed.includes(r)).map(renderCallback)}
    {(data?.proposals || []).map((r) => <ProposalCard key={r.id} row={r} ui={ui} busy={busy} act={act} />)}
    {(data?.no_shows || []).map((r) => {
      const movedToFuture = String(r.scheduled_date || '').slice(0, 10) > etDateString();
      return <Card key={`arrival-${r.id}`}>
      <Text tone="title">{r.stage === 2 ? 'Arrival needs attention' : 'Window is underway'} · {who(r)}</Text>
      <Text tone={r.stage === 2 ? 'alert' : 'muted'}>{r.message}</Text>
      <Text>Promised {windowLabel(r.promised_window)}</Text>
      {movedToFuture && <Text tone="muted">Now scheduled for {formatETDateOnly(r.scheduled_date, { month: 'short', day: 'numeric' })}.</Text>}
      <div className="flex flex-wrap gap-2">
        {onQuickMove && !movedToFuture ? <Button onClick={() => onQuickMove(r)}>Quick Move</Button> : <Link href={scheduleLink(r)}>Open appointment</Link>}
        <Button secondary disabled={!!busy || !phone(r)} onClick={() => act(r.id, () => post('/admin/communications/call', { to: phone(r), customerId: r.customer_id }), 'Adam’s phone is ringing. Press 1 to connect.')}>Call customer</Button>
      </div>
    </Card>;
    })}
    {snoozed.length > 0 && <details><summary className="cursor-pointer py-2">{snoozed.length} snoozed callback{snoozed.length === 1 ? '' : 's'}</summary><div className="space-y-3">{snoozed.map(renderCallback)}</div></details>}
    {enabled && !callbacks.length && !data?.proposals?.length && !data?.no_shows?.length && <Text tone="muted">No follow-through needs attention.</Text>}
    {data?.has_more && <Button secondary disabled={!!busy} onClick={() => load(data.next_offset)}>Load more</Button>}
  </section>;
}

function ProposalCard({ row, ui, busy, act }) {
  const [visitId, setVisitId] = useState(row.matched_visit_id || (row.candidates.length === 1 ? row.candidates[0].id : ''));
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const { Card, Text, Button, Select, Link } = ui;
  useEffect(() => {
    let cancelled = false;
    setPreview(null); setError('');
    if (visitId) post(`${API}/proposals/${row.id}/preview`, { visit_id: visitId }).then((p) => {
      if (!cancelled) setPreview(p);
    }).catch((err) => { if (!cancelled) setError(err.message || 'Could not check this appointment.'); });
    return () => { cancelled = true; };
  }, [row.id, row.updated_at, visitId]);
  const selected = row.candidates.find((r) => r.id === visitId);
  const count = preview?.series?.collective ? preview.series.movableCount : 1;
  return <Card>
    <Text tone="title">Requested time · {who(row)}</Text>
    <Text>Asked for {windowLabel(row.requested_window)}</Text>
    <Text>“{row.proposal.quote}”</Text>
    {row.candidates.length > 1 && <Select aria-label={`Appointment discussed with ${who(row)}`} value={visitId} onChange={(e) => setVisitId(e.target.value)} disabled={!!busy}>
      <option value="">Select the appointment discussed</option>
      {row.candidates.map((v) => <option key={v.id} value={v.id}>{v.service_name} · {windowLabel(v.current_window)}{v.property?.address_line1 ? ` · ${v.property.address_line1}` : ''}</option>)}
    </Select>}
    {selected && <><Text>Currently {windowLabel(selected.current_window)}</Text><Text tone="muted">{selected.service_name}{selected.property?.address_line1 ? ` · ${selected.property.address_line1}` : ''}</Text></>}
    {preview?.series?.collective && <Text>This also moves {Math.max(0, count - 1)} later visit(s), through {preview.series.lastAffectedDate}. Later visits keep their current times.</Text>}
    {count > 1 && <details><summary className="cursor-pointer py-2">Affected later visits</summary>{preview.series.occurrences.filter((v) => v.id !== visitId).map((v) => <Text key={v.id} tone="muted">{v.from_date} → {v.to_date}</Text>)}</details>}
    {preview?.series?.conflictCount > 0 && <Text tone="alert">{preview.series.conflictCount} later visit(s) may need another available window.</Text>}
    {error && <Text tone="alert">{error}</Text>}
    {visitId && !preview && !error && <Text tone="muted">Checking the appointment…</Text>}
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={!!busy || !preview || preview.series?.conflictCount > 0} onClick={() => act(row.id, () => post(`${API}/proposals/${row.id}/apply`, {
        visit_id: visitId, preview_hash: preview.preview_hash,
      }), 'Appointment moved. Normal reminders will use the new time.')}>{count > 1 ? `Apply · move ${count} visits` : 'Apply'}</Button>
      {selected && <Link href={scheduleLink(selected)}>Pick another time</Link>}
      <Button secondary disabled={!!busy} onClick={() => act(row.id, () => post(`${API}/proposals/${row.id}/dismiss`, { expected_at: row.updated_at }))}>Dismiss</Button>
    </div>
    <Text tone="muted">Apply closes this card. Normal appointment reminders continue.</Text>
  </Card>;
}

export { windowLabel, scheduleLink };
