import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ArrowRight, FileCheck2 } from 'lucide-react';
import PublicLoadError from '../components/PublicLoadError';
import { useGlassSurface } from '../glass/glass-engine';
import { CUSTOMER_SURFACE, WAVES_PHONE_DISPLAY, WAVES_PHONE_TEL } from '../theme-customer';
import { TIMEZONE } from '../lib/timezone';

const API = import.meta.env.VITE_API_URL || '/api';
// One label per VALID_VISIT_OUTCOMES entry in complete-scheduled-service.js;
// an unknown value falls back to the neutral "Service recorded".
const OUTCOMES = {
  completed: 'Completed', inspection_only: 'Inspected — no treatment',
  customer_declined: 'Service declined', follow_up_needed: 'Follow-up needed',
  customer_concern: 'Concern noted — we will follow up', incomplete: 'Not completed — we will return',
};

export default function VisitSummaryPage() {
  const { token } = useParams();
  const [summary, setSummary] = useState(null);
  const [state, setState] = useState('loading');
  const [retry, setRetry] = useState(0);
  useGlassSurface(true);
  useEffect(() => {
    const abort = new AbortController();
    setSummary(null);
    setState('loading');
    if (!/^[a-f0-9]{64}$/.test(token || '')) {
      setState('missing');
      return () => abort.abort();
    }
    fetch(`${API}/visit-summary/${token}`, { signal: abort.signal, cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 404) { setState('missing'); return; }
        if (!response.ok) throw new Error('Summary unavailable');
        const data = await response.json();
        if (!Array.isArray(data.services) || !data.services.length) throw new Error('Summary unavailable');
        setSummary(data);
        setState('ready');
      })
      .catch((error) => { if (error.name !== 'AbortError') setState('error'); });
    return () => abort.abort();
  }, [token, retry]);

  const date = summary?.serviceDate && new Date(`${summary.serviceDate}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: TIMEZONE, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  return (
    <div style={{ width: '100%', maxWidth: 760, boxSizing: 'border-box', margin: '0 auto', padding: '32px 20px 48px', color: CUSTOMER_SURFACE.text, fontSize: 16, lineHeight: 1.6 }}>
      <header style={{ marginBottom: 28 }}>
        <p style={{ margin: 0, fontSize: 14, color: CUSTOMER_SURFACE.muted }}>Waves Pest Control</p>
        <h1 style={{ margin: '6px 0', fontSize: 32, lineHeight: 1.2 }}>Your visit summary</h1>
        {date && <p style={{ margin: '12px 0 0' }}>{date}</p>}
      </header>
      {state === 'loading' && <p role="status">Loading your services…</p>}
      {state === 'error' && <PublicLoadError resource="visit summary" onRetry={() => setRetry((value) => value + 1)} />}
      {state === 'missing' && <p role="alert">This visit summary is unavailable. Please contact us for help with your report.</p>}
      {state === 'ready' && (
        <>
          <p style={{ marginBottom: 24 }}>Each service has its own report with the details from your visit.</p>
          <div style={{ display: 'grid', gap: 16 }}>
            {summary.services.map((service) => (
              <section key={service.id} data-glass="" style={{ background: 'rgba(255,255,255,0.78)', border: '1px solid rgba(255,255,255,0.9)', borderRadius: 18, padding: 24, boxShadow: '0 8px 28px rgba(4,57,94,0.07)' }}>
                <FileCheck2 size={24} aria-hidden="true" />
                <h2 style={{ fontSize: 22, lineHeight: 1.35, margin: '12px 0 6px' }}>{service.serviceType}</h2>
                <p style={{ color: CUSTOMER_SURFACE.muted, margin: '0 0 20px' }}>{OUTCOMES[service.outcome] || 'Service recorded'}</p>
                {/^\/report\/[a-f0-9]{32}$/.test(service.reportUrl || '') ? (
                  <a href={service.reportUrl} rel="noreferrer" data-glass-accent="" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 48, padding: '12px 18px', borderRadius: 12, background: '#F4B014', color: CUSTOMER_SURFACE.text, textDecoration: 'none', fontWeight: 600 }}>
                    View service report <ArrowRight size={20} aria-hidden="true" />
                  </a>
                ) : <p style={{ margin: 0 }}>Your report is being prepared.</p>}
              </section>
            ))}
          </div>
        </>
      )}
      <p style={{ marginTop: 28, color: CUSTOMER_SURFACE.muted }}>Need help? <a href={`tel:${WAVES_PHONE_TEL}`} style={{ color: CUSTOMER_SURFACE.text }}>{WAVES_PHONE_DISPLAY}</a></p>
    </div>
  );
}
