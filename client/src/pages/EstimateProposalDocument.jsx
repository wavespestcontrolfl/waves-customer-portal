import React, { useMemo, useState } from 'react';
import { WAVES_ACCOUNT_MANAGER_FIRST_NAME, WAVES_FL_LICENSE_LINE, WAVES_SUPPORT_PHONE_DISPLAY } from '../constants/business';
import { fmtMoney } from '../lib/money';
import { glassCtaMicroForKeys, glassRowInclusions, glassServiceSlug } from '../lib/estimate-glass-copy';

// Work-order style estimate document (owner direction 2026-08-07, modeled on
// ServiceReportDocument): this is what renders whenever the estimate is
// captured as a PDF — the customer Download button, the admin proposal.pdf
// download, and the proposal email attachment all serve this document once
// GATE_ESTIMATE_DOC_PDF is on (the legacy pdfkit proposal remains the
// fallback for every render failure).
//
// SCOPE — "what you'd be buying", on paper. The document answers the four
// questions a proposal recipient actually asked us (2026-08-07 call):
// what's included, what does it cost on what cadence, how was the price
// determined, and what are the terms. It deliberately does NOT reproduce
// the interactive page's configurator, scheduler, reviews, or app showcase
// — those live online, and every copy of this document links there.
//
// Content rules: pricing lines come verbatim from the server's normalized
// proposal block (the SAME normalizeProposal lines the legacy pdfkit
// document prints — the two documents can never quote different numbers).
// Inclusions/terms come only from the shipped glass copy stacks; the
// commercial identity swaps in the commercial stack, which carries no
// residential guarantee claims.

const NAVY = '#04395E';
const INK = '#17242F';
const MUTED = '#5B6A77';
const LINE = '#C9CED4';
const FONT = "'Inter', 'DM Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";
const PORTAL_FALLBACK = 'https://portal.wavespestcontrol.com';

// Same precedence as ServiceReportDocument.portalBase: the headless renderer
// reaches this page through an internal hostname, so window.location.origin
// would bake a non-customer host into the document — the server's canonical
// publicOrigin (shipped on mode=pdf /data payloads) wins.
function portalBase(publicOrigin) {
  const canonical = String(publicOrigin || '').trim().replace(/\/+$/, '');
  if (canonical) return canonical;
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return PORTAL_FALLBACK;
}

