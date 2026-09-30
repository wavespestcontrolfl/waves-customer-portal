import { COLORS, FONTS } from '../theme-brand';
import { CUSTOMER_SURFACE } from '../theme-customer';
import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import PublicLoadError from '../components/PublicLoadError';
import { CustomerColumn } from '../components/brand';
import { useGlassSurface } from '../glass/glass-engine';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const PAGE_BG = '#FAF8F3';
const CARD_BORDER = '#E7E2D7';
const INPUT_BORDER = '#CFE7F5';
const INPUT_BG = '#F8FCFE';
const TEXT = COLORS.glassNavy;
const BODY = '#3F4A65';
const MUTED = CUSTOMER_SURFACE.muted;

const primaryActionStyle = {
  minHeight: 46,
  border: 'none',
  borderRadius: 10,
  background: COLORS.glassNavy,
  color: COLORS.white,
  fontSize: 16,
  fontWeight: 700,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  textDecoration: 'none',
  boxShadow: 'none',
  textTransform: 'none',
  letterSpacing: 0,
};

export default function RatePage() {
  const { token } = useParams();
  // ?retry=1: /go fell back here on a failure — say so instead of looping silently.
  const [searchParams] = useSearchParams();
  const showRetry = searchParams.get('retry') === '1';
  useGlassSurface(true);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null); // null | notfound | temporary
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/rate/${token}`)
      .then(r => {
        if (r.status === 404 || r.status === 410) { const err = new Error('notfound'); err.notFound = true; throw err; }
        if (!r.ok) throw new Error('temporary');
        return r.json();
      })
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.notFound ? 'notfound' : 'temporary'); setLoading(false); });
  }, [token, loadAttempt]);

  const techName = data?.techName || 'your technician';
  const techPhotoUrl = data?.techPhotoUrl || null;

  if (loading) return (
    <Page>
      <div style={{ textAlign: 'center', padding: 48 }}>
        <style>{`@media (prefers-reduced-motion: reduce) { [data-rate-spinner] { animation: none !important; } }`}</style>
        <div data-rate-spinner="" style={{ width: 32, height: 32, border: `3px solid ${CARD_BORDER}`, borderTopColor: COLORS.glassNavy, borderRadius: '50%', animation: 'spin .7s linear infinite', margin: '0 auto 14px' }} />
        <span style={{ fontSize: 14, color: MUTED }}>Loading...</span>
      </div>
    </Page>
  );

  if (error === 'temporary') return (
    // CustomerColumn, not a hand-rolled wrapper: my first pass at un-nesting
    // this kept the page card's `calc(100% - 24px)` / 420 cap, which capped the
    // state card at 420 with 12px gutters and defeated its own 560 / 16. A
    // parent constraint bypasses the component's prop filtering entirely.
    <Scene>
      <CustomerColumn style={{ position: 'relative', zIndex: 1 }}>
        <PublicLoadError resource="feedback request" onRetry={() => setLoadAttempt(a => a + 1)} />
      </CustomerColumn>
    </Scene>
  );

  if (error === 'notfound') return (
    <Page>
      <div role="alert" style={{ textAlign: 'center', padding: 36, color: BODY, fontSize: 16, lineHeight: 1.5 }}>
        <p>This link may have expired or already been used.</p>
        <p style={{ marginTop: 12 }}><a href="https://wavespestcontrol.com" style={{ color: COLORS.glassNavy, fontWeight: 700, textDecoration: 'none' }}>Visit wavespestcontrol.com</a></p>
      </div>
    </Page>
  );

  // The 1-10 rating is retired (owner ruling 2026-09-29): a thank-you and ONE
  // tap to Google. The server sends reviewUrl only when the request is still
  // open and the customer has not already reviewed — otherwise the thank-you
  // stands alone.
  return (
    <Page>
      <div style={{ textAlign: 'center', padding: '20px 0' }}>
        {!data?.alreadySubmitted && (
          techPhotoUrl ? (
            <img
              src={techPhotoUrl}
              alt={techName}
              referrerPolicy="no-referrer"
              style={{ width: 80, height: 80, borderRadius: '50%', objectFit: 'cover', margin: '0 auto 12px', display: 'block', boxShadow: '0 4px 20px rgba(0,156,222,0.35)' }}
            />
          ) : (
            <div style={{ width: 80, height: 80, borderRadius: '50%', background: INPUT_BG, border: `1px solid ${INPUT_BORDER}`, margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, fontWeight: 700, color: COLORS.glassNavy, fontFamily: FONTS.body }}>
              {(techName || 'W')[0].toUpperCase()}
            </div>
          )
        )}
        <div style={{ fontFamily: FONTS.serif, fontSize: 30, fontWeight: 500, color: TEXT, marginBottom: 8 }}>Thank you!</div>
        {data?.reviewUrl ? (
          <>
            {showRetry && (
              <div role="alert" style={{ fontSize: 14, lineHeight: 1.45, color: BODY, fontWeight: 700, marginBottom: 10 }}>
                Couldn't open Google just now — please try again in a minute.
              </div>
            )}
            <div style={{ fontSize: 14, lineHeight: 1.45, color: MUTED }}>
              Public Google reviews help local neighbors choose a provider.
            </div>
            <a href={data.reviewUrl} data-glass-accent="" style={{ ...primaryActionStyle, width: '100%', marginTop: 16, boxSizing: 'border-box' }}>
              Open Google
            </a>
          </>
        ) : (
          <div style={{ fontSize: 16, color: BODY, lineHeight: 1.55 }}>Your feedback helps us serve you better.</div>
        )}
      </div>
    </Page>
  );
}

// The page scene, without the card. Split out because PublicLoadError now owns
// a card of its own: rendering it inside <Page> nested one glass card in
// another, with duplicate material and padding, on the one production path
// that shows it.
function Scene({ children }) {
  return (
    <div data-glass-clear="" style={{ flex: 1, paddingBottom: 40, background: PAGE_BG, display: 'flex', flexDirection: 'column', alignItems: 'center', fontFamily: FONTS.body, position: 'relative', overflow: 'hidden' }}>
      {children}
      {/* Anton / Montserrat / Inter load globally via client/index.html */}
    </div>
  );
}

function Page({ children }) {
  return (
    <Scene>
      <div data-glass="card" style={{ position: 'relative', zIndex: 1, width: 'calc(100% - 24px)', maxWidth: 420, background: COLORS.white, borderRadius: 8, border: `1px solid ${CARD_BORDER}`, boxShadow: 'none', overflow: 'hidden', marginTop: 'clamp(20px, 8dvh, 64px)' }}>
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${CARD_BORDER}`, display: 'flex', justifyContent: 'center' }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 34, display: 'block' }} />
        </div>
        <div style={{ padding: '28px clamp(12px, 5vw, 22px) 24px' }}>
          {children}
        </div>
      </div>
    </Scene>
  );
}
