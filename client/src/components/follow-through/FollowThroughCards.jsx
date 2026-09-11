import { useCallback, useEffect, useRef, useState } from 'react';
import { adminFetch } from '../../utils/admin-fetch';
import { TIMEZONE } from '../../lib/timezone';

const API = '/admin/call-recordings';
const PAGE = 100;
const patch = (path, body) => adminFetch(path, { method: 'PATCH', body: JSON.stringify(body) });
const when = (value) => value ? new Date(value).toLocaleString('en-US', {
  timeZone: TIMEZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}) : 'Time needs review';
const who = (r) => [r.customer_first_name || r.first_name, r.customer_last_name || r.last_name].filter(Boolean).join(' ') || 'Caller';
// Twilio directions are 'outbound', 'outbound-api', 'outbound-dial', …; the
// customer is the dialed side of any of them (matches the Owed helper and
// the bridge's validation).
const phone = (r) => r.phone || r.customer_phone || (String(r.direction || '').startsWith('outbound') ? r.to_phone : r.from_phone);
// The deadline the ledger judges the card by: a staffed or stated deadline,
// else the implicit one it projects (effective_due_at is snooze-aware).
const dueAt = (r) => r.effective_due_at || r.due_at || null;
const humanize = (value) => String(value || '').replace(/_/g, ' ');
// The ledger's association hint: a completed outbound call (or similar) that
// may already have kept this callback. Shown so staff confirm instead of
// calling twice (the Owed row carried the same warning).
const possiblyKept = (r) => r.fulfillment?.strength === 'association' ? r.fulfillment : null;

const DEFAULT_POLL_MS = 30000;
const EMPTY_TEXT = { true: 'Loading follow-through…', false: 'No follow-through needs attention.' };

