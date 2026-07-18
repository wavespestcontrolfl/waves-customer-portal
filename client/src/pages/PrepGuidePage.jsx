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
          <p key={i} style={{ fontSize: FS.bodyLg, lineHeight: LH.body, color: SURFACE.body, margin: `0 0 ${SP.md}px` }}>
            {block.content}
          </p>
        );
      case 'heading':
        return (
          <h2 key={i} style={{
            fontFamily: DOC_FONT_SERIF, fontSize: FS.h2, fontWeight: FW.semibold,
            color: SURFACE.text, margin: `28px 0 ${SP.md}px`, lineHeight: LH.heading,
          }}>
            {block.content}
          </h2>
        );
      case 'details':
        // FAQ variant (prep content refresh): multi-sentence answers read as
        // question-over-answer, single column — the two-column service-info
        // layout squeezes long answers beside long questions on mobile.
        if (block.variant === 'faq') {
          return (
            <div key={i} data-glass="soft" style={{
              background: SURFACE.detailBg, borderRadius: RADIUS.input,
              padding: `${SP.md}px ${SP.lg}px`, margin: `0 0 ${SP.lg}px`,
            }}>
              {(block.rows || []).map((row, j) => (
                <div key={j} style={{
                  padding: `${SP.sm}px 0`,
                  borderBottom: j < block.rows.length - 1 ? `1px solid ${SURFACE.border}` : 'none',
                }}>
                  <div style={{ fontSize: FS.body, fontWeight: FW.semibold, color: SURFACE.text, lineHeight: LH.body }}>
                    {row.label}
                  </div>
                  <div style={{ fontSize: FS.body, color: SURFACE.body, lineHeight: LH.body, marginTop: SP.xxs }}>
                    {row.value}
                  </div>
                </div>
              ))}
            </div>
          );
        }
        return (
          <div key={i} data-glass="soft" style={{
            background: SURFACE.detailBg, borderRadius: RADIUS.input,
            padding: `${SP.md}px ${SP.lg}px`, margin: `0 0 ${SP.lg}px`,
          }}>
            {(block.rows || []).map((row, j) => (
              <div key={j} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                padding: `${SP.xxs}px 0`, borderBottom: j < block.rows.length - 1 ? `1px solid ${SURFACE.border}` : 'none',
              }}>
                <span style={{ fontSize: FS.body, fontWeight: FW.medium, color: SURFACE.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  {row.label}
                </span>
                <span style={{ fontSize: FS.body, color: SURFACE.text, fontWeight: FW.medium, textAlign: 'right', maxWidth: '60%' }}>
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
            borderRadius: `0 ${RADIUS.input}px ${RADIUS.input}px 0`,
            padding: `${SP.md}px ${SP.lg}px`,
            margin: `${SP.lg}px 0`,
            fontSize: FS.body, lineHeight: LH.body, color: SURFACE.body,
          }}>
            {block.content}
          </div>
        );
      default:
        return null;
    }
  });
}

