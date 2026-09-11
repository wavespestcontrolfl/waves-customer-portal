import { useCallback, useEffect, useRef, useState } from 'react';
import { adminFetch } from '../../utils/admin-fetch';
import { TIMEZONE } from '../../lib/timezone';

const API = '/admin/call-recordings';
const PAGE = 100;
const post = (path, body) => adminFetch(path, { method: 'POST', body: JSON.stringify(body) });
const patch = (path, body) => adminFetch(path, { method: 'PATCH', body: JSON.stringify(body) });
const when = (value) => value ? new Date(value).toLocaleString('en-US', {
  timeZone: TIMEZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}) : 'Time needs review';
const who = (r) => [r.customer_first_name || r.first_name, r.customer_last_name || r.last_name].filter(Boolean).join(' ') || 'Caller';
const phone = (r) => r.phone || r.customer_phone || (r.direction === 'outbound' ? r.to_phone : r.from_phone);
// The deadline the ledger judges the card by: a staffed or stated deadline,
// else the implicit one it projects (effective_due_at is snooze-aware).
const dueAt = (r) => r.effective_due_at || r.due_at || null;

// One behavior layer; the admin and tech adapters supply their own native
// style systems. Both read and settle the same server records: open callback
// cards Waves owes, from the commitments ledger, acted on through the
// versioned PATCH route (expected_at fences a stale card).
export default function FollowThroughCards({ ui, onCallbacksEnabled }) {
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
      const next = await adminFetch(`${API}/commitments/open?party=waves&kind=callback&limit=${PAGE}&offset=${offset}`);
      if (!mounted.current || seq !== request.current) return;
      setData((old) => offset && old ? { ...next, commitments: [...(old.commitments || []), ...(next.commitments || [])] } : next);
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
  const enabled = data?.callbacks_enabled === true;
  if (!enabled && !error) return null;
  const callbacks = data?.commitments || [];
  const snoozed = callbacks.filter((r) => r.snoozed_until && new Date(r.snoozed_until).getTime() > Date.now());
  const renderCallback = (r) => {
    const due = dueAt(r);
    const overdue = r.overdue === true || (!!due && new Date(due).getTime() < Date.now());
    return <Card key={r.id}>
      <Text tone="title">Call {who(r)}</Text>
      <Text tone={overdue || !due ? 'alert' : 'muted'}>{overdue ? 'Overdue · ' : 'Due '}{when(due)}</Text>
      <Text>{r.description}</Text>
      {r.evidence?.[0]?.quote && <Text>“{r.evidence[0].quote}”</Text>}
      <Text tone="muted">{phone(r)} · Call {when(r.call_started_at)}{r.owner_name ? ` · ${r.owner_name}` : ''}</Text>
      {snoozed.includes(r) && <Text tone="muted">Snoozed until {when(r.snoozed_until)}</Text>}
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
    {snoozed.length > 0 && <details><summary className="cursor-pointer py-2">{snoozed.length} snoozed callback{snoozed.length === 1 ? '' : 's'}</summary><div className="space-y-3">{snoozed.map(renderCallback)}</div></details>}
    {enabled && !callbacks.length && <Text tone="muted">No follow-through needs attention.</Text>}
    {data?.has_more && <Button secondary disabled={!!busy} onClick={() => load(data.next_offset)}>Load more</Button>}
  </section>;
}