// Two formatters, selected by FIELD — never by sniffing the value (codex
// pre-push r4b: a created_at instant landing exactly on 00:00:00Z would
// otherwise format in UTC and display a day off for ET evening sends).
//
// fmtInstant: real timestamps (created_at) format in ET like every
// customer surface (AGENTS.md timezone discipline).
function fmtInstant(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

// fmtValidThrough: expires_at is usually an instant (send stamp = now+7d,
// formatted in ET), but date-ONLY values (legacy rows, operator-entered
// dates — the legacy PDF's formatDisplayDate deliberately preserves them
// as calendar dates) format in UTC so "valid through Sept 6" never renders
// as Sept 5. The heuristic is confined to THIS field, where a bare date or
// UTC-midnight value genuinely is a calendar date.
function fmtValidThrough(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const isCalendarDate = /T00:00:00(\.000)?(Z|\+00:00)$/.test(String(value))
    || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
  return date.toLocaleDateString('en-US', {
    timeZone: isCalendarDate ? 'UTC' : 'America/New_York',
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

function fmtPhone(value) {
  const digits = String(value || '').replace(/\D/g, '').replace(/^1/, '');
  if (digits.length !== 10) return value || '';
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

// Annual visit count for a line's cadence — drives the pest inclusions
// stack's "Protected N× a year" bullet. per_application lines carry their
// own count; unknown cadences return null and the stack falls back to its
// default visit count.
const FREQUENCY_VISITS = {
  weekly: 52, bi_weekly: 26, twice_monthly: 24, monthly: 12, bi_monthly: 6,
  quarterly: 4, semi_annual: 2, annual: 1,
};

function InfoRow({ label, children }) {
  if (children == null || children === '') return null;
  return (
    <div style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 11.5, lineHeight: 1.45 }}>
      <span style={{ color: MUTED, minWidth: 78 }}>{label}</span>
      <span style={{ color: INK, minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  );
}

function SectionHeader({ children }) {
  return (
    <div className="doc-keep-with-next" style={{
      borderBottom: `1.5px solid ${NAVY}`, margin: '14px 0 6px', paddingBottom: 3,
      color: NAVY, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
    }}>{children}</div>
  );
}

function Bullet({ children }) {
  return (
    <div style={{ display: 'flex', gap: 7, padding: '1.5px 0', fontSize: 11.5, lineHeight: 1.45, color: INK }}>
      <span aria-hidden="true" style={{ color: MUTED }}>&bull;</span>
      <span>{children}</span>
    </div>
  );
}

export default function EstimateProposalDocument({ data, token }) {
  const estimate = data?.estimate || {};
  const proposal = data?.proposal || null;
  const cta = data?.cta || {};
  const totals = proposal?.totals || {};
  const isCommercial = cta.commercialProposal === true
    || cta.commercialAutoPriced === true
    || String(estimate.category || '').toUpperCase() === 'COMMERCIAL';
  const authoredProposal = proposal?.enabled === true;
  const buildings = Array.isArray(proposal?.buildings) ? proposal.buildings : [];
  const multiBuilding = buildings.length > 1;
  // "How your price was built" comes from the ESTIMATOR's inputs (satellite
  // measurement, property specs). An authored proposal's lines and prices are
  // operator-entered and may have nothing to do with those inputs, so the
  // section would claim a methodology that didn't set this price — omit it
  // for authored proposals (codex #3281 r4). Synthesized/engine-priced
  // documents keep it: there the claim is true.
  const intelligence = authoredProposal ? null : (estimate.intelligence || null);

  // Failed-image accounting for the render pipeline (parity with
  // ServiceReportDocument): the satellite snapshot is the one remote image;
  // if it fails it drops itself and reports through the counter the
  // renderer reads.
  const [satelliteFailed, setSatelliteFailed] = useState(false);
  if (typeof window !== 'undefined') {
    window.__WAVES_PDF_IMAGE_FAILURES = satelliteFailed ? 1 : 0;
  }

  // Distinct service stacks across the proposal lines. Commercial estimates
  // read the commercial PEST stack only when the server classified this
  // proposal's recurring lines as pest work (proposal.pestRecurringOnly —
  // truth-scope rule: a termite/rodent/mixed commercial proposal shows its
  // line items with NO inclusions claims). Residential lines map per-line
  // through glassServiceSlug; unmappable lines simply contribute no stack.
  const pestRecurringOnly = proposal?.pestRecurringOnly === true;
  // Authored proposal terms GOVERN — the operator may have written a
  // 12-month commitment, written-notice cancellation, or per-visit interior
  // billing, and any canned inclusions bullet beside them could state the
  // opposite (codex #3281 r1). Terms present → no inclusions stacks at all;
  // the line items + authored terms speak for themselves.
  const authoredTermsPresent = Boolean(proposal?.terms);
  const inclusionStacks = useMemo(() => {
    if (authoredTermsPresent) return [];
    if (isCommercial) {
      const stack = pestRecurringOnly ? glassRowInclusions('commercial_pest') : null;
      return stack ? [{ key: 'commercial_pest', title: 'What your commercial pest service includes', items: stack }] : [];
    }
    const seen = new Map();
    for (const building of buildings) {
      for (const item of (building.lineItems || [])) {
        if (item.frequency === 'one_time') continue;
        const slug = glassServiceSlug(String(item.description || ''));
        if (!slug || seen.has(slug)) continue;
        const visits = item.frequency === 'per_application'
          ? (Number(item.visitsPerYear) || null)
          : (FREQUENCY_VISITS[item.frequency] || null);
        const items = glassRowInclusions(slug, visits, false);
        if (items) seen.set(slug, { key: slug, title: 'What this service includes', items });
      }
    }
    return [...seen.values()];
  }, [isCommercial, pestRecurringOnly, authoredTermsPresent, buildings]);

  // Terms line — only claims the estimate page itself already makes for the
  // same services. Authored terms govern (neutral line beside them, never a
  // competing plan claim). Commercial PEST plans get the commercial terms;
  // other commercial work stays terms-neutral. Residential recurring
  // resolves through glassCtaMicroForKeys off the actual line services —
  // the SAME distinct-micros rule the live page applies, so a lawn or
  // rodent document never prints the pest callbacks/guarantee line the
  // page deliberately withholds (codex #3281 r1). One-time-only (no
  // recurring lines) resolves to the neutral line the same way.
  const NEUTRAL_TERMS = 'Licensed & insured · Satisfaction guaranteed';
  const recurringLineDescriptions = buildings
    .flatMap((b) => (b.lineItems || []))
    .filter((li) => li.frequency !== 'one_time')
    .map((li) => String(li.description || ''));
  const termsLine = authoredTermsPresent
    ? NEUTRAL_TERMS
    : isCommercial
      // Structural terms only — commercial accepts run the MANUAL invoicing
      // lane (commercial_manual_billing), so no billing-method claims here
      // (codex #3281 r2).
      ? (pestRecurringOnly
        ? 'No long-term contract · Licensed & insured · Satisfaction guaranteed'
        : NEUTRAL_TERMS)
      : recurringLineDescriptions.length === 0
        ? NEUTRAL_TERMS
        : glassCtaMicroForKeys(recurringLineDescriptions);

  // Combined plan totals ("$X/mo" / "$X/yr") are prohibited on customer-facing
  // estimate surfaces (AGENTS.md "Per application price copy"); commercial
  // proposals are the exemption. Mirrors estimate-pdf.js's suppressPlanTotals
  // + totalsBlock exactly: a synthesized per-application proposal prints its
  // per-application line items and NO recurring roll-up, monthly equivalent,
  // or first-year fold-in — one-time work (a single real charge) and its tax
  // still print, with a plain "Total".
  const quotesPerApp = buildings.some((b) => (b.lineItems || []).some((li) => li.frequency === 'per_application'));
  const suppressPlanTotals = !authoredProposal && quotesPerApp;
  // Taxable-line identification (codex #3281 r3) — parity with the pdfkit
  // document it replaces: a mixed taxable/exempt proposal marks each taxed
  // amount with '*', prints the rate beside the tax total, and explains the
  // marker, so the customer can verify the calculation line by line.
  const anyTaxableLine = buildings.some((b) => (b.lineItems || []).some((li) => li.taxable === true));
  const taxRatePct = Number(totals.taxRate) > 0 ? (Number(totals.taxRate) * 100).toFixed(2) : null;
  const showRecurringTotals = !suppressPlanTotals && Number(totals.annualRecurring) > 0;
  const showGrandTotal = !suppressPlanTotals || Number(totals.annualRecurring) <= 0;
  const grandTotalLabel = Number(totals.annualRecurring) > 0 ? 'First-year total' : 'Total';

  const estimateUrl = `${portalBase(data?.publicOrigin)}/estimate/${encodeURIComponent(token || estimate.token || '')}`;
  const docTitle = authoredProposal
    ? (proposal.title || 'Commercial Service Proposal')
    : (isCommercial ? 'Commercial Service Estimate' : 'Service Estimate');
  const estimateNumber = estimate.slug
    || String(estimate.id || '').split('-')[0].toUpperCase()
    || '';

  return (
    <div
      className="estimate-document-v1"
      style={{ background: '#fff', color: INK, fontFamily: FONT, minHeight: '100vh' }}
    >
      <style>{`
        .estimate-document-v1 { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .estimate-document-v1 .doc-page { max-width: 760px; margin: 0 auto; padding: 20px 16px 28px; }
        @media print {
          [data-waves-shell-header],
          footer[role="contentinfo"],
          .waves-skip-link { display: none !important; }
          html[data-glass-theme] .glass-scene-orbs,
          html[data-glass-theme] .glass-scene-grain { display: none !important; }
          .estimate-document-v1 .doc-page { padding: 0; max-width: none; }
          .estimate-document-v1 .doc-keep { break-inside: avoid; page-break-inside: avoid; }
          .estimate-document-v1 .doc-keep-with-next { break-after: avoid-page; page-break-after: avoid; }
        }
      `}</style>
      <div className="doc-page">

        {/* Letterhead */}
        <div className="doc-keep" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <img src="/waves-logo.png" alt="Waves Pest Control" style={{ height: 64, display: 'block' }} />
          <div style={{ textAlign: 'right', fontSize: 10.5, lineHeight: 1.5, color: MUTED }}>
            <div style={{ color: NAVY, fontSize: 12.5, fontWeight: 800 }}>Waves Pest Control, LLC</div>
            <div>{WAVES_SUPPORT_PHONE_DISPLAY} &middot; wavespestcontrol.com</div>
            <div>contact@wavespestcontrol.com</div>
            <div>Licensed &amp; insured &middot; {WAVES_FL_LICENSE_LINE}</div>
          </div>
        </div>

        {/* Title row */}
        <div className="doc-keep" style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          borderTop: `2.5px solid ${NAVY}`, marginTop: 12, paddingTop: 8, gap: 12,
        }}>
          <div style={{ color: NAVY, fontSize: 21, fontWeight: 800, letterSpacing: '0.02em', textTransform: 'uppercase' }}>{docTitle}</div>
          <div style={{ fontSize: 11, color: MUTED, whiteSpace: 'nowrap' }}>
            {estimateNumber ? `Estimate ${estimateNumber} · ` : ''}{fmtInstant(estimate.createdAt)}
          </div>
        </div>

        {/* Info grid */}
        <div className="doc-keep" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '4px 22px', marginTop: 10 }}>
          <div style={{ minWidth: 0 }}>
            <SectionHeader>Prepared for</SectionHeader>
            <InfoRow label="Name">{proposal?.preparedFor || estimate.customerName}</InfoRow>
            <InfoRow label="Address">{proposal?.propertyAddress || estimate.address}</InfoRow>
            <InfoRow label="Phone">{fmtPhone(estimate.customerPhone)}</InfoRow>
            <InfoRow label="Email">{estimate.customerEmail}</InfoRow>
          </div>
          <div style={{ minWidth: 0 }}>
            <SectionHeader>Estimate details</SectionHeader>
            <InfoRow label="Date">{fmtInstant(estimate.createdAt)}</InfoRow>
            <InfoRow label="Valid through">{fmtValidThrough(estimate.expiresAt) || '30 days from issue'}</InfoRow>
            <InfoRow label="Prepared by">Waves Pest Control, LLC</InfoRow>
            {estimate.licenseNumber ? <InfoRow label="License">{estimate.licenseNumber}</InfoRow> : null}
          </div>
        </div>

        {/* Pricing */}
        {buildings.length > 0 && (
          <div className="doc-keep">
            <SectionHeader>{authoredProposal ? 'Your proposal' : 'Your services & pricing'}</SectionHeader>
            {buildings.map((building, bIdx) => (
              <div key={`${building.name || 'b'}-${bIdx}`} style={{ marginTop: bIdx === 0 ? 0 : 8 }}>
                {multiBuilding ? (
                  <div style={{ fontSize: 12, fontWeight: 800, color: NAVY, padding: '4px 0 2px' }}>{building.name || 'Service location'}</div>
                ) : null}
                {building.note ? (
                  <div style={{ fontSize: 11, color: MUTED, padding: '0 0 2px', lineHeight: 1.5 }}>{building.note}</div>
                ) : null}
                {(building.lineItems || []).map((item, iIdx) => (
                  <div key={`${item.description || 'line'}-${iIdx}`} style={{
                    display: 'flex', justifyContent: 'space-between', gap: 14,
                    padding: '5px 0', borderBottom: `1px solid ${LINE}`, fontSize: 11.5, lineHeight: 1.5,
                  }}>
                    <span style={{ minWidth: 0, color: INK }}>
                      {item.description || 'Service'}
                      {Number(item.quantity) > 1 ? ` × ${item.quantity}` : ''}
                    </span>
                    <span style={{ whiteSpace: 'nowrap', fontWeight: 700, color: NAVY, fontVariantNumeric: 'tabular-nums' }}>
                      {fmtMoney(item.amount)}
                      {item.taxable === true ? ' *' : ''}
                      {item.frequencyLabel ? (
                        <span style={{ fontWeight: 400, color: MUTED }}> {String(item.frequencyLabel).toLowerCase()}</span>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            <div style={{ marginTop: 8 }}>
              {showRecurringTotals ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 11.5 }}>
                  <span style={{ color: MUTED }}>Recurring service (per year)</span>
                  <span style={{ fontWeight: 700, color: INK, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(totals.annualRecurring)}</span>
                </div>
              ) : null}
              {Number(totals.oneTime) > 0 ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 11.5 }}>
                  <span style={{ color: MUTED }}>One-time services</span>
                  <span style={{ fontWeight: 700, color: INK, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(totals.oneTime)}</span>
                </div>
              ) : null}
              {totals.hasTax ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 11.5 }}>
                  <span style={{ color: MUTED }}>
                    {proposal?.taxLabel || 'Sales tax'}
                    {taxRatePct ? ` (${taxRatePct}%)` : ''}
                  </span>
                  <span style={{ fontWeight: 700, color: INK, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(totals.totalTax)}</span>
                </div>
              ) : null}
              {showGrandTotal ? (
                <div style={{
                  display: 'flex', justifyContent: 'space-between', padding: '5px 0 3px', fontSize: 13,
                  borderTop: `1.5px solid ${NAVY}`, marginTop: 4, fontWeight: 800, color: NAVY,
                }}>
                  <span>{grandTotalLabel}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(totals.firstYearTotal)}</span>
                </div>
              ) : null}
              {/* Monthly-equivalent budgeting line is an authored-proposal
                  exemption only (mirrors ctx.showMonthlyEquivalent — boards
                  budget monthly; residential plans never show a flat spread). */}
              {authoredProposal && showRecurringTotals ? (
                <div style={{ fontSize: 10.5, color: MUTED, marginTop: 2 }}>
                  Averages {fmtMoney(totals.monthlyEquivalent)}/month across the year for the recurring service.
                </div>
              ) : null}
              {totals.hasTax || anyTaxableLine ? (
                <div style={{ fontSize: 10, color: MUTED, marginTop: 3, lineHeight: 1.5 }}>
                  * Taxable line. Tax applies only to lines marked taxable, at the Florida state rate plus
                  the service county surtax. Residential pest control and residential lawn maintenance are
                  tax-exempt in Florida; commercial services may be taxable.
                </div>
              ) : null}
            </div>
            {proposal?.terms ? (
              <div style={{ marginTop: 8, fontSize: 11, color: INK, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{proposal.terms}</div>
            ) : null}
          </div>
        )}

        {/* What's included */}
        {inclusionStacks.map((stack) => (
          <div className="doc-keep" key={stack.key}>
            <SectionHeader>{stack.title}</SectionHeader>
            {stack.items.map((line) => <Bullet key={line}>{line}</Bullet>)}
          </div>
        ))}

        {/* How the price was built */}
        {intelligence ? (
          <div className="doc-keep">
            <SectionHeader>How your price was built</SectionHeader>
            {intelligence.body ? (
              <p style={{ margin: '3px 0', fontSize: 11.5, lineHeight: 1.5, color: INK }}>{intelligence.body}</p>
            ) : null}
            {Array.isArray(intelligence.metrics) && intelligence.metrics.length ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px 16px', marginTop: 4 }}>
                {intelligence.metrics.map((metric) => (
                  <div key={`${metric.label}-${metric.value}`} style={{ fontSize: 11 }}>
                    <span style={{ color: MUTED }}>{metric.label}: </span>
                    <span style={{ color: INK, fontWeight: 700 }}>{metric.value}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {estimate.satelliteUrl && !satelliteFailed ? (
              <img
                src={estimate.satelliteUrl}
                alt={`Satellite view of ${estimate.address || 'the property'}`}
                style={{ marginTop: 8, width: '100%', maxHeight: 260, objectFit: 'cover', borderRadius: 6, border: `1px solid ${LINE}` }}
                onError={() => setSatelliteFailed(true)}
              />
            ) : null}
          </div>
        ) : null}

        {/* Terms + next steps */}
        <div className="doc-keep">
          <SectionHeader>Terms</SectionHeader>
          <p style={{ margin: '3px 0', fontSize: 11.5, lineHeight: 1.5, color: INK }}>{termsLine}</p>
        </div>

        <div className="doc-keep">
          <SectionHeader>Next steps</SectionHeader>
          {/* Next-step copy follows the CTA state (codex #3281 r1): accepted
              and declined estimates stay downloadable, and quote-required /
              review-gated ones can't self-book — none of them may be told to
              "approve online". */}
          {cta.terminalState === 'accepted' ? (
            <p style={{ margin: '3px 0', fontSize: 11.5, lineHeight: 1.5, color: INK }}>
              This estimate has been approved — your live estimate at{' '}
              <a href={estimateUrl} style={{ color: NAVY }}>{estimateUrl}</a> has your visit details.
              Questions? Call {WAVES_SUPPORT_PHONE_DISPLAY} any time.
            </p>
          ) : cta.terminalState === 'declined' ? (
            <p style={{ margin: '3px 0', fontSize: 11.5, lineHeight: 1.5, color: INK }}>
              This estimate was declined. Changed your mind? Call {WAVES_SUPPORT_PHONE_DISPLAY} and
              we&rsquo;ll refresh the numbers with you.
            </p>
          ) : authoredProposal ? (
            <p style={{ margin: '3px 0', fontSize: 11.5, lineHeight: 1.5, color: INK }}>
              {WAVES_ACCOUNT_MANAGER_FIRST_NAME}, your Waves account manager, will follow up to answer
              questions and finalize this proposal — or call {WAVES_SUPPORT_PHONE_DISPLAY} any time.
              Your live estimate stays available at{' '}
              <a href={estimateUrl} style={{ color: NAVY }}>{estimateUrl}</a>.
            </p>
          ) : cta.quoteRequired === true || cta.reviewBeforeBooking === true ? (
            <p style={{ margin: '3px 0', fontSize: 11.5, lineHeight: 1.5, color: INK }}>
              Our team will confirm the final details and scheduling with you — call{' '}
              {WAVES_SUPPORT_PHONE_DISPLAY} any time. Your live estimate stays available at{' '}
              <a href={estimateUrl} style={{ color: NAVY }}>{estimateUrl}</a>.
            </p>
          ) : (
            <p style={{ margin: '3px 0', fontSize: 11.5, lineHeight: 1.5, color: INK }}>
              Open your live estimate at <a href={estimateUrl} style={{ color: NAVY }}>{estimateUrl}</a> to
              pick a start date and approve online — or call {WAVES_SUPPORT_PHONE_DISPLAY} and we&rsquo;ll
              take care of it with you.
            </p>
          )}
        </div>

        {/* Footer */}
        <div style={{ marginTop: 16, paddingTop: 6, borderTop: `1px solid ${LINE}`, fontSize: 9.5, color: MUTED, lineHeight: 1.5 }}>
          Thank you for considering Waves Pest Control &middot; {WAVES_FL_LICENSE_LINE}
        </div>
      </div>
    </div>
  );
}