// One behavior layer; the admin and tech adapters supply their own native
// style systems. Both read and settle the same server records: open callback
// cards Waves owes, from the commitments ledger, acted on through the
// versioned PATCH route (expected_at fences a stale card).
//   hints=false hides rows carrying an association hint (the Owed tab's
//   "Show possibly-kept" filter); pollMs is the background refresh cadence —
//   each read also runs the ledger's fulfillment refresh window, so a fleet
//   of tech tabs polls far less often than the office queue; onSummary reports
//   whether the cards loaded enabled, their open/overdue counts, and whether
//   more pages remain, so a host can fold them into its own summary.
export default function FollowThroughCards({ ui, onSummary, hints = true, pollMs = DEFAULT_POLL_MS }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(null);
  // Overdue and snooze presentation follows the clock, not the (slow) poll.
  const [now, setNow] = useState(() => Date.now());
  const busyRef = useRef(false);
  const request = useRef(0);
  // A read in flight (initial, page append, or refresh); background ticks
  // wait for it rather than superseding a Load more page mid-read.
  const reading = useRef(false);
  const mounted = useRef(true);
  // Pages the operator has walked to; a background refresh re-reads that
  // whole range so "Load more" rows and the queue position survive it.
  const pages = useRef(1);
  const fetchPage = useCallback((page) =>
    adminFetch(`${API}/commitments/open?party=waves&kind=callback${hints ? '' : '&hints=0'}&limit=${PAGE}&offset=${page * PAGE}`), [hints]);
  // Loads one more page (append) or re-reads pages 0..count-1 (replace).
  const load = useCallback(async ({ page = null, count = 1 } = {}) => {
    const seq = ++request.current;
    reading.current = true;
    try {
      let next;
      if (page != null) {
        next = await fetchPage(page);
        if (!mounted.current || seq !== request.current) return;
        pages.current = page + 1;
        setData((old) => page && old ? { ...next, commitments: [...(old.commitments || []), ...(next.commitments || [])] } : next);
      } else {
        const rows = [];
        for (let i = 0; i < count; i++) {
          next = await fetchPage(i);
          if (!mounted.current || seq !== request.current) return;
          rows.push(...(next.commitments || []));
          if (!next.has_more) break;
        }
        pages.current = Math.max(1, Math.ceil(rows.length / PAGE) || 1);
        setData({ ...next, commitments: rows });
      }
      setError('');
    } catch (err) {
      if (!mounted.current || seq !== request.current) return;
      // A failed replacement read reports the cards disabled: the host must
      // not keep suppressing its own rows on a flag the cards no longer hold.
      setData((old) => old?.pending ? null : old);
      setError(err.message || 'Could not load follow-through.');
    } finally { if (seq === request.current) reading.current = false; }
  }, [fetchPage]);
  const refresh = useCallback(() => load({ count: pages.current }), [load]);
  // Actions resolve their post-action refresh through the latest filter, not
  // the closure they were started under (a hints change mid-flight would
  // otherwise repaint the previous filter and cancel the newer request).
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  useEffect(() => {
    mounted.current = true;
    pages.current = 1;
    // A filter change starts over: the rows and pagination of the previous
    // query never outlive it (a failed replacement read shows the error, not
    // the old filter's cards; there is no stale "Load more" to mix pages).
    // The enabled flag carries over so the host does not flip its own list
    // while the replacement read is pending.
    setData((old) => ({ callbacks_enabled: old?.callbacks_enabled, commitments: [], has_more: false, pending: true }));
    load({ page: 0 });
    const tick = () => { if (!document.hidden && !busyRef.current && !reading.current) refresh(); };
    const timer = setInterval(tick, pollMs);
    const clock = setInterval(() => setNow(Date.now()), 60000);
    window.addEventListener('focus', tick);
    return () => { mounted.current = false; request.current += 1; clearInterval(timer); clearInterval(clock); window.removeEventListener('focus', tick); };
  }, [load, refresh, pollMs]);
  const act = async (id, action, success = '') => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(id); setError(''); setNotice('');
    try {
      const result = await action();
      if (result?.success === false) throw new Error(result.error || 'The action could not finish.');
      if (mounted.current) setNotice(success);
      await refreshRef.current();
    } catch (err) {
      await refreshRef.current();
      if (mounted.current) setError(err.message || 'That action did not finish.');
    } finally { busyRef.current = false; if (mounted.current) setBusy(null); }
  };
  const { Card, Button, Text, Select, Link } = ui;
  const enabled = data?.callbacks_enabled === true;
  const callbacks = data?.commitments || [];
  const open = enabled ? callbacks.length : 0;
  // One judgement for the card and the host's count: the ledger's verdict,
  // or a deadline the local clock has passed since the last read.
  const isOverdue = (r) => r.overdue === true || (!!dueAt(r) && new Date(dueAt(r)).getTime() < now);
  const overdueCount = enabled ? callbacks.filter(isOverdue).length : 0;
  const hasMore = enabled && data?.has_more === true;
  useEffect(() => { onSummary?.({ enabled, open, overdue: overdueCount, hasMore }); }, [onSummary, enabled, open, overdueCount, hasMore]);
  if (!enabled && !error) return null;
  const snoozed = callbacks.filter((r) => r.snoozed_until && new Date(r.snoozed_until).getTime() > now);
  const renderCallback = (r) => {
    const due = dueAt(r);
    const overdue = isOverdue(r);
    return <Card key={r.id}>
      <Text tone="title">Call {who(r)}</Text>
      <Text tone={overdue || !due ? 'alert' : 'muted'}>{overdue ? 'Overdue · ' : 'Due '}{when(due)}</Text>
      <Text>{r.description}</Text>
      {r.evidence?.[0]?.quote && <Text>“{r.evidence[0].quote}”</Text>}
      {r.human_note && <Text>Note: {r.human_note}</Text>}
      {possiblyKept(r) && <Text tone="alert">Possibly kept: {humanize(possiblyKept(r).kind)}{possiblyKept(r).matched_at ? ` on ${when(possiblyKept(r).matched_at)}` : ''} · {humanize(possiblyKept(r).basis)} — confirm with Done</Text>}
      <Text tone="muted">{phone(r)} · Call {when(r.call_started_at)}{r.owner_name ? ` · ${r.owner_name}` : ''}</Text>
      {r.owner_name && r.owner_active === false && <Text tone="alert">Assigned to {r.owner_name}, who is no longer active — take this over</Text>}
      {snoozed.includes(r) && <Text tone="muted">Snoozed until {when(r.snoozed_until)}</Text>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!!busy || !phone(r)} onClick={() => act(r.id, () => adminFetch('/admin/communications/call', { method: 'POST', body: JSON.stringify({
          to: phone(r), customerId: r.customer_id || undefined, relatedCommitmentId: r.id, expected_at: r.updated_at,
        }) }), 'The staff phone is ringing. Press 1 to connect.')}>Call</Button>
        <Button secondary disabled={!!busy} onClick={() => act(r.id, () => patch(`${API}/commitments/${r.id}`, { action: 'fulfill', expected_at: r.updated_at }))}>Done</Button>
        <Button secondary disabled={!!busy} onClick={() => act(r.id, () => patch(`${API}/commitments/${r.id}`, { action: 'dismiss', expected_at: r.updated_at }))}>Dismiss</Button>
        <Select aria-label={`Snooze callback for ${who(r)}`} value="" disabled={!!busy} onChange={(e) => {
          const snooze = e.target.value;
          if (snooze) act(r.id, () => patch(`${API}/commitments/${r.id}`, { action: 'snooze', snooze, expected_at: r.updated_at }));
        }}><option value="">Snooze…</option><option value="two_hours">2 hours</option><option value="tomorrow">Next working morning</option></Select>
      </div>
      <Link href={`/admin/communications#tab=calls&call=${r.call_log_id}`}>Open call</Link>
    </Card>;
  };
  return <section aria-label="Follow-through" className="space-y-3 mb-5">
    <div className="flex items-center justify-between gap-2"><Text tone="title">Follow-through</Text><Button secondary disabled={!!busy} onClick={() => { if (!reading.current) refresh(); }}>Refresh</Button></div>
    {error && <div role="alert"><Text tone="alert">{error}</Text></div>}
    {notice && <div role="status"><Text>{notice}</Text></div>}
    {callbacks.filter((r) => !snoozed.includes(r)).map(renderCallback)}
    {snoozed.length > 0 && <details><summary className="cursor-pointer py-2">{snoozed.length} snoozed callback{snoozed.length === 1 ? '' : 's'}</summary><div className="space-y-3">{snoozed.map(renderCallback)}</div></details>}
    {enabled && !callbacks.length && <Text tone="muted">{EMPTY_TEXT[String(data.pending === true)]}</Text>}
    {data?.has_more && <Button secondary disabled={!!busy} onClick={() => load({ page: pages.current })}>Load more</Button>}
  </section>;
}
