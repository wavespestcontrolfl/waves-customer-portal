import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Field, request, dollarCents, date } from './common';

export default function BusinessEditor({ technicianId, month, initial, onCancel, onSaved }) {
  const facts = initial?.facts;
  const [data, setData] = useState(() => ({ id: crypto.randomUUID(), estimate_id: initial?.estimate_id || '', baseline: facts ? String(facts.baseline_cents / 100) : '0', accepted_net: facts ? String(facts.accepted_net_cents / 100) : '', source_reference: facts?.source_reference || '', activation_date: facts?.activation_date || '', payment_reference: facts?.payment_reference || '', retained_at_90: facts?.retained_at_90 == null ? '' : String(facts.retained_at_90), retention_reference: facts?.retention_reference || '' }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [estimates, setEstimates] = useState([]);
  useEffect(() => {
    const controller = new AbortController();
    request(`/estimates?${new URLSearchParams({ month })}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setEstimates(result.estimates);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [month]);
  const change = (key, value) => setData(current => ({ ...current, [key]: value }));
  async function save(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const { baseline, accepted_net, ...body } = data;
      await request('/new-business', { method: 'POST', body: { ...body, base_id: initial?.id || null, technician_id: technicianId, baseline_cents: dollarCents(baseline), accepted_net_cents: dollarCents(accepted_net), activation_date: data.activation_date || null, retained_at_90: data.retained_at_90 === '' ? null : data.retained_at_90 === 'true' } });
      onSaved('New-business evidence saved with the originating technician.');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <form className="pg-card pg-form" onSubmit={save}><h2>{initial ? 'Commission milestone review' : 'New-business origination'}</h2><p>The selected employee is the originating technician. The estimate’s creator or closer does not replace them.</p>{error && <p role="alert" className="pg-error">{error}</p>}<fieldset disabled={busy}>
    <Field label="Accepted estimate" required disabled={!!initial} value={data.estimate_id} options={[{ value: '', label: 'Choose an accepted estimate…' }, ...estimates.map(estimate => ({ value: estimate.id, label: `${date(estimate.accepted_at)} · ${estimate.customer_name || 'Accepted estimate'}` })), ...(initial && !estimates.some(estimate => estimate.id === initial.estimate_id) ? [{ value: initial.estimate_id, label: `Recorded estimate · accepted ${date(initial.accepted_date)}` }] : [])]} onChange={event => change('estimate_id', event.target.value)} hint="Use the retained accepted estimate, including its net discounts and service scope." />
    <div className="pg-form-grid"><Field label="Original revenue baseline ($)" type="number" min="0" max="1000000" step="0.01" required value={data.baseline} onChange={event => change('baseline', event.target.value)} /><Field label="Accepted net value, including baseline ($)" type="number" min="0" max="1000000" step="0.01" required value={data.accepted_net} onChange={event => change('accepted_net', event.target.value)} /></div>
    <Field label="Origination and incremental-value evidence" multiline required maxLength={2000} value={data.source_reference} onChange={event => change('source_reference', event.target.value)} />
    <div className="pg-form-grid"><Field label="Activation date" type="date" value={data.activation_date} onChange={event => change('activation_date', event.target.value)} /><Field label="Qualifying payment evidence" maxLength={2000} value={data.payment_reference} onChange={event => change('payment_reference', event.target.value)} /></div>
    <Field label="Retained at the 90-day milestone" value={data.retained_at_90} options={[{ value: '', label: 'Not reviewed / not due' }, { value: 'true', label: 'Yes · verified' }, { value: 'false', label: 'No · reviewed' }]} onChange={event => change('retained_at_90', event.target.value)} /><Field label="90-day review evidence" multiline maxLength={2000} value={data.retention_reference} onChange={event => change('retention_reference', event.target.value)} />
    <div className="pg-form-actions"><Button variant="secondary" onClick={onCancel}>Cancel</Button><Button type="submit" loading={busy}>Save new-business evidence</Button></div>
  </fieldset></form>;
}
