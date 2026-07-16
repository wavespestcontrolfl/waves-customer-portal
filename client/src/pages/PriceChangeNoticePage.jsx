// Tokened price-change notice page (owner policy 2026-07-12): the full,
// formal advance notice the short email/SMS link to. Renders the customer's
// current → new price, the effective date, what stays the same, and the
// no-action-needed / cancel-anytime terms — never "renewal" language (the
// recurring service has no fixed term).
import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { WavesShell } from '../components/brand';
import BrandFooter from '../components/BrandFooter';
import DocumentActionBar from '../components/DocumentActionBar';
import PublicLoadError from '../components/PublicLoadError';
import { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_PHONE_TEL } from '../constants/business';
import { useGlassSurface } from '../glass/glass-engine';
import {
  DOC,
  DOC_FONT,
  DOC_FONT_SERIF,
  DOC_COLUMN_MAX,
  FS,
  FW,
  LH,
  SP,
  RADIUS,
  SHADOW,
  docButton,
} from '../theme-doc';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const SURFACE = {
  page: DOC.page,
  card: DOC.surface,
  border: DOC.border,
  text: DOC.ink,
  body: DOC.muted,
  muted: DOC.supporting,
  calloutBg: '#F0F7F1',
  calloutBorder: '#3E8E5A',
  detailBg: '#F9F8F5',
};

const PRINT_STYLE = `
@media print {
  body { background: white !important; }
  .pcn-no-print { display: none !important; }
  .pcn-card { box-shadow: none !important; border: none !important; }
}
`;

function LoadingSkeleton() {
  return (
    <div style={{ padding: `${SP.xl}px ${SP.md}px 40px`, maxWidth: DOC_COLUMN_MAX, width: '100%', margin: '0 auto' }}>
      <div style={{ height: 28, width: '70%', background: SURFACE.border, borderRadius: RADIUS.tag, marginBottom: SP.md }} />
      <div style={{ height: 96, background: SURFACE.border, borderRadius: RADIUS.input, marginBottom: SP.lg }} />
      <div style={{ height: 16, width: '90%', background: SURFACE.border, borderRadius: 4, marginBottom: SP.sm }} />
      <div style={{ height: 16, width: '80%', background: SURFACE.border, borderRadius: 4 }} />
    </div>
  );
}

function NotFound() {
  return (
    <div style={{ padding: `${SP.gap}px ${SP.xl}px`, textAlign: 'center', maxWidth: 440, margin: '0 auto' }}>
      <h2 style={{ fontSize: FS.h3, fontWeight: FW.semibold, color: SURFACE.text, margin: `0 0 ${SP.sm}px`, lineHeight: LH.heading, fontFamily: DOC_FONT_SERIF }}>
        Notice not found
      </h2>
      <p style={{ fontSize: FS.bodyLg, color: SURFACE.body, lineHeight: LH.body, margin: `0 0 ${SP.xl}px` }}>
        This link is no longer available. If you have a question about your service pricing, give us a call — we're happy to help.
      </p>
      <a href={WAVES_SUPPORT_PHONE_TEL} data-glass-accent="" style={docButton('primary')}>
        Call {WAVES_SUPPORT_PHONE_DISPLAY}
      </a>
    </div>
  );
}

