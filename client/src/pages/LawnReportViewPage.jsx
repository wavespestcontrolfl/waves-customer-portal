import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { COLORS, FONTS } from '../theme-brand';
import BrandFooter from '../components/BrandFooter';
import GuaranteeStrip from '../components/estimate/GuaranteeStrip';
import QuestionsEscapeHatch from '../components/estimate/QuestionsEscapeHatch';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const WAVES_PHONE_DISPLAY = '(941) 297-5749';
const WAVES_PHONE_TEL = '+19412975749';

// Warm-brand tokens — mirror the public estimate view (customer surface, not admin).
const BG = '#FAF8F3';
const BORDER = '#E7E2D7';
const TEXT = '#1B2C5B';
const BODY = '#3F4A65';
const MUTED = '#6B7280';
const CARD = COLORS.white;
const TAN = '#F2EEE0';

const STATUS_DOT = {
  Healthy: COLORS.green,
  'Keep an eye on it': COLORS.orange,
  'Needs attention': COLORS.red,
  Reviewed: COLORS.grayMid,
};
const SEVERITY_DOT = { mild: COLORS.green, moderate: COLORS.orange, severe: COLORS.red };

function Page({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: BG, fontFamily: FONTS.body, color: BODY, display: 'flex', flexDirection: 'column' }}>
      <header style={{ background: CARD, borderBottom: `1px solid ${BORDER}`, padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: FONTS.display, fontSize: 22, color: TEXT, letterSpacing: '0.01em' }}>Waves Pest Control &amp; Lawn</span>
        <a href={`tel:${WAVES_PHONE_TEL}`} style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 15, color: COLORS.blueDeeper, textDecoration: 'none' }}>{WAVES_PHONE_DISPLAY}</a>
      </header>
      <main style={{ flex: 1, width: '100%', maxWidth: 720, margin: '0 auto', padding: '20px 16px 48px' }}>{children}</main>
      <BrandFooter variant="light" />
    </div>
  );
}

function SectionCard({ children, style }) {
  return (
    <section style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 16, ...style }}>
      {children}
    </section>
  );
}

function SectionTitle({ children }) {
  return <h2 style={{ fontFamily: FONTS.serif, fontSize: 22, fontWeight: 500, lineHeight: 1.2, color: TEXT, margin: '0 0 12px' }}>{children}</h2>;
}

function StatusPill({ label }) {
  const color = STATUS_DOT[label] || COLORS.grayMid;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 999, background: COLORS.white, border: `1px solid ${BORDER}`, fontFamily: FONTS.heading, fontWeight: 700, fontSize: 13, color: TEXT }}>
      <span style={{ width: 10, height: 10, borderRadius: 999, background: color, flex: 'none' }} />
      {label}
    </span>
  );
}

function NotFoundCard() {
  return (
    <SectionCard style={{ textAlign: 'center', marginTop: 40 }}>
      <SectionTitle>This lawn report isn&apos;t available</SectionTitle>
      <p style={{ margin: '0 0 16px', color: BODY, fontSize: 15, lineHeight: 1.55 }}>
        The link may have expired or is no longer active. Give us a call and we&apos;ll take a fresh look at your lawn.
      </p>
      <a href={`tel:${WAVES_PHONE_TEL}`} style={{ display: 'inline-block', padding: '12px 18px', borderRadius: 10, background: COLORS.blueDeeper, color: COLORS.white, fontFamily: FONTS.heading, fontWeight: 700, fontSize: 15, textDecoration: 'none' }}>
        Call {WAVES_PHONE_DISPLAY}
      </a>
    </SectionCard>
  );
}

