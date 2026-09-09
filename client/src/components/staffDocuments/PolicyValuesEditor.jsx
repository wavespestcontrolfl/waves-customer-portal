import { useEffect, useState } from 'react';
import { etDatetimeLocalValue } from '../../lib/timezone';
import { box, row, inputStyle, primaryStyle, buttonStyle, Field, request, dateLabel } from './common';

const EMPTY = { pay_frequency: '', pay_schedule: '', pto_accrual: [], paid_holidays: [], unpaid_holidays: [], equipment_deduction_terms: '' };

export default function PolicyValuesEditor({ onClose, onSaved }) {
  const [revisions, setRevisions] = useState(null);
  const [values, setValues] = useState(EMPTY);
  const [effective, setEffective] = useState(etDatetimeLocalValue(new Date(Date.now() + 5 * 60000)));
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    request('/policy-values', undefined, controller.signal).then(result => {
      setRevisions(result.revisions); const current = result.revisions[0]?.values || EMPTY;
      setValues(current);
    }).catch(failure => { if (failure.name !== 'AbortError') setError(failure.message); });
    return () => controller.abort();
  }, []);
  async function save(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await request('/policy-values', { base_revision_id: revisions[0]?.id || null, effective_at: effective, values: { ...values, pto_accrual: values.pto_accrual.map(tier => ({ after_years: Number(tier.after_years), hours_per_year: Number(tier.hours_per_year) })), paid_holidays: values.paid_holidays.map(value => value.trim()).filter(Boolean), unpaid_holidays: values.unpaid_holidays.map(value => value.trim()).filter(Boolean) } });
      onSaved(`Policy revision ${result.policy.revision} issued; ${result.revised_version_ids.length} document versions created.`);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <form style={box} onSubmit={save}>
    <h2 style={{ fontSize: 20, marginTop: 0 }}>Shared policy values</h2>
    <p>Issuing changes every published document that uses these values. Each gets a new version; old copies and signatures retain their original terms. All affected documents must pass their ownership and review checks.</p>
    {error && <p role="alert">{error}</p>}
    {!revisions ? <p>Loading policy values…</p> : <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
      <Field label="Pay frequency"><select required style={inputStyle} value={values.pay_frequency} onChange={e => setValues({ ...values, pay_frequency: e.target.value })}><option value="">Select approved frequency</option>{['weekly', 'biweekly', 'semi-monthly', 'monthly'].map(value => <option key={value}>{value}</option>)}</select></Field>
      <Field label="Pay dates and processing rules"><textarea required style={inputStyle} value={values.pay_schedule} onChange={e => setValues({ ...values, pay_schedule: e.target.value })} /></Field>
      <h3>PTO accrual schedule</h3>
      {values.pto_accrual.map((tier, index) => <div key={index} style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr auto', alignItems: 'center' }}>
        <Field label="After years of service"><input required type="number" min="0" max="60" step="any" style={inputStyle} value={tier.after_years} onChange={e => setValues({ ...values, pto_accrual: values.pto_accrual.map((item, i) => i === index ? { ...item, after_years: e.target.value } : item) })} /></Field>
        <Field label="Hours per year"><input required type="number" min="0" max="2080" step="any" style={inputStyle} value={tier.hours_per_year} onChange={e => setValues({ ...values, pto_accrual: values.pto_accrual.map((item, i) => i === index ? { ...item, hours_per_year: e.target.value } : item) })} /></Field>
        <button type="button" style={buttonStyle} onClick={() => setValues({ ...values, pto_accrual: values.pto_accrual.filter((_, i) => i !== index) })} aria-label={`Remove PTO tier ${index + 1}`}>Remove</button>
      </div>)}
      <button type="button" style={{ ...buttonStyle, marginBottom: 16 }} onClick={() => setValues({ ...values, pto_accrual: [...values.pto_accrual, { after_years: '', hours_per_year: '' }] })}>Add accrual tier</button>
      <Field label="Paid holidays (one per line; empty means none)"><textarea rows={4} style={inputStyle} value={values.paid_holidays.join('\n')} onChange={e => setValues({ ...values, paid_holidays: e.target.value.split('\n') })} /></Field>
      <Field label="Unpaid holidays (one per line; empty means none)"><textarea rows={4} style={inputStyle} value={values.unpaid_holidays.join('\n')} onChange={e => setValues({ ...values, unpaid_holidays: e.target.value.split('\n') })} /></Field>
      <Field label="Approved equipment deduction terms"><textarea required rows={6} style={inputStyle} value={values.equipment_deduction_terms} onChange={e => setValues({ ...values, equipment_deduction_terms: e.target.value })} /></Field>
      <Field label="Effective date and time (Eastern)"><input type="datetime-local" required style={inputStyle} value={effective} onChange={e => setEffective(e.target.value)} /></Field>
      <label style={{ ...row, margin: '18px 0' }}><input required type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I approve these terms and their application to all bound documents.</label>
      <div style={row}><button type="submit" style={primaryStyle} disabled={!confirmed}>{busy ? 'Issuing…' : 'Issue policy revision'}</button><button type="button" style={buttonStyle} onClick={onClose}>Close</button></div>
      <h3>Policy history</h3>
      {!revisions.length && <p>No policy values have been issued.</p>}
      {revisions.map(revision => <details key={revision.id} style={{ marginTop: 12 }}><summary>Revision {revision.revision} · {dateLabel(revision.effective_at)}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 14 }}>{JSON.stringify(revision.values, null, 2)}</pre><p style={{ overflowWrap: 'anywhere' }}>SHA-256: {revision.content_hash}</p></details>)}
    </fieldset>}
  </form>;
}
