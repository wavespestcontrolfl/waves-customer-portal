import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '../ui/Button';
import { money, date, words, Status, EvidenceRow, request, withVisit } from './common';
import BusinessEditor from './BusinessEditor';

function Outcome({ title, result, maximum, detail }) {
  return <section className="pg-card"><div className="pg-row"><h3>{title}</h3><Status status={result.status} /></div>
    <strong className="pg-number">{money(result.amount_cents)}</strong><p className="pg-muted">Up to {money(maximum)} / month in the model</p>
    <p>{result.reason}</p><p className="pg-muted">{detail}</p>
    <div className="pg-observations"><span>{result.observed} observed</span><span>{result.unresolved} unresolved</span><span>{result.immature} still observing</span></div>
  </section>;
}

export default function PayOverview({ view, manage: canManage, onSaved }) {
  const { search } = useLocation();
  const [editor, setEditor] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Outcomes for the selected month are modeled at the level in effect on its first day, not today's level.
  const monthLevel = view.levels.find(item => date(item.effective_date) <= `${view.month}-01`) || null;
  const role = view.program.roles.find(item => item.key === monthLevel?.role_key);
  function saved(label) { setEditor(null); onSaved(label); }
  async function saveSnapshot() {
    setSaving(true); setError('');
    try { await request('/statements', { method: 'POST', body: { technician_id: view.person.id, month: view.month } }); saved('Simulation statement saved. Repeating the same calculation retains the existing statement.'); }
    catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  }
  return <>{error && <p role="alert" className="pg-error">{error}</p>}

    <div className="pg-summary-grid">
      <section className="pg-card"><p className="pg-eyebrow">Recorded hourly rate</p><strong className="pg-number">{view.person.pay_rate == null ? 'Not recorded' : money(Math.round(Number(view.person.pay_rate) * 100))}<small>{view.person.pay_rate != null && ' / hour'}</small></strong><p>{view.person.job_title || 'No job title recorded'}</p><p className="pg-muted">The profile rate is separate from the modeled package. Refer to your issued terms.</p><Link to={canManage ? '/admin/timetracking?tab=documents' : withVisit('/tech/documents', search)}>Staff documents</Link></section>
      <section className="pg-card pg-emphasis"><p className="pg-eyebrow">Simulated production</p><strong className="pg-number">{money(view.simulation.production.amount_cents)}</strong><p>{view.simulation.production.calculated} calculated services · {view.simulation.production.needs_evidence} need evidence</p><p className="pg-muted">{role ? `Simulation level for ${view.month}: ${role.title}` : `No simulation level in effect for ${view.month}`}. Incentives are added to hourly pay in the model.</p></section>
      <section className="pg-card"><p className="pg-eyebrow">Existing review payouts</p><strong className="pg-number">{money(view.reviews.reduce((sum, row) => sum + row.amount_cents, 0))}</strong><p>Recorded in the existing review program</p><p className="pg-muted">Shown once from its authoritative payout record. Separate from these simulations.</p></section>
    </div>
    <div className="pg-row"><h2>Monthly outcome model</h2><span className="pg-muted">{view.simulation.period_closed ? 'Service month closed' : 'Month in progress'} · evaluated {view.simulation.as_of_date}</span></div>
    <div className="pg-two-col"><Outcome title="Avoidable rework" result={view.simulation.rework} maximum={20000} detail="Full at 2% or less; zero at 6%. Only reviewed technician execution counts." /><Outcome title="Clean handoff" result={view.simulation.handoff} maximum={10000} detail="Full at 98% or more; zero at 90%. Completeness at cutoff and substantive repairs are separate facts." /></div>
    <section className="pg-card"><div className="pg-row"><h2>New business</h2>{canManage && <Button variant="secondary" onClick={() => setEditor({ initial: null })}>Record origination</Button>}</div><p>5% of accepted incremental net value. The originating technician keeps attribution when the office closes the estimate.</p><p className="pg-muted">Records are grouped by acceptance month. Activation and the 90-day portion remain simulations.</p>
      {!view.business.length && <p className="pg-empty">No new-business evidence recorded for this acceptance month.</p>}
      {view.business.map(row => <article className="pg-business" key={row.id}><div className="pg-row"><strong>{money(row.calculation.potential_cents)} potential commission</strong><Status status={row.calculation.status} /></div><p>{money(row.facts.accepted_net_cents - row.facts.baseline_cents)} incremental value × 5%</p><p>Activation: {money(row.calculation.activation_cents)} · 90 days: {money(row.calculation.retention_cents)}{row.calculation.retention_due && ` · milestone ${row.calculation.retention_due}`}</p><p>{row.calculation.reason}</p><p className="pg-muted">{row.facts.source_reference}</p>{canManage && <Button variant="secondary" onClick={() => setEditor({ initial: row })}>Record milestone review</Button>}</article>)}
    </section>
    {editor && <BusinessEditor key={`${view.person.id}:${view.month}:${editor.initial?.id || 'new-business'}`} technicianId={view.person.id} month={view.month} initial={editor.initial} onCancel={() => setEditor(null)} onSaved={saved} />}
    <section className="pg-card"><h2>Review payment history</h2>{!view.reviews.length && <p className="pg-empty">No review payouts were earned in this month.</p>}{view.reviews.map(row => <div key={row.id} className="pg-history-row"><strong>{money(row.amount_cents)}</strong><span>{words(row.status)} · earned {date(row.earned_at)}{row.exported_at && ` · exported ${date(row.exported_at)}`}{row.paid_at && ` · paid ${date(row.paid_at)}`}</span></div>)}<p className="pg-muted">Exported means exported. Payment is shown only when the existing record confirms it.</p></section>
    <section className="pg-card"><div className="pg-row"><h2>Saved simulation statements</h2>{canManage && <Button variant="secondary" onClick={saveSnapshot} loading={saving}>{saving ? 'Saving…' : 'Save simulation statement'}</Button>}</div><p className="pg-muted">Each saved statement retains its calculations and evidence. It cannot be exported to payroll.</p>{!view.statements.length && <p className="pg-empty">No simulation statements saved for this month.</p>}{view.statements.map(row => <details className="pg-record" key={row.id}><summary>Simulation saved {date(row.created_at)} · {money(row.statement.production.amount_cents)} production</summary><div className="pg-record-body"><p>Rework {money(row.statement.rework.amount_cents)} · handoff {money(row.statement.handoff.amount_cents)} · commission {money(row.statement.commission.amount_cents)}</p>{row.statement.entries.map(entry => <EvidenceRow key={entry.id} entry={entry} />)}</div></details>)}</section>
  </>;
}