function QuoteRequestForm({ token, firstName }) {
  const [form, setForm] = useState({ name: firstName || '', phone: '', email: '', best_time: '' });
  const [status, setStatus] = useState('idle'); // idle | loading | success | error
  const [error, setError] = useState('');
  const busy = status === 'loading' || status === 'success';

  const update = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    if (!form.name.trim()) { setError('Please add your name.'); setStatus('error'); return; }
    if (!form.phone.trim() && !form.email.trim()) { setError('Add a phone number or email so we can reach you.'); setStatus('error'); return; }
    setStatus('loading');
    try {
      const res = await fetch(`${API_BASE}/public/lawn-diagnostic/${token}/quote-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name.trim(), phone: form.phone.trim(), email: form.email.trim(), best_time: form.best_time.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) { setStatus('success'); return; }
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
      setStatus('success');
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
      setStatus('error');
    }
  };

  const inputStyle = { minHeight: 46, padding: '0 12px', border: `1px solid ${BORDER}`, borderRadius: 10, fontSize: 15, fontFamily: FONTS.body, color: TEXT, outline: 'none', background: COLORS.white, width: '100%', boxSizing: 'border-box' };

  if (status === 'success') {
    return (
      <div role="status" style={{ background: COLORS.greenLight, border: `1px solid ${COLORS.green}`, borderRadius: 10, padding: '16px 18px', color: '#166534', fontSize: 15, lineHeight: 1.5 }}>
        Thanks{form.name ? `, ${form.name.split(' ')[0]}` : ''}! We&apos;ll reach out shortly with your free lawn plan.
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
      <input value={form.name} onChange={update('name')} disabled={busy} placeholder="Your name" autoComplete="name" style={inputStyle} />
      <input value={form.phone} onChange={update('phone')} disabled={busy} placeholder="Phone" type="tel" autoComplete="tel" style={inputStyle} />
      <input value={form.email} onChange={update('email')} disabled={busy} placeholder="Email" type="email" autoComplete="email" style={inputStyle} />
      <input value={form.best_time} onChange={update('best_time')} disabled={busy} placeholder="Best time to reach you (optional)" style={inputStyle} />
      <button type="submit" disabled={busy} style={{ minHeight: 50, border: 'none', borderRadius: 10, background: COLORS.yellow, color: TEXT, fontFamily: FONTS.heading, fontSize: 16, fontWeight: 800, cursor: busy ? 'not-allowed' : 'pointer', opacity: status === 'loading' ? 0.7 : 1 }}>
        {status === 'loading' ? 'Sending…' : 'Get my free lawn plan'}
      </button>
      {error ? (
        <div role="alert" style={{ background: '#FEF2F2', border: `1px solid ${COLORS.red}`, color: COLORS.red, borderRadius: 10, padding: '10px 12px', fontSize: 14, lineHeight: 1.45 }}>{error}</div>
      ) : null}
    </form>
  );
}

export default function LawnReportViewPage() {
  const { token } = useParams();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/public/lawn-diagnostic/${token}`);
      if (res.status === 404) { setNotFound(true); setLoading(false); return; }
      if (!res.ok) throw new Error(`lawn report fetch failed: ${res.status}`);
      const body = await res.json();
      setReport(body.report || null);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <Page>
        <SectionCard style={{ height: 120 }} />
        <SectionCard style={{ height: 220 }} />
      </Page>
    );
  }
  if (notFound || !report) {
    return <Page><NotFoundCard /></Page>;
  }

  const placeLabel = report.city ? `your ${report.city} lawn` : 'your lawn';
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const expectationItems = Object.entries(report.expectations || {}).filter(([, v]) => v);
  const watchItems = (report.watch_items || []).filter(Boolean);

  return (
    <Page>
      {/* Hero */}
      <SectionCard style={{ background: TAN }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
          <h1 style={{ fontFamily: FONTS.serif, fontSize: 26, fontWeight: 500, lineHeight: 1.18, color: TEXT, margin: 0 }}>
            Here&apos;s what we saw at {placeLabel}
          </h1>
          <StatusPill label={report.overall_status || 'Reviewed'} />
        </div>
        {report.summary ? (
          <p style={{ margin: 0, color: BODY, fontSize: 15, lineHeight: 1.6 }}>{report.summary}</p>
        ) : null}
      </SectionCard>

      {/* Lawn health at a glance */}
      {findings.length ? (
        <SectionCard>
          <SectionTitle>What we found</SectionTitle>
          <div style={{ display: 'grid', gap: 10 }}>
            {findings.map((f, i) => (
              <div key={`${f.name}-${i}`} style={{ border: `1px solid ${BORDER}`, borderLeft: `4px solid ${SEVERITY_DOT[f.severity] || COLORS.teal}`, borderRadius: 10, background: COLORS.white, padding: '12px 14px' }}>
                <div style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 15, color: TEXT, marginBottom: f.customer_note ? 4 : 0 }}>{f.name}</div>
                {f.customer_note ? <div style={{ fontSize: 14, color: BODY, lineHeight: 1.5 }}>{f.customer_note}</div> : null}
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}

      {/* The plan: watering + expectations + watch items */}
      {(report.watering?.customer_sequence || report.watering?.restriction_summary || expectationItems.length || watchItems.length) ? (
        <SectionCard>
          <SectionTitle>Your plan &amp; what to expect</SectionTitle>
          {report.watering?.customer_sequence ? (
            <p style={{ margin: '0 0 10px', color: BODY, fontSize: 15, lineHeight: 1.55 }}>{report.watering.customer_sequence}</p>
          ) : null}
          {report.watering?.restriction_summary ? (
            <p style={{ margin: '0 0 10px', color: MUTED, fontSize: 14, lineHeight: 1.5 }}>{report.watering.restriction_summary}</p>
          ) : null}
          {expectationItems.length ? (
            <ul style={{ margin: '6px 0 0', padding: '0 0 0 18px', color: BODY, fontSize: 14, lineHeight: 1.6 }}>
              {expectationItems.map(([key, val]) => <li key={key}>{val}</li>)}
            </ul>
          ) : null}
          {watchItems.length ? (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${BORDER}` }}>
              <div style={{ fontSize: 13, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, marginBottom: 6 }}>What we&apos;ll keep an eye on</div>
              <ul style={{ margin: 0, padding: '0 0 0 18px', color: BODY, fontSize: 14, lineHeight: 1.6 }}>
                {watchItems.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {report.seasonal_context ? (
        <SectionCard style={{ background: COLORS.sand, border: `1px solid ${BORDER}` }}>
          <div style={{ fontSize: 13, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, marginBottom: 6 }}>Right now in Southwest Florida</div>
          <p style={{ margin: 0, color: BODY, fontSize: 14, lineHeight: 1.55 }}>{report.seasonal_context}</p>
        </SectionCard>
      ) : null}

      {/* CTA */}
      <SectionCard style={{ background: TAN }}>
        <SectionTitle>Want us to take care of it?</SectionTitle>
        <p style={{ margin: '0 0 14px', color: BODY, fontSize: 15, lineHeight: 1.55 }}>
          Tell us how to reach you and we&apos;ll put together a free, no-pressure plan to get {placeLabel} where you want it.
        </p>
        <QuoteRequestForm token={token} firstName={report.first_name} />
      </SectionCard>

      <GuaranteeStrip />
      <QuestionsEscapeHatch estimateSlug={token} />
    </Page>
  );
}
