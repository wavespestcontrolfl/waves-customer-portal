import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { WavesShell, CustomerColumn, PublicStateCard } from '../components/brand';
import DocumentActionBar from '../components/DocumentActionBar';
import { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_PHONE_TEL } from '../constants/business';
import { useGlassSurface } from '../glass/glass-engine';
import {
  DOC,
  DOC_FONT,
  DOC_FONT_SERIF,
  FS,
  FW,
  LH,
  SP,
  RADIUS,
  SHADOW,
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
  .prep-no-print, [data-brand-footer] { display: none !important; }
  .prep-card { box-shadow: none !important; border: none !important; }
}
`;

// Inline markdown links in block prose: [label](https://…) — the public
// twin of email-template-library's renderInline link support (see the
// MD_LINK_RE comment block there). Same allowlist (http/https/mailto/tel),
// same "unusable scheme renders as inert text" fallback, no
// dangerouslySetInnerHTML: this returns real React nodes.
//
// Ordering note vs. the email renderer: email-template-library extracts
// links from the RAW TEMPLATE text before {{variable}} substitution so a
// customer-controlled payload value can never itself become a link (codex
// #3167 P1). This page receives blocks from GET /api/public/prep/:token
// ALREADY substituted, so the same guarantee is enforced server-side:
// prep-public.js's interpolate() breaks any `](` inside a substituted VALUE
// (neutralizeLinkSyntax) before the text reaches this parser. Only
// author-written markdown in the template can form a link here.
const SAFE_HREF_RE = /^(https?:|mailto:|tel:)/i;
const MD_LINK_RE = /\[([^\]\n]+)\]\((\S+?)\)/g;

function isSafeHref(href) {
  return SAFE_HREF_RE.test(String(href || '').trim());
}

// text -> array of strings / <a> nodes (React accepts a mixed array of
// children as long as elements carry keys; bare strings don't need one).
function renderInlineLinks(text, keyPrefix) {
  const raw = text == null ? '' : String(text);
  if (!raw) return raw;
  MD_LINK_RE.lastIndex = 0;
  if (!MD_LINK_RE.test(raw)) return raw;
  MD_LINK_RE.lastIndex = 0;
  const nodes = [];
  let lastIndex = 0;
  let match;
  let i = 0;
  while ((match = MD_LINK_RE.exec(raw))) {
    const [whole, label, href] = match;
    if (match.index > lastIndex) nodes.push(raw.slice(lastIndex, match.index));
    if (isSafeHref(href)) {
      nodes.push(
        <a
          key={`${keyPrefix}-lnk-${i}`}
          href={href.trim()}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: SURFACE.text, fontWeight: FW.medium }}
        >
          {label}
        </a>,
      );
    } else {
      // Unusable scheme (e.g. javascript:/data:) → leave the raw markdown
      // text on the page rather than linkifying it.
      nodes.push(whole);
    }
    lastIndex = match.index + whole.length;
    i += 1;
  }
  if (lastIndex < raw.length) nodes.push(raw.slice(lastIndex));
  return nodes;
}

function BlockRenderer({ blocks }) {
  if (!Array.isArray(blocks) || !blocks.length) return null;
  return blocks.map((block, i) => {
    switch (block.type) {
      case 'paragraph':
        return (
          <p key={i} style={{ fontSize: FS.bodyLg, lineHeight: LH.body, color: SURFACE.body, margin: `0 0 ${SP.md}px` }}>
            {renderInlineLinks(block.content, `p${i}`)}
          </p>
        );
      case 'list':
        return (
          <ul key={i} style={{
            listStyle: 'none', margin: `0 0 ${SP.lg}px`, padding: 0, display: 'grid', gap: SP.sm,
          }}>
            {(Array.isArray(block.items) ? block.items : []).map((item, j) => (
              <li key={j} style={{
                display: 'flex', alignItems: 'baseline', gap: SP.sm,
                fontSize: FS.bodyLg, lineHeight: LH.body, color: SURFACE.body,
              }}>
                <span aria-hidden="true" style={{ color: SURFACE.text, fontWeight: FW.semibold, flexShrink: 0 }}>&#10003;</span>
                <span>{renderInlineLinks(item, `l${i}-${j}`)}</span>
              </li>
            ))}
          </ul>
        );
      case 'heading':
        return (
          <h2 key={i} className="waves-print-h2" style={{
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
                    {renderInlineLinks(row.label, `dr${i}-${j}-l`)}
                  </div>
                  <div style={{ fontSize: FS.body, color: SURFACE.body, lineHeight: LH.body, marginTop: SP.xxs }}>
                    {renderInlineLinks(row.value, `dr${i}-${j}-v`)}
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
                  {renderInlineLinks(row.label, `dr${i}-${j}-l`)}
                </span>
                <span style={{ fontSize: FS.body, color: SURFACE.text, fontWeight: FW.medium, textAlign: 'right', maxWidth: '60%' }}>
                  {renderInlineLinks(row.value, `dr${i}-${j}-v`)}
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
            {renderInlineLinks(block.content, `c${i}`)}
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
    <CustomerColumn>
      <div style={{ height: 28, width: '70%', background: SURFACE.border, borderRadius: RADIUS.tag, marginBottom: SP.md }} />
      <div style={{ height: 80, background: SURFACE.border, borderRadius: RADIUS.input, marginBottom: SP.lg }} />
      <div style={{ height: 16, width: '90%', background: SURFACE.border, borderRadius: 4, marginBottom: SP.sm }} />
      <div style={{ height: 16, width: '80%', background: SURFACE.border, borderRadius: 4, marginBottom: SP.sm }} />
      <div style={{ height: 16, width: '85%', background: SURFACE.border, borderRadius: 4 }} />
    </CustomerColumn>
  );
}

export default function PrepGuidePage() {
  const { token } = useParams();
  useGlassSurface(true);
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
      ? (
        <CustomerColumn>
          <PublicStateCard state="error" title="We couldn&rsquo;t load that prep guide" onRetry={() => setLoadAttempt(a => a + 1)}>
            This looks temporary. Your link is still valid&mdash;check your connection and try again.
          </PublicStateCard>
        </CustomerColumn>
      )
    : error === 'notfound' || !data
      ? (
        <CustomerColumn>
          <PublicStateCard state="not-found" title="Prep guide not found" contact="call">
            This link may have expired or is no longer available. If you need help preparing for your service, give us a call.
          </PublicStateCard>
        </CustomerColumn>
      )
      : (
        <CustomerColumn style={{ fontFamily: DOC_FONT, color: SURFACE.text }}>
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
            <div data-gt="eyebrow" style={{ fontSize: 14, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: SURFACE.muted, marginBottom: SP.xs }}>
              Prep guide{data.projectTypeLabel ? ` · ${data.projectTypeLabel}` : ''}
            </div>
            <h1 className="waves-print-h2" style={{
              fontFamily: DOC_FONT_SERIF, fontSize: FS.h2, fontWeight: FW.bold,
              color: SURFACE.text, margin: `0 0 ${SP.xxs}px`, lineHeight: LH.heading,
            }}>
              {data.projectTypeLabel} Prep Guide
            </h1>
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
                  {contactLines.map((line, i) => (
                    <div key={line} style={{ fontSize: FS.bodyLg, color: i === 0 ? SURFACE.text : SURFACE.muted, fontWeight: i === 0 ? FW.semibold : FW.regular, lineHeight: LH.body }}>{line}</div>
                  ))}
                  {data.technicianName ? (
                    <div style={{ fontSize: FS.bodyLg, color: SURFACE.muted, lineHeight: LH.body }}>Your technician: {data.technicianName}</div>
                  ) : null}
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
        </CustomerColumn>
      );

  return (
    <>
      <style>{PRINT_STYLE}</style>
      <meta name="robots" content="noindex, nofollow" />
      <WavesShell variant="customer" topBar="solid">
        <div data-glass-clear="" style={{ flex: 1, background: SURFACE.page }}>
          {content}
        </div>
      </WavesShell>
    </>
  );
}
