// Tokened price-change notice page (owner policy 2026-07-12): the full,
// formal advance notice the short email/SMS link to. Renders the customer's
// current → new price, the effective date, what stays the same, and the
// no-action-needed / cancel-anytime terms — never "renewal" language (the
// recurring service has no fixed term).
import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { WavesShell, CustomerColumn, PublicStateCard } from '../components/brand';
import DocumentActionBar from '../components/DocumentActionBar';
import {
  FieldDocumentBody,
  FieldFooter,
  FieldMasthead,
  FieldTitle,
} from '../components/FieldDocument';
import './PriceChangeNoticePage.css';
import { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_PHONE_TEL } from '../constants/business';
import { useGlassSurface } from '../glass/glass-engine';
import { CUSTOMER_SURFACE } from '../theme-customer';
import {
  DOC,
  DOC_FONT,
  DOC_FONT_SERIF,
  FS,
  FW,
  LH,
  SP,
  RADIUS,
} from '../theme-doc';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const NAVY = '#04395E';

const SURFACE = {
  page: DOC.page,
  border: DOC.border,
  text: DOC.ink,
  body: DOC.muted,
  muted: DOC.supporting,
  calloutBg: CUSTOMER_SURFACE.successBg,
  calloutBorder: CUSTOMER_SURFACE.successBorder,
  detailBg: '#F9F8F5',
};

const H2 = { fontFamily: DOC_FONT_SERIF, fontSize: FS.h3, fontWeight: FW.semibold, color: SURFACE.text, margin: `0 0 ${SP.sm}px`, lineHeight: LH.heading };
const BODY = { fontSize: FS.bodyLg, lineHeight: LH.body, color: SURFACE.body, margin: `0 0 ${SP.lg}px` };

function RateRow({ label, value, sub, big, last }) {
  return (
    <div className="price-change-rate-row" style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: SP.md,
      padding: `${SP.xs}px 0`, borderBottom: last ? 'none' : `1px solid ${SURFACE.border}`,
    }}>
      <span className="price-change-meta" style={{ fontSize: FS.body, fontWeight: FW.medium, color: SURFACE.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      <span className={big ? 'price-change-section-value' : 'price-change-prose'} style={{ textAlign: 'right', fontSize: big ? FS.h3 : FS.bodyLg, color: SURFACE.text, fontWeight: big ? FW.bold : FW.semibold }}>
        {value}
        {sub && <span className="price-change-meta" style={{ display: 'block', fontSize: FS.body, fontWeight: FW.medium, color: SURFACE.muted }}>{sub}</span>}
      </span>
    </div>
  );
}

function rateLine(line, which) {
  const amount = which === 'current' ? line.current : line.next;
  if (line.unit !== 'year') return `${amount} / ${line.unit}`;
  const perApp = which === 'current' ? line.perApplicationCurrent : line.perApplicationNext;
  return perApp ? `${amount} / year (${perApp} / application)` : `${amount} / year`;
}

// Annual rate review notice (v2): the letter as it was sent — per line the
// old and new rate, the change and the effective date, then the reason,
// the year's costs and what stays the same. Every value is the server's
// frozen copy; nothing is computed here but layout.
// Copy by billing unit: the same sentences the email's assurance_line carries.
function assuranceFor(lines) {
  const units = new Set((lines || []).map((l) => l.unit));
  // One sentence per billing arrangement the letter carries, never one it does not.
  return [
    ['application', 'Any application completed before the new-rate date is billed at your current rate.'],
    ['month', 'Your monthly dues stay at your current amount through the month before the new-rate date.'],
    ['year', 'Your prepaid plan stays exactly as it is until it renews.'],
  ].filter(([unit]) => units.has(unit)).map(([, sentence]) => sentence).join(' ');
}

