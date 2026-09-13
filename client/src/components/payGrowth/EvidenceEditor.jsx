import { useEffect, useState } from 'react';
import { etDatetimeLocalValue, etDatetimeLocalToISO } from '../../lib/timezone';
import { Button } from '../ui/Button';
import { Field, request, numeric, dollarCents, percentBps, date, words } from './common';

function AllocationForm({ visit, onCreated, onCancel, onBusy }) {
  const [data, setData] = useState(() => ({ id: crypto.randomUUID(), coverage_start: visit.service_date, coverage_end: visit.service_date, credit_type: 'routine', net_value: '', planned_visits: '1', source_reference: '' }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = (key, value) => setData(current => ({ ...current, [key]: value }));
  async function save(event) {
    event.preventDefault(); setBusy(true); onBusy(true); setError('');
    try {
      const { net_value, planned_visits, ...body } = data;
      const allocation = await request('/allocations', { method: 'POST', body: { ...body, customer_id: visit.customer_id, property_id: visit.property_id, service_key: visit.service_key, planned_visits: Number(planned_visits), net_value_cents: dollarCents(net_value) } });
      onCreated(allocation, visit.id);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); onBusy(false); }
  }
  return <form className="pg-card pg-form" onSubmit={save}><h3>Accepted service-value allocation</h3><p>Enter the net value after discounts for this service line, its coverage period, and the original scheduled application count. Cancellations do not redistribute the value.</p>{error && <p role="alert" className="pg-error">{error}</p>}<fieldset disabled={busy}>
    <p>Service: {visit.service_key || 'Unmapped'}</p><div className="pg-form-grid"><Field label="Coverage begins" type="date" required value={data.coverage_start} onChange={event => change('coverage_start', event.target.value)} /><Field label="Coverage ends" type="date" required value={data.coverage_end} onChange={event => change('coverage_end', event.target.value)} /><Field label="Accepted net service-line value ($)" type="number" min="0" max="1000000" step="0.01" required value={data.net_value} onChange={event => change('net_value', event.target.value)} /><Field label="Original scheduled application count" type="number" min="1" max="366" required value={data.planned_visits} onChange={event => change('planned_visits', event.target.value)} /></div>
    <Field label="Allocation type" value={data.credit_type} options={[{ value: 'routine', label: 'Equivalent routine applications' }, { value: 'specialty', label: 'Separately priced specialty work' }]} onChange={event => change('credit_type', event.target.value)} /><Field label="Accepted scope / price evidence" multiline required maxLength={2000} value={data.source_reference} onChange={event => change('source_reference', event.target.value)} />
    <div className="pg-form-actions"><Button variant="secondary" onClick={onCancel}>Cancel allocation</Button><Button type="submit" disabled={!visit.service_key} loading={busy}>Retain allocation</Button></div>
  </fieldset></form>;
}

// The server forces the exclusion for callbacks, included follow-ups and always-free
// visit types; excluded evidence can never claim an application from an allocation.
const forcedExclusion = visit => visit.forced_exclusion || (visit.is_callback ? 'corrective' : 'none');
const EXCLUSION_NOTES = {
  corrective: 'Callback visits are corrective: they receive zero production credit and never claim an application from an accepted-value allocation.',
  planned_followup: 'This service is an included follow-up or an always-free visit type: it receives zero production credit and never claims an application from an accepted-value allocation.',
};
// Why the exclusion selector is locked: a claimed allocation must stay claimed on this review.
// A retained (locked) allocation is exempt: the server keeps it while the classification is corrected.
function exclusionLock(data, created, excluded, retained) {
  const claimed = Boolean(data?.allocation_id) && !excluded && !retained;
  if (!claimed) return { disabled: false, hint: undefined };
  const fresh = created.includes(data.allocation_id);
  return { disabled: true, fresh, hint: fresh ? 'This review must claim the allocation it retained; exclusions are unavailable.' : 'Clear the allocation to record an exclusion.' };
}
const exclusionNote = visit => EXCLUSION_NOTES[forcedExclusion(visit)] || 'This service is excluded from production credit and never claims an application from an accepted-value allocation.';

function evidenceForm(detail) {
  const previous = detail.revisions[0] || {};
  // A forced exclusion suppresses a NEW claim; a revision of already-allocated evidence must keep its allocation and ordinal.
  const forced = forcedExclusion(detail.visit);
  const excluded = forced !== 'none' && previous.allocation_id == null;
  const defaults = {
    participants: [{ technician_id: detail.visit.technician_id || '', share_bps: 10000 }],
    provenance: 'verified', source_reference: '', exclusion: forcedExclusion(detail.visit),
    cutoff_at: '', complete_at_cutoff: '', repair_reason: 'unresolved', repair_reference: '',
    rework_outcome: 'unobserved', return_service_id: '', same_issue_confirmed: false, rework_reference: '',
  };
  const facts = previous.facts || {};
  const fields = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, facts[key] ?? fallback]));
  // Mirror the server: callbacks are always corrective; a free visit only replaces a 'none' classification, never a retained manual one.
  if (forced === 'corrective' || (forced !== 'none' && fields.exclusion === 'none')) fields.exclusion = forced;
  return { ...fields, id: crypto.randomUUID(), service_id: detail.visit.id, base_id: previous.id || null,
    allocation_id: excluded ? '' : previous.allocation_id || '', ordinal: excluded || previous.ordinal == null ? '' : String(previous.ordinal),
    cutoff_at: fields.cutoff_at ? etDatetimeLocalValue(new Date(fields.cutoff_at)) : '', complete_at_cutoff: String(fields.complete_at_cutoff),
  };
}

