import { useId } from 'react';
import { adminFetch } from '../../lib/adminFetch';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Textarea } from '../ui/Textarea';
import { etDateString, formatETDateTime } from '../../lib/timezone';

export async function request(path, options = {}) {
  const response = await adminFetch(`/tech/pay-growth${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Unable to load pay and growth (${response.status}).`);
  return data;
}
// Tech-portal links keep the active visit (?visit=) so TechFieldShell can offer "Return to visit".
export function withVisit(path, search) {
  const visit = new URLSearchParams(search || '').get('visit');
  return visit ? `${path}?visit=${encodeURIComponent(visit)}` : path;
}
export const money = cents => cents == null ? 'Not calculated' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
export const date = value => value ? (/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : etDateString(new Date(value))) : '';
export const words = value => String(value || 'not recorded').replaceAll('_', ' ');
export const numeric = value => value === '' ? null : Number(value);
export const dollarCents = value => value === '' ? null : Math.round(Number(value) * 100);
export const percentBps = value => value === '' ? null : Math.round(Number(value) * 100);

export function Field({ label, hint, type = 'text', options, multiline = false, ...props }) {
  const id = useId();
  const shared = { id, 'aria-describedby': hint ? `${id}-hint` : undefined, ...props };
  return <div className="pg-field"><label htmlFor={id}>{label}</label>
    {options ? <Select {...shared}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select>
      : multiline ? <Textarea rows={3} {...shared} /> : <Input type={type} {...shared} />}
    {hint && <small id={`${id}-hint`}>{hint}</small>}
  </div>;
}
export function Status({ status }) { return <span className="pg-status">{words(status)}</span>; }

export function EvidenceRow({ entry, onReview }) {
  const calculation = entry.calculation;
  return <details className="pg-record">
    <summary><span><strong>{entry.service_label}</strong><small>{entry.service_date} · revision {entry.revision}</small></span><span className="pg-record-value">{money(calculation.amount_cents)}<Status status={calculation.status} /></span></summary>
    <div className="pg-record-body">
      {calculation.status === 'simulated' && <p className="pg-formula">{money(calculation.value_cents)} credited value × {calculation.rate_bps / 100}% = <strong>{money(calculation.amount_cents)} simulated</strong></p>}
      {calculation.reason && <p>{calculation.reason}</p>}
      <dl className="pg-facts">
        <div><dt>Service key</dt><dd>{entry.service_key || 'Unmapped'}</dd></div>
        <div><dt>Employee share</dt><dd>{entry.facts.participants[0]?.share_bps / 100}%</dd></div>
        <div><dt>Calendar week (Monday)</dt><dd>{entry.workweek_start}</dd></div>
        <div><dt>Source</dt><dd>{entry.facts.source_reference}</dd></div>
        <div><dt>Complete at cutoff</dt><dd>{entry.facts.complete_at_cutoff == null ? 'Not observed' : entry.facts.complete_at_cutoff ? 'Yes' : 'No'}</dd></div>
        <div><dt>Evidence cutoff (Eastern)</dt><dd>{entry.facts.cutoff_at ? formatETDateTime(new Date(entry.facts.cutoff_at)) : 'Not recorded'}</dd></div>
        <div><dt>Substantive repair</dt><dd>{words(entry.facts.repair_reason)}{entry.facts.repair_reference && ` · ${entry.facts.repair_reference}`}</dd></div>
        <div><dt>Rework review</dt><dd>{words(entry.facts.rework_outcome)}{entry.facts.rework_reference && ` · ${entry.facts.rework_reference}`}</dd></div>
        <div><dt>Reviewed by</dt><dd>{entry.reviewer_name} · {formatETDateTime(new Date(entry.created_at))}</dd></div>
      </dl>
      {onReview && <button type="button" className="pg-text-button" onClick={() => onReview(entry.service_id)}>Record a reviewed revision</button>}
    </div>
  </details>;
}