function RateReviewNotice({ data }) {
  const { review } = data;
  const lines = review.lines || [];
  if (!lines.length) return null;
  const first = lines[0] || {};
  const several = lines.length > 1;
  return (
    <>
      <p style={BODY}>
        Hi {data.firstName}, this is your written notice, at least 30 days ahead, as promised when you signed up.
        {several ? ' Your rates are going up on the dates below.' : ` Your ${(first.service || 'service').toLowerCase()} rate is going up on ${first.effectiveDate}.`}
        {' '}The reasons are below.
      </p>

      {lines.map((line, i) => (
        <div key={`${line.service}-${i}`} className="doc-keep price-change-rate-card" data-glass="soft" style={{
          background: SURFACE.detailBg, borderRadius: RADIUS.input,
          padding: `${SP.md}px ${SP.lg}px`, margin: `0 0 ${SP.md}px`,
        }}>
          {several && line.service && (
            <div className="price-change-prose" style={{ fontSize: FS.bodyLg, fontWeight: FW.bold, color: SURFACE.text, marginBottom: SP.xs }}>{line.service}</div>
          )}
          <RateRow label="Current rate" value={rateLine(line, 'current')} />
          <RateRow label="New rate" value={rateLine(line, 'next')} big />
          <RateRow label="Change" value={`up ${line.change}${line.unit === 'year' ? ' / year' : ''}`} />
          <RateRow
            label="Effective"
            value={line.effectiveDate}
            sub={line.unit === 'year' ? 'when your prepaid plan renews' : line.unit === 'month' ? 'first month at the new rate' : 'first application on or after this date'}
            last={!line.firstLabel}
          />
          {line.firstLabel && line.first && <RateRow label={line.firstLabel} value={line.first} last />}
        </div>
      ))}

      <h2 className="field-section-heading" style={{ ...H2, marginTop: SP.lg }}>Why your rate specifically</h2>
      {lines.map((line, i) => line.why && (
        <p key={`why-${i}`} style={{ ...BODY, margin: `0 0 ${SP.md}px` }}>
          {several && line.service ? <strong style={{ color: SURFACE.text }}>{line.service}: </strong> : null}
          {line.why}
        </p>
      ))}

      {review.costBlock && (
        <>
          <h2 className="field-section-heading" style={{ ...H2, marginTop: SP.lg }}>What changed this year</h2>
          <p style={{ ...BODY, whiteSpace: 'pre-line' }}>{review.costBlock}</p>
        </>
      )}

      <h2 className="field-section-heading" style={H2}>What stays the same</h2>
      <p style={BODY}>
        Same team, same products, same guarantee: activity between applications means we come back at no charge.
        Your schedule does not change. {assuranceFor(lines)}
        {review.hasPrepay ? ' Your prepaid year stays exactly as it is; the new amount applies only when your plan renews.' : ''}
      </p>

      <div className="price-change-prose" style={{
        borderLeft: `4px solid ${SURFACE.calloutBorder}`,
        background: SURFACE.calloutBg,
        borderRadius: `0 ${RADIUS.input}px ${RADIUS.input}px 0`,
        padding: `${SP.md}px ${SP.lg}px`,
        margin: `0 0 ${SP.lg}px`,
        fontSize: FS.bodyLg, lineHeight: LH.body, color: SURFACE.body,
      }}>
        <strong style={{ color: SURFACE.text }}>No action is needed.</strong>{' '}
        Waves does not require a contract. You can change or cancel your recurring service at any time, before or
        after this date, by replying to your email, texting us, or from your portal.
      </div>

    </>
  );
}

function LoadingSkeleton() {
  return (
    <CustomerColumn>
      <div style={{ height: 28, width: '70%', background: SURFACE.border, borderRadius: RADIUS.tag, marginBottom: SP.md }} />
      <div style={{ height: 96, background: SURFACE.border, borderRadius: RADIUS.input, marginBottom: SP.lg }} />
      <div style={{ height: 16, width: '90%', background: SURFACE.border, borderRadius: 4, marginBottom: SP.sm }} />
      <div style={{ height: 16, width: '80%', background: SURFACE.border, borderRadius: 4 }} />
    </CustomerColumn>
  );
}

