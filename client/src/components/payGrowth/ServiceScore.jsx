import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { UiSurface } from '../ui/UiSurface';
import { Button } from '../ui/Button';
import { request, EvidenceRow } from './common';
import './pay-growth.css';

// initialData: a score the caller already fetched (a participant probe), so the first render does not re-request it.
export default function ServiceScore({ serviceId, manage = false, initialData = null }) {
  const [data, setData] = useState(initialData);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (attempt === 0 && initialData) { setData(initialData); setError(''); return undefined; }
    setData(null); setError('');
    const controller = new AbortController();
    request(`/services/${serviceId}/score`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setData(result);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [serviceId, attempt, initialData]);
  return <UiSurface className="pay-growth" data-admin={manage || undefined} density="touch"><h2>Service score</h2><div className="pg-notice"><strong>Simulation only</strong><p>These calculations are not earned compensation.</p></div>
    {error ? <div role="alert" className="pg-error">{error}<Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>Retry score</Button></div> : !data ? <p role="status">Loading service score…</p> : data.entries.length ? data.entries.map(entry => <EvidenceRow key={entry.id} entry={entry} />) : <p>No reviewed evidence is recorded for this service. It has not received a passing score.</p>}
    <Link to={manage ? '/admin/timetracking?tab=pay-growth' : '/tech/pay-growth'}>Open Pay & Growth</Link>
  </UiSurface>;
}
