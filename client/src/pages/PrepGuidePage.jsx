import { useState, useEffect } from 'react';
import { CUSTOMER_SURFACE } from '../theme-customer';
import { useParams } from 'react-router-dom';
import { WavesShell } from '../components/brand';
import BrandFooter from '../components/BrandFooter';
import { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_PHONE_TEL } from '../constants/business';
import { useGlassSurface } from '../glass/glass-engine';
import { isNativeApp } from '../native/platform';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const FONT_BODY = "'Inter', system-ui, sans-serif";
const FONT_SERIF = "'Source Serif 4', 'Georgia', serif";

const SURFACE = {
  page: '#FAF8F3',
  card: '#FFFFFF',
  border: '#E7E2D7',
  text: '#1B2C5B',
  body: '#3F4A65',
  muted: CUSTOMER_SURFACE.muted,
  calloutBg: '#FDF6EC',
  // Glass gold, not the old marketing #FFD700 — border colors aren't
  // repainted by the glass theme CSS, so the literal must be spec-correct.
  calloutBorder: '#F0A500',
  detailBg: '#F9F8F5',
};

const PRINT_STYLE = `
@media print {
  body { background: white !important; }
  .prep-no-print { display: none !important; }
  .prep-card { box-shadow: none !important; border: none !important; }
}
`;

