import { useState } from 'react';
import { etDateString } from '../../lib/timezone';
import { Button } from '../ui/Button';
import { Field, request, numeric, percentBps, date, words } from './common';

const addDays = (day, count) => { const next = new Date(`${day}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + count); return next.toISOString().slice(0, 10); };

// Keyed by employee: its draft never outlives a change of the selected person.
function LevelForm({ setup, view, disabled, onBusy, onError, onSaved }) {
  // saveLevel accepts only active employees (409 otherwise); former employees keep their history read-only.
  const inactive = view.person.employment_status !== 'active';
  // Levels are append-only: the next one must be dated after the newest retained level.
  // view.level is the level effective today; a future-dated record is newer, and the draft follows it (date and role).
  const newestRow = [...view.levels].sort((a, b) => date(a.effective_date) < date(b.effective_date) ? 1 : -1)[0];
  const newest = newestRow ? date(newestRow.effective_date) : undefined;
  const earliest = newest ? addDays(newest, 1) : undefined;
  const today = etDateString(new Date());
  const [level, setLevel] = useState(() => ({ id: crypto.randomUUID(), role_key: newestRow?.role_key || view.level?.role_key || 'technician_i', effective_date: earliest && earliest > today ? earliest : today }));
  const [saving, setSaving] = useState(false);
  async function saveLevel(event) {
    event.preventDefault(); setSaving(true); onBusy('level'); onError('');
    try {
      await request('/levels', { method: 'POST', body: { ...level, technician_id: view.person.id } });
      setLevel(current => ({ ...current, id: crypto.randomUUID() }));
      onSaved('Simulation level saved. Current compensation terms remain in effect.');
    }
    catch (failure) { onError(failure.message); }
    finally { setSaving(false); onBusy(''); }
  }
  return <form className="pg-card pg-form" onSubmit={saveLevel}><h2>Employee simulation level</h2><p className="pg-muted">This selects a modeled package. It does not change the employee’s title, agreed pay, or field capabilities.</p><fieldset disabled={disabled || inactive}><div className="pg-form-grid">
    <Field label="Simulation role" options={setup.program.roles.map(role => ({ value: role.key, label: role.title }))} value={level.role_key} onChange={event => setLevel(current => ({ ...current, role_key: event.target.value }))} />
    <Field label="Level effective date" type="date" required min={earliest} value={level.effective_date} onChange={event => setLevel(current => ({ ...current, effective_date: event.target.value }))} hint={newest ? `Must follow the newest retained level (${newest}).` : undefined} />
  </div><div className="pg-form-actions"><Button type="submit" disabled={inactive} loading={saving}>Save simulation level</Button></div></fieldset>{inactive && <p className="pg-muted">This employee is {words(view.person.employment_status || 'no longer active')}; simulation levels are read-only for former employees.</p>}
    {view.levels.map(row => <p key={row.id} className="pg-muted">{date(row.effective_date)} · {setup.program.roles.find(role => role.key === row.role_key)?.title}</p>)}
  </form>;
}

export default function ProgramSetup({ setup, view, onSaved }) {
  const newest = setup.rules[0];
  const nextDate = newest ? new Date(`${date(newest.effective_date)}T12:00:00Z`) : null;
  if (nextDate) nextDate.setUTCMonth(nextDate.getUTCMonth() + 1);
  const [definition, setDefinition] = useState(() => ({
    id: crypto.randomUUID(), label: 'Revision 2b simulation', effective_date: nextDate ? nextDate.toISOString().slice(0, 10) : `${view.month}-01`,
    service_rules: newest?.definition.service_rules || [],
    rework_minimum: newest?.definition.rework_minimum == null ? '' : String(newest.definition.rework_minimum),
    handoff_minimum: newest?.definition.handoff_minimum == null ? '' : String(newest.definition.handoff_minimum),
    activation_share: newest?.definition.activation_share_bps == null ? '' : String(newest.definition.activation_share_bps / 100),
  }));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const change = (key, value) => setDefinition(current => ({ ...current, [key]: value }));
  function changeService(key, field, value) {
    change('service_rules', definition.service_rules.map(row => row.service_key === key ? { ...row, [field]: value } : row));
  }
  async function saveDefinition(event) {
    event.preventDefault(); setBusy('definition'); setError('');
    try {
      const { activation_share, ...body } = definition;
      await request('/rules', { method: 'POST', body: { ...body, rework_minimum: numeric(definition.rework_minimum), handoff_minimum: numeric(definition.handoff_minimum), activation_share_bps: percentBps(activation_share) } });
      change('id', crypto.randomUUID());
      onSaved('Simulation definition saved with its effective date.');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(''); }
  }
  return <>
    {error && <p role="alert" className="pg-error">{error}</p>}
    <LevelForm key={view.person.id} setup={setup} view={view} disabled={!!busy} onBusy={setBusy} onError={setError} onSaved={onSaved} />
    <form className="pg-card pg-form" onSubmit={saveDefinition}><h2>Program simulation definition</h2><p>Production remains 6% for Technician I and 8% for Technician II. Choose each service key explicitly. Blank observation settings and commission splits remain undefined.</p><fieldset disabled={!!busy}>
      <div className="pg-form-grid"><Field label="Definition label" required maxLength={100} value={definition.label} onChange={event => change('label', event.target.value)} /><Field label="Definition effective date" type="date" required value={definition.effective_date} onChange={event => change('effective_date', event.target.value)} hint="First day of a month. Later definitions retain earlier calculations." /></div>
      <Field label="Add an eligible service key" value="" options={[{ value: '', label: 'Choose from the catalog…' }, ...setup.services.filter(service => !definition.service_rules.some(row => row.service_key === service.service_key)).map(service => ({ value: service.service_key, label: `${service.name} · ${service.service_key}` }))]} onChange={event => { if (event.target.value) change('service_rules', [...definition.service_rules, { service_key: event.target.value, credit_type: 'routine', rework_window_days: null }]); }} />
      {definition.service_rules.map(row => <div key={row.service_key} className="pg-form-row"><strong>{row.service_key}</strong><div className="pg-form-grid"><Field label={`Credit type for ${row.service_key}`} value={row.credit_type} options={[{ value: 'routine', label: 'Routine recurring service' }, { value: 'specialty', label: 'Specialty · separate amount required' }]} onChange={event => changeService(row.service_key, 'credit_type', event.target.value)} /><Field label={`Rework window for ${row.service_key} (days)`} type="number" min="1" max="365" value={row.rework_window_days ?? ''} onChange={event => changeService(row.service_key, 'rework_window_days', numeric(event.target.value))} /></div><Button variant="secondary" onClick={() => change('service_rules', definition.service_rules.filter(item => item.service_key !== row.service_key))}>Remove {row.service_key}</Button></div>)}
      <div className="pg-form-grid"><Field label="Rework minimum observations" type="number" min="1" max="10000" value={definition.rework_minimum} onChange={event => change('rework_minimum', event.target.value)} /><Field label="Handoff minimum observations" type="number" min="1" max="10000" value={definition.handoff_minimum} onChange={event => change('handoff_minimum', event.target.value)} /><Field label="Activation share of commission (%)" type="number" min="0" max="100" step="0.01" value={definition.activation_share} onChange={event => change('activation_share', event.target.value)} hint="The remainder is the 90-day portion. Revision 2b did not select this split." /></div>
      <p className="pg-muted">Outcome calculations use a linear simulation between the modeled thresholds. These definitions do not authorize compensation.</p><div className="pg-form-actions"><Button type="submit" loading={busy === 'definition'}>Save simulation definition</Button></div>
    </fieldset></form>
    <section className="pg-card"><h3>Retained definitions</h3>{!setup.rules.length && <p>No simulation definitions recorded yet.</p>}{setup.rules.map(row => <details key={row.id} className="pg-record"><summary>{row.label} · effective {date(row.effective_date)}</summary><div className="pg-record-body"><p>{row.definition.service_rules.map(item => item.service_key).join(', ') || 'No eligible service keys'}</p><p>Rework minimum: {row.definition.rework_minimum ?? 'unset'} · handoff minimum: {row.definition.handoff_minimum ?? 'unset'} · activation share: {row.definition.activation_share_bps == null ? 'unset' : `${row.definition.activation_share_bps / 100}%`}</p></div></details>)}</section>
  </>;
}