export default function PriceChangeNoticePage() {
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
      ? (
        <CustomerColumn>
          <PublicStateCard state="error" title="We couldn&rsquo;t load that pricing notice" onRetry={() => setLoadAttempt(a => a + 1)}>
            This looks temporary. Your link is still valid&mdash;check your connection and try again.
          </PublicStateCard>
        </CustomerColumn>
      )
    : error === 'notfound' || !data
      ? (
        <CustomerColumn>
          <PublicStateCard state="not-found" title="Notice not found" contact="call">
            This link is no longer available. If you have a question about your service pricing, give us a call — we're happy to help.
          </PublicStateCard>
        </CustomerColumn>
      )
      : (
        <CustomerColumn className="price-change-page" style={{ fontFamily: DOC_FONT, color: SURFACE.text }}>
          <div className="waves-field-no-print">
            <DocumentActionBar shareTitle="Waves service pricing update" />
          </div>
          <FieldDocumentBody className="field-document-scroll price-change-document">
            <FieldMasthead />
            <FieldTitle
              eyebrow={data.review ? 'Annual rate review' : 'Price change notice'}
              title={data.review
                ? (data.review.lines?.[0]?.effectiveDate
                  && new Set((data.review.lines || []).map((line) => line.effectiveDate)).size === 1
                    ? `Your rate from ${data.review.lines[0].effectiveDate}`
                    : 'Your rates are changing')
                : 'An update to your recurring service'}
              reference={data.review ? 'Advance notice' : `Effective ${data.effectiveDate}`}
            />
            {data.review ? <RateReviewNotice data={data} /> : (
              <>
            <p style={{ fontSize: FS.bodyLg, lineHeight: LH.body, color: SURFACE.body, margin: `0 0 ${SP.lg}px` }}>
              Hi {data.firstName} — thank you for trusting Waves Pest Control to protect your home.
              This is your formal advance notice of an upcoming adjustment to your recurring service price.
            </p>

            <div className="doc-keep price-change-rate-card" data-glass="soft" style={{
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
                  <span className="price-change-meta" style={{ fontSize: FS.body, fontWeight: FW.medium, color: SURFACE.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    {label}
                  </span>
                  <span className="price-change-prose" style={{ fontSize: FS.bodyLg, color: SURFACE.text, fontWeight: FW.semibold }}>
                    {value}
                  </span>
                </div>
              ))}
            </div>

            <h2 className="field-section-heading" style={{ fontFamily: DOC_FONT_SERIF, fontSize: FS.h3, fontWeight: FW.semibold, color: SURFACE.text, margin: `0 0 ${SP.sm}px`, lineHeight: LH.heading }}>
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

            <div className="price-change-prose" style={{
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

              </>
            )}

            <div style={{ marginTop: SP.lg, paddingTop: SP.lg, borderTop: `1px solid ${SURFACE.border}` }}>
              <p className="price-change-meta" style={{ fontSize: FS.body, color: SURFACE.muted, lineHeight: LH.body, margin: 0 }}>
                Questions about this change? Call or text us at{' '}
                <a href={WAVES_SUPPORT_PHONE_TEL} style={{ color: SURFACE.text, fontWeight: FW.medium }}>
                  {data.supportPhone || WAVES_SUPPORT_PHONE_DISPLAY}
                </a>
                {data.review ? '. Adam reads every reply.' : <>{' '}— we're happy to walk through it.</>}
              </p>
            </div>
            <FieldFooter
              label="Price change notice"
              reference={data.review ? 'Advance notice' : `Effective ${data.effectiveDate}`}
            />
          </FieldDocumentBody>
          {data.review && (
            <a
              href="/"
              className="waves-field-no-print"
              data-glass-accent=""
              data-glass-size="primary"
              style={{
                display: 'block', textAlign: 'center', textDecoration: 'none',
                background: '#F0A500', color: NAVY, fontWeight: FW.bold, fontSize: FS.bodyLg,
                borderRadius: 999, padding: '14px 20px', minHeight: 48, boxSizing: 'border-box',
                marginTop: SP.lg,
              }}
            >
              Open my portal
            </a>
          )}
        </CustomerColumn>
      );

  return (
    <>
      <meta name="robots" content="noindex, nofollow" />
      <WavesShell variant="customer" topBar="solid">
        <div data-glass-clear="" style={{ flex: 1, background: SURFACE.page }}>
          {content}
        </div>
      </WavesShell>
    </>
  );
}