export default function PriceChangeNoticePage() {
  const { token } = useParams();
  useGlassSurface(true, 'full');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null); // null | notfound | temporary
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${API_BASE}/public/price-change/${token}`);
        if (res.status === 404 || res.status === 410) { if (!cancelled) setError('notfound'); return; }
        if (!res.ok) { if (!cancelled) setError('temporary'); return; }
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setError('temporary');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [token, loadAttempt]);

  const content = loading
    ? <LoadingSkeleton />
    : error === 'temporary'
      ? <PublicLoadError resource="pricing notice" onRetry={() => setLoadAttempt(a => a + 1)} />
    : error === 'notfound' || !data
      ? <NotFound />
      : (
        <div style={{ padding: `${SP.xl}px ${SP.md}px 40px`, maxWidth: DOC_COLUMN_MAX, width: '100%', margin: '0 auto', fontFamily: DOC_FONT, color: SURFACE.text }}>
          <DocumentActionBar shareTitle="Waves service pricing update" />
          <div
            className="pcn-card"
            data-glass="card"
            style={{
              background: SURFACE.card, borderRadius: RADIUS.card,
              border: `1px solid ${SURFACE.border}`,
              boxShadow: SHADOW.card,
              padding: '28px 24px 32px',
            }}
          >
            <h1 style={{
              fontFamily: DOC_FONT_SERIF, fontSize: FS.h2, fontWeight: FW.bold,
              color: SURFACE.text, margin: `0 0 ${SP.sm}px`, lineHeight: LH.heading,
            }}>
              An update to your recurring service
            </h1>
            <p style={{ fontSize: FS.bodyLg, lineHeight: LH.body, color: SURFACE.body, margin: `0 0 ${SP.lg}px` }}>
              Hi {data.firstName} — thank you for trusting Waves Pest Control to protect your home.
              This is your formal advance notice of an upcoming adjustment to your recurring service price.
            </p>

            <div data-glass="soft" style={{
              background: SURFACE.detailBg, borderRadius: RADIUS.input,
              padding: `${SP.md}px ${SP.lg}px`, margin: `0 0 ${SP.lg}px`,
            }}>
              {[
                ['Current price', `${data.currentPrice} / ${data.cadenceLabel}`],
                ['New price', `${data.newPrice} / ${data.cadenceLabel}`],
                ['Effective date', data.effectiveDate],
              ].map(([label, value], i, arr) => (
                <div key={label} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                  padding: `${SP.xs}px 0`, borderBottom: i < arr.length - 1 ? `1px solid ${SURFACE.border}` : 'none',
                }}>
                  <span style={{ fontSize: FS.body, fontWeight: FW.medium, color: SURFACE.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    {label}
                  </span>
                  <span style={{ fontSize: FS.bodyLg, color: SURFACE.text, fontWeight: FW.semibold }}>
                    {value}
                  </span>
                </div>
              ))}
            </div>

            <h2 style={{ fontFamily: DOC_FONT_SERIF, fontSize: FS.h3, fontWeight: FW.semibold, color: SURFACE.text, margin: `0 0 ${SP.sm}px`, lineHeight: LH.heading }}>
              What stays the same
            </h2>
            <p style={{ fontSize: FS.bodyLg, lineHeight: LH.body, color: SURFACE.body, margin: `0 0 ${SP.md}px` }}>
              Your service frequency and included protection remain exactly as they are today — the
              same scheduled treatments, the same covered pests, and the same free re-service between
              visits whenever you see covered activity.
            </p>
            <p style={{ fontSize: FS.bodyLg, lineHeight: LH.body, color: SURFACE.body, margin: `0 0 ${SP.lg}px` }}>
              This adjustment allows us to continue providing dependable service, properly trained
              technicians, and the products and equipment required to protect your property effectively.
            </p>

            <div style={{
              borderLeft: `4px solid ${SURFACE.calloutBorder}`,
              background: SURFACE.calloutBg,
              borderRadius: `0 ${RADIUS.input}px ${RADIUS.input}px 0`,
              padding: `${SP.md}px ${SP.lg}px`,
              margin: `0 0 ${SP.lg}px`,
              fontSize: FS.bodyLg, lineHeight: LH.body, color: SURFACE.body,
            }}>
              <strong style={{ color: SURFACE.text }}>No action is needed to continue your service.</strong>{' '}
              Waves does not require a long-term contract — you can make changes to or cancel your
              recurring service at any time by contacting us.
            </div>

            <div style={{ marginTop: SP.lg, paddingTop: SP.lg, borderTop: `1px solid ${SURFACE.border}` }}>
              <p style={{ fontSize: FS.body, color: SURFACE.muted, lineHeight: LH.body, margin: 0 }}>
                Questions about this change? Call or text us at{' '}
                <a href={WAVES_SUPPORT_PHONE_TEL} style={{ color: SURFACE.text, fontWeight: FW.medium }}>
                  {data.supportPhone || WAVES_SUPPORT_PHONE_DISPLAY}
                </a>
                {' '}— we're happy to walk through it.
              </p>
            </div>
          </div>
        </div>
      );

  return (
    <>
      <style>{PRINT_STYLE}</style>
      <meta name="robots" content="noindex, nofollow" />
      <WavesShell variant="customer" topBar="solid">
        <div data-glass-clear="" style={{ flex: 1, minHeight: '100vh', background: SURFACE.page }}>
          {content}
          <div className="pcn-no-print" style={{ maxWidth: DOC_COLUMN_MAX, width: '100%', margin: '0 auto', padding: `0 ${SP.md}px 40px`, fontFamily: DOC_FONT }}>
            <BrandFooter />
          </div>
        </div>
      </WavesShell>
    </>
  );
}
