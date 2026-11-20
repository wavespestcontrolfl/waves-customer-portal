import { useCallback, useEffect, useState } from 'react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';
import { Input } from '../ui/Input';
import { Radio } from '../ui/Radio';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table';
import { Textarea } from '../ui/Textarea';
import { adminFetch } from '../../lib/adminFetch';
import { etDateString } from '../../lib/timezone';
import { dayLabel } from '../payroll/payrollFormat';

// Staff page, Team section, Protocol audit tab (Tech Rewards Plan D5-3, owner 2026-11-20). Each month the
// owner sees five completed lawn / tree & shrub visits per technician, compares the record with the protocol
// and marks each one match or mismatch with a note. The mark feeds the protocol-audit part of the season
// score. Nothing here changes a visit or sends a message.

async function call(path, options = {}) {
  const response = await adminFetch(`/admin/tech-protocol-audits${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Protocol audit request failed (${response.status}).`);
  return data;
}

const LINE_WORDS = { lawn: 'Lawn', tree_shrub: 'Tree & shrub' };
const photoCountWords = counts => Object.entries(counts || {}).map(([type, n]) => `${n} ${type}`).join(', ');
const productAmount = p => [
  p.rate != null ? `${p.rate} ${p.rateUnit || ''}`.trim() : null,
  p.area,
  p.totalAmount != null ? `total ${p.totalAmount} ${p.amountUnit || ''}`.trim() : null,
].filter(Boolean).join(' · ');

function Products({ products }) {
  if (!products.length) return <p className="m-0 text-ui-caption text-ink-secondary">No products on the record.</p>;
  return <Table aria-label="Products on the record">
    <THead><TR><TH>Product</TH><TH>Rate, area and total</TH><TH>Targets</TH></TR></THead>
    <TBody>
      {products.map((p, i) => <TR key={`${p.name}-${i}`}>
        <TD>{p.name}</TD>
        <TD>{productAmount(p) || 'Not recorded'}</TD>
        <TD>{p.targets.length ? p.targets.join(', ') : 'None listed'}</TD>
      </TR>)}
    </TBody>
  </Table>;
}

function Photos({ photos }) {
  if (!photos.length) return <p className="m-0 text-ui-caption text-ink-secondary">No photos on the record.</p>;
  return <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Visit photos">
    {photos.map(photo => <li key={photo.id} className="w-28">
      {photo.url
        ? <a href={photo.url} target="_blank" rel="noreferrer"><img src={photo.url} alt={photo.caption || `${photo.type} photo`} className="h-28 w-28 rounded-sm object-cover" /></a>
        : <span className="text-ui-caption text-ink-secondary">Photo unavailable</span>}
      <span className="block text-ui-caption text-ink-secondary">{photo.type}</span>
    </li>)}
  </ul>;
}

