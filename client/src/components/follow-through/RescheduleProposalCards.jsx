import { useCallback, useEffect, useRef, useState } from 'react';
import { adminFetch } from '../../utils/admin-fetch';
import { etDatetimeLocalToISO, formatETDate, formatETDateOnly, formatETTime } from '../../lib/timezone';

const API = '/admin/call-recordings/proposals';
const PAGE = 100;
const DEFAULT_POLL_MS = 30000;

const nameFor = (row) => [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Caller';
const humanize = (value) => String(value || '').replace(/_/g, ' ');
const dateOnly = (value) => String(value || '').slice(0, 10);

function dateTime(date, time) {
  if (!date || !time) return null;
  return etDatetimeLocalToISO(`${dateOnly(date)}T${String(time).slice(0, 5)}`);
}

function dateLabel(value) {
  return formatETDateOnly(dateOnly(value), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function timeLabel(value) {
  return value ? formatETTime(value) : 'time needs review';
}

function instantWindow(start, end) {
  if (!start) return 'Time needs review';
  return `${formatETDate(start, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}, ${timeLabel(start)}–${timeLabel(end)} ET`;
}

function arrivalWindow(date, start) {
  const from = dateTime(date, start);
  if (!from) return 'Time needs review';
  const to = new Date(new Date(from).getTime() + 120 * 60000).toISOString();
  return instantWindow(from, to);
}

function address(property) {
  if (!property) return 'Property needs review';
  return [property.address_line1, property.address_line2, property.city, property.state, property.zip].filter(Boolean).join(', ');
}

function candidateLabel(candidate) {
  const current = candidate.current_window
    ? instantWindow(candidate.current_window.start_at, candidate.current_window.end_at)
    : `${dateLabel(candidate.scheduled_date)} · time needs review`;
  return `${candidate.service_name || 'Service'} · ${current} · ${address(candidate.display_address)}`;
}

function occurrenceLabel(occurrence) {
  return `${staffWindow(occurrence.from_date, occurrence.from_start, occurrence.from_end)} → ${staffWindow(occurrence.to_date, occurrence.to_start, occurrence.to_end)}`;
}

function staffWindow(date, start, end) {
  return `${dateLabel(date)} at ${timeLabel(dateTime(date, start))}–${timeLabel(dateTime(date, end))} ET`;
}

function callTime(value) {
  if (!value) return 'time needs review';
  return `${formatETDate(value, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}, ${formatETTime(value)} ET`;
}

function resultMessage(result, row) {
  if (result?.outcome === 'applied') {
    return `Applied: ${nameFor(row)}'s appointment moved to ${arrivalWindow(result.newDate, result.newWindow?.start)}. No immediate message was sent; normal reminders continue. ${(result.warnings || []).join(' ')}`.trim();
  }
  if (result?.outcome === 'noop') return 'No appointment changed: it already matches the caller’s requested time. The proposal is resolved.';
  return '';
}

function skipMessage(reason) {
  const known = {
    already_applied: 'this request was already applied',
    changed_before_apply: 'the appointment changed before the move',
    handled_after_call: 'the request was handled after the call',
    prior_application_requires_review: 'an earlier application needs review',
  };
  return `Nothing changed: ${known[reason] || humanize(reason) || 'the request needs review'}. Review the refreshed proposal.`;
}

function validPreview(result, visitId) {
  if (!result) return false;
  const { selected, customer, series, overlap, new_window: target } = result;
  if ([selected, customer, series, overlap, target].some((value) => !value)) return false;
  const current = selected.current_window;
  return [
    result.visit_id === visitId, selected.id === visitId,
    /^[a-f0-9]{64}$/.test(String(result.preview_hash)),
    /^\d{4}-\d{2}-\d{2}$/.test(String(result.new_date)), target.start, target.end,
    selected.status, selected.scheduled_date, selected.service_name,
    selected.display_address?.address_line1, customer.id, String(result.quote || '').trim(),
    current === null || (current?.start_at && current?.end_at),
    typeof series.collective === 'boolean',
    series.collective !== true || (Array.isArray(series.occurrenceIds) && Array.isArray(series.occurrences)),
    Number.isInteger(overlap.count) && overlap.count >= 0,
    Array.isArray(overlap.appointments) && overlap.appointments.length === overlap.count,
  ].every(Boolean);
}

function CandidateReview({ candidates, selected, selection, busy, who, ui, onSelection, row }) {
  const { Select, Text } = ui;
  if (!candidates.length) return <Text tone="alert">No eligible appointment is available. Review this request in the schedule.</Text>;
  return <>
    <label className="block space-y-1">
      <Text tone="muted">Appointment discussed on the call</Text>
      <Select aria-label={`Appointment discussed for ${who}`} value={selection} disabled={!!busy}
        onChange={(event) => onSelection(row, event.target.value)}>
        {candidates.length > 1 && <option value="">Select the appointment discussed…</option>}
        {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidateLabel(candidate)}</option>)}
      </Select>
    </label>
    {selected && <Text tone="muted">Current appointment: {candidateLabel(selected)} · {humanize(selected.status)}</Text>}
    {selected && !selected.display_address?.address_line1 && <Text tone="alert">The appointment address needs review. Use the schedule editor.</Text>}
  </>;
}

function SeriesReview({ series, Text }) {
  const occurrences = series?.occurrences || [];
  if (series?.collective !== true) return <Text tone="muted">Appointment impact: only the selected appointment will move.</Text>;
  const movableCount = Number(series.movableCount) || occurrences.length;
  const skipped = Number(series.skippedCount) || 0;
  const exceptions = Number(series.exceptionCount) || 0;
  const conflicts = Number(series.conflictCount) || 0;
  return <>
    <Text tone="title">Recurring plan impact ({movableCount} visit{movableCount === 1 ? '' : 's'})</Text>
    <Text tone="muted">Booked service times are listed below. Each customer arrival window starts at the listed time and spans two hours.</Text>
    <div className="space-y-1">{occurrences.map((occurrence) => <Text key={occurrence.id}>{occurrenceLabel(occurrence)}</Text>)}</div>
    {skipped > 0 && <Text tone="muted">{skipped} in-progress or skipped visit{skipped === 1 ? '' : 's'} will stay put.</Text>}
    {exceptions > 0 && <Text tone="muted">{exceptions} date exception{exceptions === 1 ? '' : 's'} will move with the plan.</Text>}
    {conflicts > 0 && <Text tone="alert">{conflicts} landing date{conflicts === 1 ? '' : 's'} overlap another appointment.</Text>}
  </>;
}

function PreviewReview({ preview, who, Text }) {
  if (!preview) return null;
  return <div className="space-y-2" aria-label={`Preview for ${who}`}>
    <Text tone="title">Proposed change</Text>
    <Text>New arrival window: {arrivalWindow(preview.new_date, preview.new_window?.start)}</Text>
    {preview.from && <Text tone="muted">Staff booking: {staffWindow(preview.from.date, preview.from.start, preview.from.end)} → {staffWindow(preview.new_date, preview.new_window?.start, preview.new_window?.end)}</Text>}
    <SeriesReview series={preview.series} Text={Text} />
    {preview.overlap.count > 0 && <div className="space-y-1">
      <Text tone="alert">Selected appointment overlaps {preview.overlap.count} existing appointment{preview.overlap.count === 1 ? '' : 's'}:</Text>
      {preview.overlap.appointments.map((appointment) => <Text key={appointment.id} tone="alert">
        {appointment.service_name} · {instantWindow(appointment.current_window?.start_at, appointment.current_window?.end_at)} · {humanize(appointment.status)}
      </Text>)}
    </div>}
    <Text tone="muted">Schedule overlaps are advisory; both appointments remain on the calendar.</Text>
  </div>;
}


function ProposalCard({ row, ui, busy, selection, onSelection, preview, onPreview, onApply, onDismiss }) {
  const { Card, Button, Text, Link } = ui;
  const who = nameFor(preview?.customer || row);
  const candidates = (row.candidates || []).map((candidate) => candidate.id === preview?.selected.id ? preview.selected : candidate);
  const selected = candidates.find((candidate) => candidate.id === selection) || null;
  const requested = preview ? arrivalWindow(preview.new_date, preview.new_window.start)
    : instantWindow(row.requested_window?.start_at, row.requested_window?.end_at);
  const quote = preview?.quote || row.proposal?.quote;

  return <Card>
    <Text tone="title">Reschedule request · {who}</Text>
    <Text>Caller requested: {requested}</Text>
    {quote && <Text>Caller said: “{quote}”</Text>}
    <Text tone="muted">Call {callTime(row.call_at)}{row.phone ? ` · ${row.phone}` : ''}</Text>

    <CandidateReview {...{ candidates, selected, selection, busy, who, ui, onSelection, row }} />

    <PreviewReview preview={preview} who={who} Text={Text} />

    <div className="flex flex-wrap gap-2">
      <Button secondary={!!preview} disabled={!!busy || !selected?.display_address?.address_line1} onClick={() => onPreview(row, selected)}>{preview ? 'Refresh preview' : 'Preview change'}</Button>
      {preview && <Button disabled={!!busy} onClick={() => onApply(row, preview)}>Apply change</Button>}
      <Button secondary disabled={!!busy} onClick={() => onDismiss(row)}>Dismiss proposal</Button>
    </div>
    <Link href={`/admin/communications#tab=calls&call=${row.call_log_id}`}>Open call</Link>
  </Card>;
}

export default function RescheduleProposalCards({ ui, pollMs = DEFAULT_POLL_MS }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(null);
  const [selections, setSelections] = useState({});
  const [previews, setPreviews] = useState({});
  const request = useRef(0);
  const reading = useRef(false);
  const pages = useRef(1);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const dataRef = useRef(data);
  const selectionsRef = useRef(selections);
  const previewsRef = useRef(previews);
  const explicitSelectionsRef = useRef(new Set());

  const replacePreviews = useCallback((value) => {
    const next = typeof value === 'function' ? value(previewsRef.current) : value;
    previewsRef.current = next;
    setPreviews(next);
  }, []);

  useEffect(() => { selectionsRef.current = selections; }, [selections]);

  const reconcile = useCallback((rows, { invalidate = false } = {}) => {
    setSelections((old) => {
      const next = {};
      const retainedExplicit = new Set();
      for (const row of rows) {
        const candidateIds = new Set((row.candidates || []).map((candidate) => candidate.id));
        const prior = old[row.id];
        if (candidateIds.size > 1 && explicitSelectionsRef.current.has(row.id) && prior && candidateIds.has(prior)) {
          next[row.id] = prior;
          retainedExplicit.add(row.id);
        } else if (candidateIds.size === 1) next[row.id] = row.candidates[0].id;
        else next[row.id] = '';
      }
      explicitSelectionsRef.current = retainedExplicit;
      selectionsRef.current = next;
      return next;
    });
    replacePreviews((old) => {
      if (invalidate) return {};
      const next = {};
      for (const row of rows) {
        if (old[row.id]) next[row.id] = old[row.id];
      }
      return next;
    });
  }, [replacePreviews]);

  const fetchPage = useCallback((page) => adminFetch(`${API}?offset=${page * PAGE}`), []);
  const load = useCallback(async ({ page = null, count = 1, invalidate = true } = {}) => {
    const seq = ++request.current;
    reading.current = true;
    if (page == null && invalidate) replacePreviews({});
    try {
      let next;
      const firstPage = page ?? 0;
      const endPage = page == null ? count : firstPage + 1;
      const rows = page > 0 ? [...dataRef.current.proposals] : [];
      let fetchedThrough = firstPage;
      for (let index = firstPage; index < endPage; index += 1) {
        next = await fetchPage(index);
        if (!mounted.current || seq !== request.current) return;
        fetchedThrough = index + 1;
        rows.push(...next.proposals);
        if (!next.has_more) break;
      }
      pages.current = Math.max(1, fetchedThrough);
      const merged = { ...next, proposals: rows };
      dataRef.current = merged;
      setData(merged);
      reconcile(rows, { invalidate: page == null && invalidate });
      setError('');
    } catch (err) {
      if (mounted.current && seq === request.current) setError(err.message || 'Could not load reschedule proposals.');
    } finally {
      if (seq === request.current) reading.current = false;
    }
  }, [fetchPage, reconcile, replacePreviews]);

  const refresh = useCallback(() => load({ count: pages.current }), [load]);
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    load({ page: 0, invalidate: false });
    const tick = () => {
      const reviewing = Object.values(previewsRef.current).some(Boolean);
      if (!document.hidden && !busyRef.current && !reading.current && !reviewing) refreshRef.current();
    };
    const timer = setInterval(tick, pollMs);
    window.addEventListener('focus', tick);
    return () => {
      mounted.current = false;
      request.current += 1;
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, [fetchPage, load, pollMs]);

  const begin = (id) => {
    if (busyRef.current) return false;
    // An action owns the card snapshot from here. A list read that started
    // earlier may still finish, but its sequence can no longer repaint this
    // review with rows fetched before the action began.
    request.current += 1;
    reading.current = false;
    busyRef.current = true;
    setBusy(id);
    setError('');
    setNotice('');
    return true;
  };
  const finish = () => {
    busyRef.current = false;
    if (mounted.current) setBusy(null);
  };
  const refreshAfterError = async (message) => {
    if (!mounted.current) return;
    replacePreviews({});
    await refreshRef.current();
    if (mounted.current) setError(message);
  };
  const select = (row, visitId) => {
    if (visitId) explicitSelectionsRef.current.add(row.id);
    else explicitSelectionsRef.current.delete(row.id);
    selectionsRef.current = { ...selectionsRef.current, [row.id]: visitId };
    setSelections(selectionsRef.current);
    replacePreviews((old) => ({ ...old, [row.id]: null }));
    setError('');
    setNotice('');
  };
  const preview = async (row, candidate) => {
    if (!candidate || !begin(row.id)) return;
    const selectedId = candidate.id;
    replacePreviews((old) => ({ ...old, [row.id]: null }));
    try {
      const result = await adminFetch(`${API}/${row.id}/preview`, {
        method: 'POST', body: JSON.stringify({ visit_id: selectedId }),
      });
      if (!mounted.current || selectionsRef.current[row.id] !== selectedId) return;
      if (!validPreview(result, selectedId)) throw new Error('The preview was incomplete. Refresh and try again.');
      replacePreviews((old) => ({ ...old, [row.id]: result }));
    } catch (err) {
      if (mounted.current) setError(err.message || 'Could not preview this change.');
    } finally { finish(); }
  };
  const apply = async (row, reviewed) => {
    if (!begin(row.id)) return;
    try {
      const result = await adminFetch(`${API}/${row.id}/apply`, {
        method: 'POST', body: JSON.stringify({ visit_id: reviewed.visit_id, preview_hash: reviewed.preview_hash }),
      });
      if (!mounted.current) return;
      replacePreviews((old) => ({ ...old, [row.id]: null }));
      if (result?.outcome === 'skipped') {
        const message = skipMessage(result.reason);
        await refreshRef.current();
        if (mounted.current) setError(message);
      } else {
        const message = resultMessage(result, reviewed.customer);
        if (!message) throw new Error('The server did not confirm the appointment change.');
        setNotice(message);
        await refreshRef.current();
      }
    } catch (err) {
      await refreshAfterError(err.message || 'The proposal was not applied.');
    } finally { finish(); }
  };
  const dismiss = async (row) => {
    if (!begin(row.id)) return;
    try {
      await adminFetch(`${API}/${row.id}/dismiss`, {
        method: 'POST', body: JSON.stringify({ expected_at: row.updated_at }),
      });
      if (!mounted.current) return;
      setNotice('Dismissed the reschedule proposal. No appointment changed.');
      await refreshRef.current();
    } catch (err) {
      await refreshAfterError(err.message || 'The proposal was not dismissed.');
    } finally { finish(); }
  };

  const { Button, Text } = ui;
  const enabled = data?.proposals_enabled === true;
  const proposals = data?.proposals || [];
  if (!enabled && !error) return null;

  return <section aria-label="Reschedule proposals" className="space-y-3 mb-5">
    <div className="flex items-center justify-between gap-2">
      <Text tone="title">Reschedule proposals</Text>
      <Button secondary disabled={!!busy} onClick={() => { if (!reading.current) refresh(); }}>Refresh</Button>
    </div>
    {error && <div role="alert"><Text tone="alert">{error}</Text></div>}
    {notice && <div role="status"><Text>{notice}</Text></div>}
    {proposals.map((row) => <ProposalCard
      key={row.id}
      row={row}
      ui={ui}
      busy={busy}
      selection={selections[row.id] || ''}
      onSelection={select}
      preview={previews[row.id] || null}
      onPreview={preview}
      onApply={apply}
      onDismiss={dismiss}
    />)}
    {enabled && !proposals.length && <Text tone="muted">No reschedule proposals need review.</Text>}
    {data?.has_more && <Button secondary disabled={!!busy} onClick={() => load({ page: pages.current, invalidate: false })}>Load more proposals</Button>}
  </section>;
}
