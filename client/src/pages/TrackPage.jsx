// client/src/pages/TrackPage.jsx
//
// Public /track/:token route — customer-facing real-time tracking.
//
// Phase 1 ships all five states (scheduled / en_route / on_property /
// complete / cancelled + expired fallback) WITHOUT the live map or truck
// animation. The map + Bouncie vehicle data land in Phase 2 once the
// webhook + vehicle_locations wiring is confirmed.
//
// Design: warm customer-facing brand (Waves blue + gold), per the
// customer-facing design brief. NOT the admin monochrome spec.
//
// Polling: server returns meta.pollIntervalSeconds; 0 means stop.

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import BrandFooter from '../components/BrandFooter';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const B = {
  navy: '#1B2C5B',
  blue: '#009CDE',
  gold: '#FFD700',
  sand: '#FDF6EC',
  ink: '#334155',
  muted: '#64748B',
  green: '#16A34A',
  red: '#C8102E',
  card: '#FFFFFF',
  border: '#E5E7EB',
};

const FONTS = {
  display: '"Anton", "Luckiest Guy", sans-serif',
  heading: '"Montserrat", sans-serif',
  body: '"Inter", system-ui, sans-serif',
};

function fmtWindow(startIso, endIso) {
  if (!startIso) return '';
  const start = new Date(startIso);
  const end = endIso ? new Date(endIso) : null;
  const opts = { hour: 'numeric', minute: '2-digit', hour12: true };
  const s = start.toLocaleTimeString('en-US', opts).replace(':00', '');
  const e = end ? end.toLocaleTimeString('en-US', opts).replace(':00', '') : '';
  return e ? `${s} – ${e}` : s;
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

function StatusPill({ state, lateFlag }) {
  const cfg = (() => {
    if (state === 'scheduled' && lateFlag) return { bg: '#FEF3C7', color: '#92400E', label: 'Running a bit late' };
    if (state === 'scheduled') return { bg: `${B.blue}22`, color: B.navy, label: 'Scheduled' };
    if (state === 'en_route') return { bg: `${B.blue}22`, color: B.blue, label: 'On the way' };
    if (state === 'on_property') return { bg: `${B.green}22`, color: B.green, label: 'Service in progress' };
    if (state === 'complete') return { bg: `${B.green}22`, color: B.green, label: 'Service complete' };
    if (state === 'cancelled') return { bg: `${B.red}22`, color: B.red, label: 'Cancelled' };
    if (state === 'expired') return { bg: '#E5E7EB', color: B.muted, label: 'Link expired' };
    return { bg: '#E5E7EB', color: B.muted, label: state || 'Unknown' };
  })();
  return (
    <span style={{
      display: 'inline-block', padding: '4px 12px', borderRadius: 999,
      background: cfg.bg, color: cfg.color, fontSize: 12, fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: 0.6,
    }}>{cfg.label}</span>
  );
}

function Hero({ data }) {
  const techName = data?.tech?.firstName;
  const win = fmtWindow(data?.window?.start, data?.window?.end);
  const headline = (() => {
    if (data.state === 'scheduled') return techName ? `${techName} is on for your ${data.service?.type || 'service'}` : 'Your service is on the way';
    if (data.state === 'en_route') return `${techName || 'Your tech'} is headed your way`;
    if (data.state === 'on_property') return `${techName || 'Your tech'} is working on your property`;
    if (data.state === 'complete') return 'Service complete — thanks for choosing Waves';
    if (data.state === 'cancelled') return 'This appointment was cancelled';
    if (data.state === 'expired') return 'This tracking link has expired';
    return '';
  })();
  const sub = (() => {
    if (data.state === 'scheduled') return `${fmtDate(data?.window?.start)} · ${win}`;
    if (data.state === 'en_route') return 'We\'ll show you on the map once we\'re close by';
    if (data.state === 'on_property') return 'Feel free to step outside and say hi';
    if (data.state === 'complete') return 'A summary + invoice is below';
    if (data.state === 'cancelled') return data.cancellationReason || 'Your appointment has been cancelled. Contact us to reschedule.';
    if (data.state === 'expired') return 'If this is an active appointment, please contact us at (941) 318-7612';
    return '';
  })();
  return (
    <div style={{
      background: B.card, borderRadius: 20,
      border: `2px solid ${B.blue}22`,
      padding: '28px 20px', textAlign: 'center',
      boxShadow: '0 4px 24px rgba(27,44,91,0.08)',
    }}>
      <StatusPill state={data.state} lateFlag={data.meta?.lateFlag} />
      <h1 style={{
        fontFamily: FONTS.display, fontSize: 'clamp(22px, 5vw, 30px)',
        fontWeight: 800, color: B.navy, margin: '16px 0 6px',
        letterSpacing: '0.01em', lineHeight: 1.15,
      }}>{headline}</h1>
      <div style={{ fontSize: 15, color: B.ink, lineHeight: 1.55 }}>{sub}</div>
    </div>
  );
}

function TechCard({ tech }) {
  if (!tech?.firstName) return null;
  return (
    <div style={{
      background: B.card, borderRadius: 16, padding: 16, border: `1px solid ${B.border}`,
      display: 'flex', alignItems: 'center', gap: 14,
    }}>
      <div style={{
        width: 56, height: 56, borderRadius: '50%', background: B.blue + '22',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 22, fontWeight: 700, color: B.blue, overflow: 'hidden',
      }}>
        {tech.photoUrl
          ? <img src={tech.photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : tech.firstName.charAt(0).toUpperCase()}
      </div>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: B.navy }}>{tech.firstName}</div>
        <div style={{ fontSize: 12, color: B.muted, marginTop: 2 }}>
          {tech.yearsWithWaves ? `${tech.yearsWithWaves} year${tech.yearsWithWaves === 1 ? '' : 's'} with Waves` : 'Waves certified tech'}
          {tech.certifications && tech.certifications.length > 0
            ? ` · ${tech.certifications.slice(0, 2).join(', ')}` : ''}
        </div>
      </div>
    </div>
  );
}