export default function EvidenceEditor({ technicianId, month, serviceId = '', people, onCancel, onSaved }) {
  const [visits, setVisits] = useState([]);
  const [selected, setSelected] = useState(serviceId);
  const [{ detail, data }, setReview] = useState({ detail: null, data: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newAllocation, setNewAllocation] = useState(false);
  // Allocations retained from this review are append-only: this review must claim them, so they lock the selector and the exclusion.
  const [created, setCreated] = useState([]);
  const [allocationSaving, setAllocationSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    request(`/visits?${new URLSearchParams({ technicianId, month })}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setVisits(result.visits);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [technicianId, month]);
  useEffect(() => {
    setReview({ detail: null, data: null }); setError(''); setNewAllocation(false); setAllocationSaving(false);
    if (!selected) return undefined;
    const controller = new AbortController();
    request(`/services/${selected}/evidence`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setReview({ detail: result, data: evidenceForm(result) });
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [selected]);
  const change = (key, value) => setReview(current => ({ ...current, data: { ...current.data, [key]: value } }));
  async function save(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await request('/service-evidence', { method: 'POST', body: { ...data,
        allocation_id: excluded ? null : data.allocation_id || null, ordinal: excluded ? null : numeric(data.ordinal), // excluded = forced exclusion without a retained allocation
        cutoff_at: data.cutoff_at ? etDatetimeLocalToISO(data.cutoff_at) : null,
        complete_at_cutoff: data.complete_at_cutoff === '' ? null : data.complete_at_cutoff === 'true', return_service_id: data.return_service_id || null,
      } });
      onSaved('Service evidence and its simulation calculations have been retained.');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  const visitOptions = new Map(visits.map(visit => [visit.id, { value: visit.id, label: `${date(visit.scheduled_date)} · ${visit.service_type} · ${words(visit.status)}` }]));
  if (detail) visitOptions.set(selected, { value: selected, label: `${detail.visit.service_date} · ${detail.visit.service_type} · ${words(detail.visit.status)}` });
  const options = [{ value: '', label: 'Choose a performed service…' }, ...visitOptions.values()];
  const allocationLocked = detail?.revisions.some(revision => revision.allocation_id != null);
  const forced = Boolean(detail) && forcedExclusion(detail.visit) !== 'none';
  // Any excluded first review (forced or reviewer-selected) cannot claim a new allocation; a retained one is kept.
  const excluded = Boolean(detail) && (forced || data.exclusion !== 'none') && !allocationLocked;
  const lock = exclusionLock(data, created, excluded, allocationLocked);
  // A pool retained from this review stays unclaimed until the evidence saves: leaving or switching would strand it.
  const held = allocationSaving || Boolean(lock.fresh);
  // Only pools whose coverage contains the service date can be claimed; a retained selection stays listed.
  const claimable = row => row.id === data?.allocation_id || (date(row.coverage_start) <= detail.visit.service_date && detail.visit.service_date <= date(row.coverage_end));
  return <section className="pg-card pg-form"><div className="pg-row"><h2>Review service evidence</h2><Button variant="secondary" disabled={busy || held} onClick={onCancel}>Close review</Button></div>{error && <p role="alert" className="pg-error">{error}</p>}
    <Field label="Performed service" options={options} disabled={busy || held} value={selected} onChange={event => setSelected(event.target.value)} />
    {selected && !detail && !error && <p role="status">Loading service evidence…</p>}
    {detail && <>
      <p className="pg-muted">{detail.visit.service_key || 'Unmapped service key'} · {detail.revisions.length ? `${detail.revisions.length} retained revisions` : 'First review'}. A no-application decision is assessed against the purchased scope.</p>
      {detail.visit.status !== 'completed' && <p className="pg-error">This service appears performed but is not marked complete. Resolve its completion record before calculating credit.</p>}
      {forced && <p className="pg-muted">{exclusionNote(detail.visit)}</p>}
      {!excluded && !newAllocation && !allocationLocked && <Button variant="secondary" disabled={!detail.visit.service_key || busy} onClick={() => setNewAllocation(true)}>Add accepted value allocation</Button>}
      {newAllocation && <AllocationForm visit={detail.visit} onBusy={setAllocationSaving} onCancel={() => setNewAllocation(false)} onCreated={(allocation, serviceId) => {
        // The service selector is disabled while the save is pending; this guard keeps a late response from another service out of this review.
        setReview(current => current.detail?.visit.id === serviceId ? { detail: { ...current.detail, allocations: [allocation, ...current.detail.allocations] }, data: { ...current.data, allocation_id: allocation.id, ordinal: '1' } } : current);
        setCreated(current => [...current, allocation.id]);
        setNewAllocation(false);
      }} />}
      <form onSubmit={save}><fieldset disabled={busy || newAllocation || detail.visit.status !== 'completed'}>
        {!excluded && <div className="pg-form-grid"><Field label="Service-value allocation" value={data.allocation_id} disabled={allocationLocked || Boolean(lock.fresh)} options={[{ value: '', label: 'Not yet recorded' }, ...detail.allocations.filter(claimable).map(row => ({ value: row.id, label: `${date(row.coverage_start)} – ${date(row.coverage_end)} · $${(row.net_value_cents / 100).toFixed(2)} / ${row.planned_visits} applications` }))]} onChange={event => { change('allocation_id', event.target.value); change('ordinal', event.target.value ? '1' : ''); }} /><Field label="Application number in original allocation" type="number" min="1" max="366" disabled={allocationLocked || !data.allocation_id} value={data.ordinal} onChange={event => change('ordinal', event.target.value)} /></div>}
        <div className="pg-form-grid"><Field label="Value provenance" value={data.provenance} options={['verified', 'backfilled', 'synthetic'].map(value => ({ value, label: words(value) }))} onChange={event => change('provenance', event.target.value)} /><Field label="Production exclusion" value={data.exclusion} disabled={lock.disabled} hint={lock.hint} options={['none', 'corrective', 'planned_followup', 'duplicate', 'unnecessary', 'inspection'].map(value => ({ value, label: words(value) }))} onChange={event => change('exclusion', event.target.value)} /></div>
        <Field label="Service and credited-value evidence" multiline required maxLength={2000} value={data.source_reference} onChange={event => change('source_reference', event.target.value)} />
        <h3>Employee credit shares</h3>{data.participants.map((participant, index) => <div className="pg-form-row" key={index}><div className="pg-form-grid"><Field label={`Employee ${index + 1}`} disabled={!!data.base_id} value={participant.technician_id} options={[{ value: '', label: 'Choose employee…' }, ...people.map(person => ({ value: person.id, label: person.name }))]} onChange={event => change('participants', data.participants.map((item, i) => i === index ? { ...item, technician_id: event.target.value } : item))} /><Field label={`Employee ${index + 1} share (%)`} type="number" min="0.01" max="100" step="0.01" required disabled={!!data.base_id} value={participant.share_bps == null ? '' : participant.share_bps / 100} onChange={event => change('participants', data.participants.map((item, i) => i === index ? { ...item, share_bps: percentBps(event.target.value) } : item))} /></div>{!data.base_id && index > 0 && <Button variant="secondary" onClick={() => change('participants', data.participants.filter((_, i) => i !== index))}>Remove employee {index + 1}</Button>}</div>)}
        {!data.base_id && <Button variant="secondary" disabled={data.participants.length >= 10} onClick={() => change('participants', [...data.participants, { technician_id: '', share_bps: null }])}>Split credit with another employee</Button>}
        <p className="pg-muted">Shares must total 100%. A shared stop cannot create two full production credits.</p>
        <h3>Clean handoff</h3><div className="pg-form-grid"><Field label="Agreed completeness cutoff (Eastern)" type="datetime-local" value={data.cutoff_at} onChange={event => change('cutoff_at', event.target.value)} /><Field label="Complete at that cutoff" value={data.complete_at_cutoff} options={[{ value: '', label: 'Not observed' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} onChange={event => change('complete_at_cutoff', event.target.value)} /></div>
        <Field label="Substantive repair reason" value={data.repair_reason} options={['unresolved', 'none', 'technician_omission', 'office_change', 'customer_change', 'software_issue'].map(value => ({ value, label: words(value) }))} onChange={event => change('repair_reason', event.target.value)} /><Field label="Repair reason evidence" multiline maxLength={2000} value={data.repair_reference} onChange={event => change('repair_reference', event.target.value)} hint="Wording improvements and delivery failures are not technician defects. Office, customer, and software reasons need supporting evidence." />
        <h3>Avoidable rework</h3><Field label="Reviewed responsibility" value={data.rework_outcome} options={['unobserved', 'no_return', 'technician_execution', 'protocol', 'scheduling', 'customer', 'other', 'unresolved'].map(value => ({ value, label: words(value) }))} onChange={event => change('rework_outcome', event.target.value)} />
        <Field label="Qualifying return service (if any)" value={data.return_service_id} options={[{ value: '', label: 'No qualifying return recorded' }, ...detail.returns.map(visit => ({ value: visit.id, label: `${date(visit.scheduled_date)} · ${visit.service_type}` }))]} onChange={event => change('return_service_id', event.target.value)} /><Field label="Same property, service scope, and issue confirmed" value={String(data.same_issue_confirmed)} options={[{ value: 'false', label: 'Not confirmed' }, { value: 'true', label: 'Confirmed by reviewer' }]} onChange={event => change('same_issue_confirmed', event.target.value === 'true')} /><Field label="Rework review evidence" multiline maxLength={2000} value={data.rework_reference} onChange={event => change('rework_reference', event.target.value)} />
        <div className="pg-form-actions"><Button variant="secondary" disabled={held} onClick={onCancel}>Cancel</Button><Button type="submit" loading={busy}>Retain service evidence</Button></div>
      </fieldset></form>
    </>}
  </section>;
}
