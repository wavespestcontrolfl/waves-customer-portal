import { useEffect, useState } from 'react';
import { RefreshCw, TrendingUp } from 'lucide-react';
import { etDateString } from '../../lib/timezone';
import { Button } from '../ui/Button';
import { UiSurface } from '../ui/UiSurface';
import usePayGrowthAvailable from '../../hooks/usePayGrowthAvailable';
import { Field, request } from './common';
import ProgramSetup from './ProgramSetup';
import ServiceEvidence from './ServiceEvidence';
import Growth from './Growth';
import PayOverview from './PayOverview';
import './pay-growth.css';

export default function PayGrowth({ manage = false }) {
  // The route and the admin tab mount this directly; the server gate decides here, not the navigation.
  const available = usePayGrowthAvailable();
  const [month, setMonth] = useState(() => etDateString(new Date()).slice(0, 7));
  const [personId, setPersonId] = useState('');
  const [setup, setSetup] = useState(null);
  const [view, setView] = useState(null);
  const [section, setSection] = useState('overview');
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [setupError, setSetupError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!manage || available !== true) return undefined;
    const controller = new AbortController();
    request('/setup', { signal: controller.signal }).then(data => {
      if (controller.signal.aborted) return;
      setSetup(data); setSetupError('');
      setPersonId(previous => previous || data.people.find(person => person.employment_status === 'active')?.id || data.people[0]?.id || '');
    }).catch(failure => { if (!controller.signal.aborted) setSetupError(failure.message); });
    return () => controller.abort();
  }, [manage, reload, available]);

  useEffect(() => {
    setView(null); setError('');
    if (available !== true || (manage && !personId)) return undefined;
    const controller = new AbortController();
    const query = new URLSearchParams({ month });
    if (manage) query.set('technicianId', personId);
    request(`/?${query}`, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setView(data);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [month, personId, manage, reload, available]);

  function saved(label) { setMessage(label); setReload(value => value + 1); }
  const readyView = view && (!manage || view.person.id === personId) && view.month === month;
  if (available !== true) return <UiSurface density="touch" className="pay-growth" data-admin={manage || undefined}>{available === null ? <p role="status">Checking pay and growth availability…</p> : <p role="status">Pay and growth is unavailable.</p>}</UiSurface>;
  return <UiSurface density="touch" className="pay-growth" data-admin={manage || undefined}>
    <header className="pg-heading"><div><p className="pg-eyebrow">Field Team Program</p><h1>{manage ? 'Pay & Growth' : 'My Pay & Growth'}</h1><p className="pg-muted">Your work, the calculations, and your next step.</p></div><TrendingUp size={30} aria-hidden="true" /></header>
    <div className="pg-notice"><strong>Simulation only · revision 2b</strong><p>These amounts illustrate the proposed incentive formula; they are not earned compensation. Your current compensation terms remain in effect.</p></div>
    <div className="pg-filters">
      {manage && setup && <Field label="Employee" value={personId} onChange={event => { setPersonId(event.target.value); setMessage(''); }} options={setup.people.map(person => ({ value: person.id, label: `${person.name}${person.employment_status === 'inactive' ? ' · inactive' : ''}` }))} />}
      <Field label="Service / acceptance month" type="month" value={month} max={etDateString(new Date()).slice(0, 7)} required onChange={event => { if (event.target.value) { setMonth(event.target.value); setMessage(''); } }} />
      <Button variant="secondary" onClick={() => setReload(value => value + 1)}><RefreshCw size={18} aria-hidden="true" /> Refresh</Button>
    </div>
    {message && <p role="status" className="pg-feedback">{message}</p>}
    {setupError && <p role="alert" className="pg-error">{setupError}</p>}
    {error && <p role="alert" className="pg-error">{error}</p>}
    {!readyView && !error && !setupError && <p role="status">{manage && setup?.people.length === 0 ? 'There are no active or former employees to display. Prospective staff are excluded.' : 'Loading pay and growth…'}</p>}
    {readyView && <ProgramView view={view} manage={manage} setup={setup} section={section} setSection={setSection} onSaved={saved} />}
  </UiSurface>;
}

function ProgramView({ view, manage, setup, section, setSection, onSaved }) {
  const canManage = manage && view.can_manage;
  const sections = [['overview', 'Overview'], ['evidence', 'Service evidence'], ['growth', 'Growth']];
  if (canManage) sections.push(['setup', 'Simulation setup']);
  return <>
    <nav className="pg-tabs" aria-label="Pay and growth sections">{sections.map(([key, label]) => <button type="button" key={key} aria-pressed={section === key} onClick={() => setSection(key)}>{label}</button>)}</nav>
    {section === 'overview' && <PayOverview view={view} manage={canManage} onSaved={onSaved} />}
    {section === 'evidence' && <ServiceEvidence view={view} manage={canManage} people={setup?.people || []} onSaved={onSaved} />}
    {section === 'growth' && <Growth view={view} manage={canManage} onSaved={onSaved} />}
    {section === 'setup' && canManage && <ProgramSetup setup={setup} view={view} onSaved={onSaved} />}
  </>;
}
