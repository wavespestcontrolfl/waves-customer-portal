// Tokened price-change notice page (owner policy 2026-07-12): the full,
// formal advance notice the short email/SMS link to. Renders the customer's
// current → new price, the effective date, what stays the same, and the
// no-action-needed / cancel-anytime terms — never "renewal" language (the
// recurring service has no fixed term).
import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { WavesShell, CustomerColumn, PublicStateCard } from '../components/brand';
import DocumentActionBar from '../components/DocumentActionBar';
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
  SHADOW,
} from '../theme-doc';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const NAVY = '#04395E';

const SURFACE = {
  page: DOC.page,
  card: DOC.surface,
  border: DOC.border,
  text: DOC.ink,
  body: DOC.muted,
  muted: DOC.supporting,
  calloutBg: CUSTOMER_SURFACE.successBg,
  calloutBorder: CUSTOMER_SURFACE.successBorder,
  detailBg: '#F9F8F5',
};

const PRINT_STYLE = `
@media print {
  body { background: white !important; }
  .pcn-no-print, [data-brand-footer] { display: none !important; }
  .pcn-card { box-shadow: none !important; border: none !important; }
}
`;

const H2 = { fontFamily: DOC_FONT_SERIF, fontSize: FS.h3, fontWeight: FW.semibold, color: SURFACE.text, margin: `0 0 ${SP.sm}px`, lineHeight: LH.heading };
const BODY = { fontSize: FS.bodyLg, lineHeight: LH.body, color: SURFACE.body, margin: `0 0 ${SP.lg}px` };

function RateRow({ label, value, sub, big, last }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: SP.md,
      padding: `${SP.xs}px 0`, borderBottom: last ? 'none' : `1px solid ${SURFACE.border}`,
    }}>
      <span style={{ fontSize: FS.body, fontWeight: FW.medium, color: SURFACE.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      <span style={{ textAlign: 'right', fontSize: big ? FS.h3 : FS.bodyLg, color: SURFACE.text, fontWeight: big ? FW.bold : FW.semibold }}>
        {value}
        {sub && <span style={{ display: 'block', fontSize: FS.body, fontWeight: FW.medium, color: SURFACE.muted }}>{sub}</span>}
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
  const first = lines[0] || {};
  const several = lines.length > 1;
  return (
    <>
      <h1 className="waves-print-h2" style={{
        fontFamily: DOC_FONT_SERIF, fontSize: FS.h2, fontWeight: FW.bold,
        color: SURFACE.text, margin: `0 0 ${SP.sm}px`, lineHeight: LH.heading,
      }}>
        {new Set(lines.map((l) => l.effectiveDate)).size > 1 ? 'Your rates are changing' : `Your rate from ${first.effectiveDate}`}
      </h1>
      <p style={BODY}>
        Hi {data.firstName}, this is your written notice, at least 30 days ahead, as promised when you signed up.
        {several ? ' Your rates are going up on the dates below.' : ` Your ${(first.service || 'service').toLowerCase()} rate is going up on ${first.effectiveDate}.`}
        {' '}The reasons are below.
      </p>

      {lines.map((line, i) => (
        <div key={`${line.service}-${i}`} data-glass="soft" style={{
          background: SURFACE.detailBg, borderRadius: RADIUS.input,
          padding: `${SP.md}px ${SP.lg}px`, margin: `0 0 ${SP.md}px`,
        }}>
          {several && line.service && (
            <div style={{ fontSize: FS.bodyLg, fontWeight: FW.bold, color: SURFACE.text, marginBottom: SP.xs }}>{line.service}</div>
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

      <h2 style={{ ...H2, marginTop: SP.lg }}>Why your rate specifically</h2>
      {lines.map((line, i) => line.why && (
        <p key={`why-${i}`} style={{ ...BODY, margin: `0 0 ${SP.md}px` }}>
          {several && line.service ? <strong style={{ color: SURFACE.text }}>{line.service}: </strong> : null}
          {line.why}
        </p>
      ))}

      {review.costBlock && (
        <>
          <h2 style={{ ...H2, marginTop: SP.lg }}>What changed this year</h2>
          <p style={{ ...BODY, whiteSpace: 'pre-line' }}>{review.costBlock}</p>
        </>
      )}

      <h2 style={H2}>What stays the same</h2>
      <p style={BODY}>
        Same team, same products, same guarantee: activity between applications means we come back at no charge.
        Your schedule does not change. {assuranceFor(lines)}
        {review.hasPrepay ? ' Your prepaid year stays exactly as it is; the new amount applies only when your plan renews.' : ''}
      </p>

      <div style={{
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

      <a
        href="/"
        className="pcn-no-print"
        data-glass-accent=""
        style={{
          display: 'block', textAlign: 'center', textDecoration: 'none',
          background: '#F0A500', color: NAVY, fontWeight: FW.bold, fontSize: FS.bodyLg,
          borderRadius: 999, padding: '14px 20px', minHeight: 48, boxSizing: 'border-box',
        }}
      >
        Open my portal
      </a>
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
        <CustomerColumn style={{ fontFamily: DOC_FONT, color: SURFACE.text }}>
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
            {data.review ? <RateReviewNotice data={data} /> : (
              <>
            <h1 className="waves-print-h2" style={{
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

              </>
            )}

            <div style={{ marginTop: SP.lg, paddingTop: SP.lg, borderTop: `1px solid ${SURFACE.border}` }}>
              <p style={{ fontSize: FS.body, color: SURFACE.muted, lineHeight: LH.body, margin: 0 }}>
                Questions about this change? Call or text us at{' '}
                <a href={WAVES_SUPPORT_PHONE_TEL} style={{ color: SURFACE.text, fontWeight: FW.medium }}>
                  {data.supportPhone || WAVES_SUPPORT_PHONE_DISPLAY}
                </a>
                {data.review ? '. Adam reads every reply.' : <>{' '}— we're happy to walk through it.</>}
              </p>
            </div>
          </div>
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
