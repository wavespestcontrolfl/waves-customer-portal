import { useEffect, useState } from 'react';
import { box, row, request, dateLabel } from './common';

// Admin view on the staff documents page (GATE_STAFF_ONBOARDING_DOCS): for each active staff
// member, the required documents they signed and the ones still outstanding. Renders nothing
// while the gate is off, on a failed read, or when no document is required.
export default function OnboardingStatus({ enabled = false }) {
  const [team, setTeam] = useState(null);
  useEffect(() => {
    setTeam(null);
    if (!enabled) return undefined;
    const controller = new AbortController();
    Promise.resolve(request('/onboarding/team', undefined, controller.signal))
      .then(result => { if (!controller.signal.aborted) setTeam(result?.enabled === true ? result.technicians : null); })
      .catch(() => { if (!controller.signal.aborted) setTeam(null); });
    return () => controller.abort();
  }, [enabled]);
  const people = (team || []).filter(person => person.signed.length + person.outstanding.length > 0);
  if (!people.length) return null;
  return <section style={box} data-testid="onboarding-status">
    <h2 style={{ fontSize: 20, margin: 0 }}>Required at onboarding</h2>
    <p style={{ marginTop: 4 }}>Each active staff member, with the required documents signed and still outstanding.</p>
    <div style={{ display: 'grid', gap: 10 }}>
      {people.map(person => <details key={person.technician_id}>
        <summary style={{ cursor: 'pointer', padding: '6px 0' }}><strong>{person.name}</strong> · {person.signed.length} of {person.signed.length + person.outstanding.length} signed{person.outstanding.length ? ` · ${person.outstanding.length} outstanding` : ''}</summary>
        <ul style={{ margin: '4px 0 8px' }}>
          {person.outstanding.map(item => <li key={item.document_id}><span style={row}>Outstanding: {item.title}{item.due_at ? ` (due ${dateLabel(item.due_at)})` : ''}</span></li>)}
          {person.signed.map(item => <li key={item.document_id}>Signed: {item.title} ({dateLabel(item.completed_at)})</li>)}
        </ul>
      </details>)}
    </div>
  </section>;
}
