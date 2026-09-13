import { useState } from 'react';
import { etDateString } from '../../lib/timezone';
import { Button } from '../ui/Button';
import { Field, money, words, date, Status, request } from './common';

const PATH_NOTES = {
  trainee: 'Supervised development with predominantly guaranteed hourly pay. The trainee pay band remains open.',
  technician_i: 'Build sustained, verified service outcomes and practical competence.',
  technician_ii: 'Highest field title. Advanced diagnosis, calibration, troubleshooting, and additional service competence. No management vacancy is required for this step.',
  service_manager: 'Paid management development: coaching, coordination, exception handling, and team results. Qualification and position availability are separate.',
  general_manager: 'Demonstrate readiness to lead day-to-day business operations. Qualification and an available position are separate.',
};

function AssessmentForm({ view, previous, onCancel, onSaved }) {
  const roles = view.program.roles;
  const roleTitle = key => roles.find(role => role.key === key)?.title || words(key);
  // The server accepts only the level in effect on the assessed date as the starting role —
  // for a reassessment too, which therefore needs a date on which the original step's
  // starting role was still in effect.
  const roleOn = day => view.levels.find(row => date(row.effective_date) <= day)?.role_key || null;
  const today = etDateString(new Date());
  const earliest = previous ? date(previous.assessed_date) : undefined;
  const nextStep = key => roles[Math.min(roles.findIndex(role => role.key === key) + 1, roles.length - 1)].key;
  const [data, setData] = useState(() => ({
    id: crypto.randomUUID(), technician_id: view.person.id, previous_id: previous?.id || null,
    to_role: previous?.to_role || nextStep(roleOn(today) || 'trainee'),
    assessed_date: today, rubric_version: previous?.rubric_version || '',
    items: previous ? previous.assessment.items.map(item => ({ ...item, result: 'not_observed', evidence: '' })) : [{ label: 'Practical assessment', critical: true, result: 'not_observed', evidence: '' }],
    sustained_results: 'not_enough_evidence', outcome_reference: '', paid_development_reference: '', position_available: null,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const management = ['service_manager', 'general_manager'].includes(data.to_role);
  const change = (key, value) => setData(current => ({ ...current, [key]: value }));
  function changeDate(day) {
    const effective = previous ? null : roleOn(day);
    setData(current => ({ ...current, assessed_date: day, ...(effective ? { to_role: nextStep(effective) } : {}) }));
  }
  const effective = roleOn(data.assessed_date);
  const ladderEnd = !previous && effective === 'general_manager';
  const stepMismatch = Boolean(previous && effective && effective !== previous.from_role);
  const blocked = !effective || ladderEnd || stepMismatch;
  const itemChange = (index, key, value) => change('items', data.items.map((item, i) => i === index ? { ...item, [key]: value } : item));
  async function save(event) {
    event.preventDefault(); setBusy(true); setError('');
    try { await request('/assessments', { method: 'POST', body: { ...data, from_role: effective } }); onSaved('Assessment retained with its rubric, evidence, and assessor.'); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <form className="pg-card pg-form" onSubmit={save}><h2>{previous ? 'Record reassessment' : 'Record practical assessment'}</h2><p>Use the published rubric and this employee’s verified results. Public reviews and the owner’s historical production do not set promotion thresholds.</p>{error && <p role="alert" className="pg-error">{error}</p>}<fieldset disabled={busy}>
    <div className="pg-form-grid"><Field label="Assess from role" value={effective || ''} disabled options={[{ value: '', label: 'No simulation level on this date' }, ...roles.map(role => ({ value: role.key, label: role.title }))]} onChange={() => {}} hint="Fixed to the simulation level in effect on the assessment date." /><Field label="Next step" value={roles.find(role => role.key === data.to_role)?.title || ''} readOnly /><Field label="Assessment date" type="date" min={earliest} max={today} required value={data.assessed_date} onChange={event => changeDate(event.target.value)} /><Field label="Rubric version / reference" required maxLength={100} value={data.rubric_version} onChange={event => change('rubric_version', event.target.value)} /></div>
    {data.items.map((item, index) => <div className="pg-form-row" key={index}><Field label={`Practical item ${index + 1}`} required maxLength={250} value={item.label} onChange={event => itemChange(index, 'label', event.target.value)} /><div className="pg-form-grid"><Field label={`Item ${index + 1} result`} value={item.result} options={['not_observed', 'pass', 'needs_work'].map(value => ({ value, label: words(value) }))} onChange={event => itemChange(index, 'result', event.target.value)} /><Field label={`Item ${index + 1} is critical`} value={String(item.critical)} options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} onChange={event => itemChange(index, 'critical', event.target.value === 'true')} /></div><Field label={`Item ${index + 1} evidence`} multiline required maxLength={2000} value={item.evidence} onChange={event => itemChange(index, 'evidence', event.target.value)} />{data.items.length > 1 && <Button variant="secondary" onClick={() => change('items', data.items.filter((_, i) => i !== index))}>Remove item {index + 1}</Button>}</div>)}
    <Button variant="secondary" disabled={data.items.length >= 50} onClick={() => change('items', [...data.items, { label: '', critical: false, result: 'not_observed', evidence: '' }])}>Add practical item</Button>
    <Field label="Sustained service outcomes" value={data.sustained_results} options={['not_enough_evidence', 'verified', 'needs_work'].map(value => ({ value, label: words(value) }))} onChange={event => change('sustained_results', event.target.value)} /><Field label="Verified outcome evidence / observation period" multiline required maxLength={2000} value={data.outcome_reference} onChange={event => change('outcome_reference', event.target.value)} />
    {management && <><Field label="Paid management-development evidence" multiline maxLength={2000} value={data.paid_development_reference} onChange={event => change('paid_development_reference', event.target.value)} /><Field label="Management position available" value={data.position_available == null ? '' : String(data.position_available)} options={[{ value: '', label: 'Not determined' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} onChange={event => change('position_available', event.target.value === '' ? null : event.target.value === 'true')} /></>}
    <p className="pg-muted">The signed-in admin is recorded as assessor. Saving records the assessment; title and pay decisions follow the published terms.</p>{!effective && <p className="pg-error">Record the employee’s simulation level for this date before assessing the next step.</p>}{ladderEnd && <p className="pg-error">General Manager is the top of the ladder; there is no next step to assess on this date.</p>}{stepMismatch && <p className="pg-error">On this date the employee’s simulation level is {roleTitle(effective)}, not {roleTitle(previous.from_role)}. Choose a date on or after the original assessment while that level was still in effect.</p>}<div className="pg-form-actions"><Button variant="secondary" onClick={onCancel}>Cancel</Button><Button type="submit" disabled={blocked} loading={busy}>Retain assessment</Button></div>
  </fieldset></form>;
}

export default function Growth({ view, manage, onSaved }) {
  const [editing, setEditing] = useState(null);
  const title = key => view.program.roles.find(role => role.key === key)?.title || words(key);
  return <>
    <section className="pg-card"><div className="pg-row"><h2>Your growth path</h2>{manage && <Button onClick={() => setEditing({ previous: null })}>Record assessment</Button>}</div><p>Progress follows verified results and practical assessments. A title does not grant field capabilities.</p>
      <ol className="pg-ladder">{view.program.roles.map((role, index) => <li key={role.key} aria-current={role.key === view.level?.role_key ? 'step' : undefined}><span className="pg-step">{index + 1}</span><div><h3>{role.title}</h3><p>{PATH_NOTES[role.key]}</p>{role.key === view.level?.role_key && <Status status="current_simulation_level" />}</div></li>)}</ol>
    </section>
    <section className="pg-card"><h2>Modeled pay steps</h2><p className="pg-muted">Illustrations assume 2,080 paid hours for technicians and exclude overtime and employer costs. Targets are conditional, not guaranteed annual pay.</p><div className="pg-table-scroll" tabIndex={0} role="region" aria-label="Modeled pay steps"><table><thead><tr><th>Role</th><th>Modeled base</th><th>Annual incentive target</th><th>Total at target</th></tr></thead><tbody>{view.program.roles.map(role => <tr key={role.key}><td>{role.title}</td><td>{role.hourlyCents ? `${money(role.hourlyCents)} / hour` : role.annualBaseCents ? `${money(role.annualBaseCents)} / year` : 'Not set'}</td><td>{role.targetIncentiveCents == null ? 'Not set' : money(role.targetIncentiveCents)}</td><td>{role.annualBaseCents == null ? 'Not set' : money(role.annualBaseCents + role.targetIncentiveCents)}</td></tr>)}</tbody></table></div></section>
    {editing && <AssessmentForm key={`${view.person.id}:${editing.previous?.id || 'new'}`} view={view} previous={editing.previous} onCancel={() => setEditing(null)} onSaved={label => { setEditing(null); onSaved(label); }} />}
    <section className="pg-card"><h2>Assessment history</h2>{!view.assessments.length && <p className="pg-empty">No retained assessments yet. There is no passing score until evidence is recorded.</p>}{view.assessments.map(row => <details key={row.id} className="pg-record"><summary><span><strong>{title(row.from_role)} → {title(row.to_role)}</strong><small>{date(row.assessed_date)} · {row.assessor_name}</small></span><Status status={row.result.status} /></summary><div className="pg-record-body"><p>Rubric: {row.rubric_version}{row.previous_id && ' · reassessment'}</p>{row.assessment.items.map((item, index) => <div className="pg-form-row" key={index}><strong>{item.label}{item.critical && ' · critical'}</strong><Status status={item.result} /><p>{item.evidence}</p></div>)}<p><strong>Sustained outcomes:</strong> {words(row.assessment.sustained_results)} · {row.assessment.outcome_reference}</p>{row.result.management && <><p>Paid development: {row.assessment.paid_development_reference || 'Evidence not recorded'}</p><p>Position available: {row.result.position_available == null ? 'Not determined' : row.result.position_available ? 'Yes' : 'No'} · separate from qualification</p></>}{manage && !view.assessments.some(item => item.previous_id === row.id) && <Button variant="secondary" onClick={() => setEditing({ previous: row })}>Record reassessment</Button>}</div></details>)}</section>
  </>;
}