// Upcoming-visits band (owner 2026-07-12): the customer's next 1-2 open
// visits of THIS guide's service family — the dates the prep work builds
// toward. Distinct glass band above the content blocks; renders nothing when
// the payload carries no family visits.
function UpcomingVisitsBand({ visits, typeLabel }) {
  if (!Array.isArray(visits) || !visits.length) return null;
  return (
    <div
      data-glass="soft"
      style={{
        background: SURFACE.detailBg,
        border: `1px solid ${SURFACE.border}`,
        borderRadius: RADIUS.input,
        padding: `${SP.md}px ${SP.lg}px`,
        margin: `0 0 ${SP.xl}px`,
      }}
    >
      <div style={{
        fontSize: FS.body, fontWeight: FW.medium, color: SURFACE.muted,
        textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: SP.sm,
      }}>
        {visits.length > 1 ? `Your upcoming ${typeLabel} visits` : `Your upcoming ${typeLabel} visit`}
      </div>
      <div style={{ display: 'grid', gap: SP.sm }}>
        {visits.map((visit, i) => (
          <div
            key={`${visit.dateLabel}-${i}`}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
              gap: SP.md,
              paddingBottom: i < visits.length - 1 ? SP.sm : 0,
              borderBottom: i < visits.length - 1 ? `1px solid ${SURFACE.border}` : 'none',
            }}
          >
            <div>
              <div style={{ fontSize: FS.bodyLg, fontWeight: FW.semibold, color: SURFACE.text, lineHeight: LH.body }}>
                {visit.dateLabel}
              </div>
              {visit.serviceLabel && (
                <div style={{ fontSize: FS.body, color: SURFACE.muted, lineHeight: LH.body }}>
                  {visit.serviceLabel}
                </div>
              )}
            </div>
            {visit.windowLabel && (
              <div style={{ fontSize: FS.body, fontWeight: FW.medium, color: SURFACE.body, whiteSpace: 'nowrap' }}>
                Arrival {visit.windowLabel}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div style={{ padding: `${SP.xl}px ${SP.md}px 40px`, maxWidth: DOC_COLUMN_MAX, width: '100%', margin: '0 auto' }}>
      <div style={{ height: 28, width: '70%', background: SURFACE.border, borderRadius: RADIUS.tag, marginBottom: SP.md }} />
      <div style={{ height: 80, background: SURFACE.border, borderRadius: RADIUS.input, marginBottom: SP.lg }} />
      <div style={{ height: 16, width: '90%', background: SURFACE.border, borderRadius: 4, marginBottom: SP.sm }} />
      <div style={{ height: 16, width: '80%', background: SURFACE.border, borderRadius: 4, marginBottom: SP.sm }} />
      <div style={{ height: 16, width: '85%', background: SURFACE.border, borderRadius: 4 }} />
    </div>
  );
}

function NotFound() {
  return (
    <div style={{ padding: `${SP.gap}px ${SP.xl}px`, textAlign: 'center', maxWidth: 440, margin: '0 auto' }}>
      <h2 style={{ fontSize: FS.h3, fontWeight: FW.semibold, color: SURFACE.text, margin: `0 0 ${SP.sm}px`, lineHeight: LH.heading, fontFamily: DOC_FONT_SERIF }}>
        Prep guide not found
      </h2>
      <p style={{ fontSize: FS.bodyLg, color: SURFACE.body, lineHeight: LH.body, margin: `0 0 ${SP.xl}px` }}>
        This link may have expired or is no longer available. If you need help preparing for your service, give us a call.
      </p>
      <a
        href={WAVES_SUPPORT_PHONE_TEL}
        data-glass-accent=""
        style={docButton('primary')}
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
  const [error, setError] = useState(null); // null | notfound | temporary
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${API_BASE}/public/prep/${token}`);
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
      ? <PublicLoadError resource="prep guide" onRetry={() => setLoadAttempt(a => a + 1)} />
    : error === 'notfound' || !data
      ? <NotFound />
      : (
        <div style={{ padding: `${SP.xl}px ${SP.md}px 40px`, maxWidth: DOC_COLUMN_MAX, width: '100%', margin: '0 auto', fontFamily: DOC_FONT, color: SURFACE.text }}>
          <DocumentActionBar
            shareTitle={`Waves ${data.projectTypeLabel || ''} prep guide`.replace(/\s+/g, ' ')}
            pdfUrl={`${API_BASE}/public/prep/${token}/pdf`}
            pdfFileName={`Waves_${String(data.projectTypeLabel || 'Prep_Guide').replace(/[^A-Za-z0-9]+/g, '_')}_Prep_Guide.pdf`}
          />
          <div
            className="prep-card"
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
              color: SURFACE.text, margin: `0 0 ${SP.xxs}px`, lineHeight: LH.heading,
            }}>
              {data.projectTypeLabel} Prep Guide
            </h1>
            {data.technicianName && (
              <p style={{ fontSize: FS.body, color: SURFACE.muted, margin: `0 0 ${SP.xxs}px` }}>
                Your technician: {data.technicianName}
              </p>
            )}
            {(() => {
              // Contact block (owner 2026-07-13): names and address only,
              // one line each, empties dropped — account holder's name,
              // then any service-contact names (tenant / home buyer /
              // property manager). Never email/phone: the tokenized link
              // is shared with service contacts. The service itself is the
              // H1 above ("{type} Prep Guide").
              const contactLines = [...new Set([
                data.customerName,
                ...(data.serviceContactNames || []),
                data.propertyAddress,
              ].map((line) => String(line || '').trim()).filter(Boolean))];
              return contactLines.length ? (
                <div style={{ margin: `${SP.sm}px 0 ${SP.xl}px`, display: 'grid', gap: SP.xxs }}>
                  {contactLines.map((line) => (
                    <div key={line} style={{ fontSize: FS.body, color: SURFACE.muted, letterSpacing: '0.04em', textTransform: 'uppercase', lineHeight: LH.body }}>{line}</div>
                  ))}
                </div>
              ) : <div style={{ marginBottom: SP.lg }} />;
            })()}

            <UpcomingVisitsBand visits={data.upcomingVisits} typeLabel={data.projectTypeLabel} />

            <BlockRenderer blocks={data.blocks} />

            <div style={{ marginTop: 28, paddingTop: SP.lg, borderTop: `1px solid ${SURFACE.border}` }}>
              <p style={{ fontSize: FS.body, color: SURFACE.muted, lineHeight: LH.body, margin: 0 }}>
                Questions? Call or text us at{' '}
                <a href={WAVES_SUPPORT_PHONE_TEL} style={{ color: SURFACE.text, fontWeight: FW.medium }}>
                  {data.supportPhone || WAVES_SUPPORT_PHONE_DISPLAY}
                </a>
              </p>
            </div>
          </div>

          {/* Bottom "Print this page" button superseded by the
              DocumentActionBar above (owner 2026-07-09). */}
        </div>
      );

  return (
    <>
      <style>{PRINT_STYLE}</style>
      <meta name="robots" content="noindex, nofollow" />
      <WavesShell variant="customer" topBar="solid">
        <div data-glass-clear="" style={{ flex: 1, minHeight: '100vh', background: SURFACE.page }}>
          {content}
          <div className="prep-no-print" style={{ maxWidth: DOC_COLUMN_MAX, width: '100%', margin: '0 auto', padding: `0 ${SP.md}px 40px`, fontFamily: DOC_FONT }}>
            {/* Newsletter signup lives only on the newsletter pages
                (owner 2026-07-09, supersedes same-day card ruling). */}
            <BrandFooter />
          </div>
        </div>
      </WavesShell>
    </>
  );
}