function MarkForm({ visit, onSaved }) {
  const [result, setResult] = useState(visit.audit?.result || '');
  const [note, setNote] = useState(visit.audit?.note || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = `audit-${visit.scheduledServiceId}`;

  async function save(event) {
    event.preventDefault();
    if (result === 'mismatch' && !note.trim()) { setError('A mismatch needs a note.'); return; }
    setBusy(true); setError('');
    try {
      const data = await call(`/visits/${visit.scheduledServiceId}`, { method: 'PUT', body: { result, note, recordId: visit.recordId } });
      onSaved(data.mark);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return <form onSubmit={save} className="grid gap-2" aria-label="Mark this visit">
    <div role="radiogroup" aria-label="Result" className="flex flex-wrap gap-4">
      <Radio id={`${id}-match`} name={id} label="Match" checked={result === 'match'} onChange={() => setResult('match')} />
      <Radio id={`${id}-mismatch`} name={id} label="Mismatch" checked={result === 'mismatch'} onChange={() => setResult('mismatch')} />
    </div>
    <Field label="Note" help={result === 'mismatch' ? 'Required for a mismatch.' : 'Optional.'} error={error}>
      <Textarea rows={2} maxLength={1000} value={note} onChange={event => setNote(event.target.value)} />
    </Field>
    <div className="flex items-center gap-3">
      <Button type="submit" loading={busy} disabled={!result}>{visit.audit ? 'Change mark' : 'Save mark'}</Button>
      {visit.needsRecheck && <Badge tone="warn">Needs re-check: the visit changed after your last mark</Badge>}
      {visit.audit && <Badge tone={visit.audit.result === 'match' ? 'strong' : 'warn'}>{visit.audit.result === 'match' ? 'Marked match' : 'Marked mismatch'}</Badge>}
    </div>
  </form>;
}

function VisitCard({ visit, onSaved }) {
  return <Card className="grid gap-3 p-4" aria-label={`Visit on ${dayLabel(visit.serviceDate)}`}>
    <div>
      <h3 className="m-0 text-ui-body font-medium">{dayLabel(visit.serviceDate)} · {visit.serviceType}</h3>
      <p className="m-0 text-ui-caption text-ink-secondary">
        {[LINE_WORDS[visit.serviceLine], visit.customerName, visit.protocolName, visit.areaSqft ? `${visit.areaSqft} sq ft` : null].filter(Boolean).join(' · ')}
      </p>
      <p className="m-0 text-ui-caption text-ink-secondary">
        {visit.counts.products} products · {visit.counts.photos} photos{visit.counts.photos ? ` (${photoCountWords(visit.counts.photosByType)})` : ''}
      </p>
    </div>
    <Products products={visit.products} />
    <Photos photos={visit.photos} />
    <MarkForm visit={visit} onSaved={onSaved} />
  </Card>;
}

export default function ProtocolAudit() {
  const [month, setMonth] = useState(() => etDateString(new Date()).slice(0, 7));
  const [board, setBoard] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    let live = true;
    setBoard(null); setError('');
    call(`?month=${encodeURIComponent(month)}`)
      .then(data => { if (live) setBoard(data); })
      .catch(failure => { if (live) setError(failure.message); });
    return () => { live = false; };
  }, [month]);
  useEffect(load, [load]);

  // A save that returns after the month changed (the board reloads) belongs to the old board: drop it.
  const applyMark = (technicianId, mark, boardMonth) => setBoard(prev => (!prev || prev.month !== boardMonth ? prev : {
    ...prev,
    technicians: prev.technicians.map(t => {
      if (t.id !== technicianId) return t;
      const visits = t.visits.map(v => (v.scheduledServiceId === mark.scheduledServiceId ? { ...v, audit: mark } : v));
      return { ...t, visits, markedCount: visits.filter(v => v.audit).length };
    }),
  }));

  return <Card className="grid gap-4 p-4" aria-label="Protocol audit">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="m-0 text-ui-title font-medium">Protocol audit</h2>
        <p className="m-0 text-ui-caption text-ink-secondary">Five completed lawn and tree &amp; shrub visits for each technician. Compare each record with the protocol, then mark it match or mismatch.</p>
      </div>
      <Field label="Month"><Input type="month" value={month} onChange={event => event.target.value && setMonth(event.target.value)} /></Field>
    </div>
    {error && <p role="alert" className="m-0 text-ui-caption text-alert-fg">{error}</p>}
    {!board && !error && <p role="status" className="m-0">Loading…</p>}
    {board && board.technicians.length === 0 && <p className="m-0">No completed lawn or tree &amp; shrub visits this month.</p>}
    {board && board.technicians.map(tech => <section key={tech.id} className="grid gap-3" aria-label={`Audit for ${tech.name}`}>
      <h3 className="m-0 text-ui-title font-medium">
        {tech.name} <span className="text-ui-caption font-normal text-ink-secondary">{tech.markedCount} of {tech.visits.length} marked · {tech.eligibleCount} eligible visits</span>
      </h3>
      {tech.visits.map(visit => <VisitCard key={visit.scheduledServiceId} visit={visit} onSaved={mark => applyMark(tech.id, mark, board.month)} />)}
    </section>)}
  </Card>;
}