function ServiceCard({ service, address }) {
  return (
    <div style={{
      background: B.card, borderRadius: 16, padding: 16, border: `1px solid ${B.border}`,
    }}>
      <div style={{ fontSize: 11, color: B.muted, textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: 700, marginBottom: 6 }}>Service</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: B.navy, marginBottom: 4 }}>{service?.type || '—'}</div>
      {address && <div style={{ fontSize: 13, color: B.muted }}>{address}</div>}
    </div>
  );
}

function SummaryCard({ summary }) {
  if (!summary) return null;
  return (
    <div style={{
      background: B.card, borderRadius: 16, padding: 16, border: `1px solid ${B.border}`,
    }}>
      <div style={{ fontSize: 11, color: B.muted, textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: 700, marginBottom: 12 }}>Summary</div>
      {summary.photos?.length > 0 && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(80px, 1fr))',
          gap: 8, marginBottom: 14,
        }}>
          {summary.photos.map((p, i) => (
            <img key={i} src={p} alt="" style={{
              width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 10, border: `1px solid ${B.border}`,
            }} />
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {summary.invoiceToken && (
          <a href={`/pay/${summary.invoiceToken}`} style={{
            padding: '10px 16px', borderRadius: 999, background: B.navy, color: '#fff',
            textDecoration: 'none', fontSize: 14, fontWeight: 700,
          }}>View invoice</a>
        )}
        {summary.reviewUrl && (
          <a href={summary.reviewUrl} target="_blank" rel="noreferrer" style={{
            padding: '10px 16px', borderRadius: 999, background: B.gold, color: B.navy,
            textDecoration: 'none', fontSize: 14, fontWeight: 700,
          }}>Leave a review</a>
        )}
      </div>
    </div>
  );
}

export default function TrackPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const pollTimer = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/public/track/${token}`);
      if (r.status === 404) { setError('not-found'); setLoading(false); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setData(d);
      setLoading(false);

      // Server-controlled polling cadence.
      const next = d?.meta?.pollIntervalSeconds;
      if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null; }
      if (next && next > 0) {
        pollTimer.current = setTimeout(load, next * 1000);
      }
    } catch (e) {
      setError(e.message || 'Failed to load tracking');
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
    return () => { if (pollTimer.current) clearTimeout(pollTimer.current); };
  }, [load]);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: B.sand, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONTS.body }}>
        <div style={{ color: B.muted, fontSize: 15 }}>Loading…</div>
      </div>
    );
  }

  if (error === 'not-found') {
    return (
      <div style={{ minHeight: '100vh', background: B.sand, padding: 24, fontFamily: FONTS.body }}>
        <div style={{ maxWidth: 520, margin: '40px auto', textAlign: 'center', padding: 32, background: B.card, borderRadius: 20 }}>
          <h1 style={{ fontFamily: FONTS.display, fontSize: 28, color: B.navy, marginBottom: 12 }}>Link not found</h1>
          <p style={{ fontSize: 15, color: B.ink, lineHeight: 1.6 }}>
            This tracking link is invalid or has expired. If you're expecting a Waves visit, please call us at <a href="tel:+19413187612" style={{ color: B.blue, textDecoration: 'none', fontWeight: 700 }}>(941) 318-7612</a>.
          </p>
        </div>
      </div>
    );
  }

  const address = [data?.property?.addressLine1].filter(Boolean).join('');

  return (
    <div style={{
      minHeight: '100vh', background: B.sand, padding: '20px 16px', fontFamily: FONTS.body, color: B.ink,
    }}>
      <div style={{ maxWidth: 520, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Hero data={data} />

        {/* Phase 2 will insert the live map + truck here — keeping the
            layout stable so we drop in without re-shuffling state cards. */}
        {['en_route', 'on_property'].includes(data.state) && (
          <div style={{
            background: B.card, borderRadius: 16, padding: '40px 20px', border: `1px solid ${B.border}`,
            textAlign: 'center', color: B.muted, fontSize: 13,
          }}>
            Live map + ETA coming soon.
          </div>
        )}

        {data.tech && data.state !== 'complete' && <TechCard tech={data.tech} />}
        {data.state !== 'cancelled' && data.state !== 'expired' && (
          <ServiceCard service={data.service} address={address} />
        )}
        {data.state === 'complete' && <SummaryCard summary={data.summary} />}

        <div style={{ textAlign: 'center', fontSize: 13, color: B.muted, padding: '12px 0' }}>
          Questions? Call us at <a href="tel:+19413187612" style={{ color: B.blue, textDecoration: 'none', fontWeight: 700 }}>(941) 318-7612</a>
        </div>
      </div>

      <BrandFooter />
    </div>
  );
}