function BlockRenderer({ blocks }) {
  if (!Array.isArray(blocks) || !blocks.length) return null;
  return blocks.map((block, i) => {
    switch (block.type) {
      case 'paragraph':
        return (
          <p key={i} style={{ fontSize: 15, lineHeight: 1.65, color: SURFACE.body, margin: '0 0 16px' }}>
            {block.content}
          </p>
        );
      case 'heading':
        return (
          <h2 key={i} style={{
            fontFamily: FONT_SERIF, fontSize: 22, fontWeight: 600,
            color: SURFACE.text, margin: '28px 0 16px', lineHeight: 1.3,
          }}>
            {block.content}
          </h2>
        );
      case 'details':
        return (
          <div key={i} data-glass="soft" style={{
            background: SURFACE.detailBg, borderRadius: 8,
            padding: '14px 18px', margin: '0 0 20px',
          }}>
            {(block.rows || []).map((row, j) => (
              <div key={j} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                padding: '5px 0', borderBottom: j < block.rows.length - 1 ? `1px solid ${SURFACE.border}` : 'none',
              }}>
                <span style={{ fontSize: 14, fontWeight: 500, color: SURFACE.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  {row.label}
                </span>
                <span style={{ fontSize: 14, color: SURFACE.text, fontWeight: 500, textAlign: 'right', maxWidth: '60%' }}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        );
      case 'callout':
        return (
          <div key={i} style={{
            borderLeft: `4px solid ${SURFACE.calloutBorder}`,
            background: SURFACE.calloutBg,
            borderRadius: '0 8px 8px 0',
            padding: '14px 18px',
            margin: '20px 0',
            fontSize: 14, lineHeight: 1.6, color: SURFACE.body,
          }}>
            {block.content}
          </div>
        );
      default:
        return null;
    }
  });
}

function LoadingSkeleton() {
  return (
    <div style={{ padding: '24px 16px 40px', maxWidth: 560, width: '100%', margin: '0 auto' }}>
      <div style={{ height: 28, width: '70%', background: SURFACE.border, borderRadius: 6, marginBottom: 16 }} />
      <div style={{ height: 80, background: SURFACE.border, borderRadius: 8, marginBottom: 20 }} />
      <div style={{ height: 16, width: '90%', background: SURFACE.border, borderRadius: 4, marginBottom: 12 }} />
      <div style={{ height: 16, width: '80%', background: SURFACE.border, borderRadius: 4, marginBottom: 12 }} />
      <div style={{ height: 16, width: '85%', background: SURFACE.border, borderRadius: 4 }} />
    </div>
  );
}

function NotFound() {
  return (
    <div style={{ padding: '48px 24px', textAlign: 'center', maxWidth: 440, margin: '0 auto' }}>
      <div style={{ fontSize: 20, fontWeight: 600, color: SURFACE.text, marginBottom: 12, fontFamily: FONT_SERIF }}>
        Prep guide not found
      </div>
      <p style={{ fontSize: 15, color: SURFACE.body, lineHeight: 1.6, margin: '0 0 24px' }}>
        This link may have expired or is no longer available. If you need help preparing for your service, give us a call.
      </p>
      <a
        href={WAVES_SUPPORT_PHONE_TEL}
        data-glass-accent=""
        style={{
          display: 'inline-block', padding: '12px 28px',
          background: SURFACE.text, color: '#fff', borderRadius: 8,
          fontWeight: 600, fontSize: 15, textDecoration: 'none',
        }}
      >
        Call {WAVES_SUPPORT_PHONE_DISPLAY}
      </a>
    </div>
  );
}

export default function PrepGuidePage() {
  const { token } = useParams();
  useGlassSurface(true, 'full');
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`${API_BASE}/public/prep/${token}`);
        if (!res.ok) { if (!cancelled) setError(true); return; }
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [token]);

  const content = loading
    ? <LoadingSkeleton />
    : error || !data
      ? <NotFound />
      : (
        <div style={{ padding: '24px 16px 40px', maxWidth: 560, width: '100%', margin: '0 auto', fontFamily: FONT_BODY, color: SURFACE.text }}>
          <div
            className="prep-card"
            data-glass="card"
            style={{
              background: SURFACE.card, borderRadius: 12,
              border: `1px solid ${SURFACE.border}`,
              boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
              padding: '28px 24px 32px',
            }}
          >
            <h1 style={{
              fontFamily: FONT_SERIF, fontSize: 24, fontWeight: 700,
              color: SURFACE.text, margin: '0 0 4px', lineHeight: 1.25,
            }}>
              {data.projectTypeLabel} Prep Guide
            </h1>
            {data.technicianName && (
              <p style={{ fontSize: 14, color: SURFACE.muted, margin: '0 0 24px' }}>
                Your technician: {data.technicianName}
              </p>
            )}

            <BlockRenderer blocks={data.blocks} />

            <div style={{ marginTop: 28, paddingTop: 20, borderTop: `1px solid ${SURFACE.border}` }}>
              <p style={{ fontSize: 14, color: SURFACE.muted, lineHeight: 1.5, margin: 0 }}>
                Questions? Call or text us at{' '}
                <a href={WAVES_SUPPORT_PHONE_TEL} style={{ color: SURFACE.text, fontWeight: 500 }}>
                  {data.supportPhone || WAVES_SUPPORT_PHONE_DISPLAY}
                </a>
              </p>
            </div>
          </div>

          {/* window.print() is a no-op in the Capacitor webview (F-046) —
              a dead button is worse than no button, so hide it in-app. */}
          {isNativeApp() ? null : (
          <div className="prep-no-print" style={{ textAlign: 'center', marginTop: 20 }}>
            <button
              onClick={() => window.print()}
              data-glass="chip"
              style={{
                background: 'transparent', border: `1px solid ${SURFACE.border}`,
                borderRadius: 8, padding: '10px 24px', cursor: 'pointer',
                fontSize: 14, fontWeight: 500, color: SURFACE.muted,
                fontFamily: FONT_BODY,
              }}
            >
              Print this page
            </button>
          </div>
          )}
        </div>
      );

  return (
    <>
      <style>{PRINT_STYLE}</style>
      <meta name="robots" content="noindex, nofollow" />
      <WavesShell variant="customer" topBar="solid">
        <div data-glass-clear="" style={{ flex: 1, minHeight: '100vh', background: SURFACE.page }}>
          {content}
          <div className="prep-no-print" style={{ maxWidth: 560, width: '100%', margin: '0 auto', padding: '0 16px 40px', fontFamily: FONT_BODY }}>
            <BrandFooter />
          </div>
        </div>
      </WavesShell>
    </>
  );
}
