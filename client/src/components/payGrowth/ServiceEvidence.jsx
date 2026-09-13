import { useState } from 'react';
import { Button } from '../ui/Button';
import { words, EvidenceRow } from './common';
import EvidenceEditor from './EvidenceEditor';

export default function ServiceEvidence({ view, manage: canManage, people, onSaved }) {
  const [editor, setEditor] = useState(null);
  function saved(label) { setEditor(null); onSaved(label); }
  return <>
    <div className="pg-row"><div><h2>Services behind the numbers</h2><p className="pg-muted">Recorded evidence, effective rates, and retained revisions.</p></div>{canManage && <Button onClick={() => setEditor({ serviceId: '' })}>Record service evidence</Button>}</div>
    {editor && <EvidenceEditor key={`${view.person.id}-${view.month}-${editor.serviceId || 'new'}`} technicianId={view.person.id} month={view.month} serviceId={editor.serviceId} people={people} onCancel={() => setEditor(null)} onSaved={saved} />}
    {!view.entries.length && <p className="pg-card pg-empty">No service evidence has been recorded for this month.</p>}
    {view.entries.map(entry => <EvidenceRow key={entry.id} entry={entry} onReview={canManage ? serviceId => setEditor({ serviceId }) : null} />)}
    {view.missing.length > 0 && <section className="pg-card"><h3>Still needs evidence</h3><p>These performed services remain in the exception count until reviewed.</p>{view.missing.map(item => <div key={item.id} className="pg-history-row"><span>{item.scheduled_date} · {item.service_type} · {words(item.status)}</span>{canManage && <Button variant="secondary" onClick={() => setEditor({ serviceId: item.id })}>Review</Button>}</div>)}</section>}
  </>;
}
