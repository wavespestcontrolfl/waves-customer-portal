import { fmtMoney } from '../../lib/money';
import { glassRowInclusions } from '../../lib/estimate-glass-copy';
import { estimateCard, estimateInnerBox } from './cardStyles';
import { W } from './tokens';

/**
 * On-page render of an authored commercial proposal — the same buildings /
 * line items / totals the emailed PDF carries (server-projected via
 * /:token/data's `proposal` block, GATE_ESTIMATE_COMMERCIAL_GLASS).
 *
 * Born from a real lost-trust moment (2026-08-07): a commercial prospect
 * opened their proposal link and found only "your formal proposal is ready —
 * check the email we sent" while that email had bounced, leaving the page
 * unable to answer what the quoted price actually covered. This card puts
 * the line items, totals, and included-service terms ON the page so the
 * link stands alone.
 *
 * Content rules: line items render verbatim from the authored proposal;
 * the inclusions list mirrors the commercial_pest stack in
 * estimate-glass-copy.js (standing owner terms only — no residential
 * guarantee claims). No CTA here: proposal acceptance stays with the
 * account manager (TerminalStateCard explains that), so this card is
 * purely the "what am I paying for" answer.
 */

const lineRow = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 16,
  padding: '9px 0',
  borderBottom: '1px solid #E2DCCB',
  fontSize: 15,
  color: W.textBody,
  lineHeight: 1.45,
};

const amtStyle = {
  fontWeight: 700,
  color: W.blueDeeper,
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
};

export default function ProposalDetailCard({ proposal, pdfEmailed = false }) {
  if (!proposal || !Array.isArray(proposal.buildings) || !proposal.buildings.length) return null;
  const totals = proposal.totals || {};
  const multiBuilding = proposal.buildings.length > 1;
  // The commercial PEST inclusions stack — only when the server classified
  // this proposal's recurring lines as pest work (proposal.pestRecurringOnly,
  // truth-scope rule): a termite/rodent/mixed proposal must not promise
  // recurring pest treatment or cancellable-plan terms, so it shows its line
  // items with no inclusions block at all. Authored `terms` also suppress
  // the stack — the operator's own terms (a commitment period, written
  // cancellation, per-visit interior billing) must never sit beside canned
  // bullets claiming the opposite (codex #3281 r1). The gate lives
  // server-side: /data only ships a `proposal` block under
  // GATE_ESTIMATE_COMMERCIAL_GLASS.
  const inclusions = proposal.pestRecurringOnly === true && !proposal.terms
    ? (glassRowInclusions('commercial_pest') || null)
    : null;

  return (
    <div style={estimateCard()}>
      <div style={{ fontSize: 22, lineHeight: 1.35, fontWeight: 600, color: W.navy, marginBottom: 4 }}>
        {proposal.title || 'Commercial Service Proposal'}
      </div>
      <div style={{ fontSize: 14, color: W.textCaption, marginBottom: 14 }}>
        {/* Only reference the emailed PDF when one was actually delivered —
            an SMS-only send or failed email leg must not recreate the
            "check the email we sent" dead end this card exists to fix. */}
        {pdfEmailed
          ? 'Everything in your formal proposal, itemized — the emailed PDF carries this same detail.'
          : 'Everything in your formal proposal, itemized.'}
      </div>

      {proposal.buildings.map((building, bIdx) => (
        <div key={`${building.name || 'building'}-${bIdx}`} style={{ marginTop: bIdx === 0 ? 0 : 14 }}>
          {multiBuilding ? (
            <div style={{ fontSize: 15, fontWeight: 800, color: W.blueDeeper, marginBottom: 4 }}>
              {building.name || 'Service location'}
            </div>
          ) : null}
          {building.note ? (
            <div style={{ fontSize: 14, color: W.textCaption, marginBottom: 6, lineHeight: 1.5 }}>{building.note}</div>
          ) : null}
          {(building.lineItems || []).map((item, iIdx) => (
            <div key={`${item.description || 'line'}-${iIdx}`} style={lineRow}>
              <span style={{ minWidth: 0 }}>
                {item.description || 'Service'}
                {Number(item.quantity) > 1 ? ` × ${item.quantity}` : ''}
              </span>
              <span style={amtStyle}>
                {fmtMoney(item.amount)}
                {item.frequencyLabel ? (
                  <span style={{ fontWeight: 500, color: W.textCaption }}> {String(item.frequencyLabel).toLowerCase()}</span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ))}

      <div style={{ marginTop: 14 }}>
        {Number(totals.annualRecurring) > 0 ? (
          <div style={lineRow}>
            <span>Recurring service (per year)</span>
            <span style={amtStyle}>{fmtMoney(totals.annualRecurring)}</span>
          </div>
        ) : null}
        {Number(totals.oneTime) > 0 ? (
          <div style={lineRow}>
            <span>One-time services</span>
            <span style={amtStyle}>{fmtMoney(totals.oneTime)}</span>
          </div>
        ) : null}
        {totals.hasTax ? (
          <div style={lineRow}>
            <span>{proposal.taxLabel || 'Sales tax'}</span>
            <span style={amtStyle}>{fmtMoney(totals.totalTax)}</span>
          </div>
        ) : null}
        <div style={{ ...lineRow, borderBottom: 0, fontWeight: 800, color: W.blueDeeper, fontSize: 16 }}>
          <span>First-year total</span>
          <span style={{ ...amtStyle, fontSize: 18 }}>{fmtMoney(totals.firstYearTotal)}</span>
        </div>
        {Number(totals.annualRecurring) > 0 ? (
          <div style={{ fontSize: 14, color: W.textCaption, marginTop: 2 }}>
            Averages {fmtMoney(totals.monthlyEquivalent)}/month across the year for the recurring service.
          </div>
        ) : null}
      </div>

      {proposal.terms ? (
        <div style={{ marginTop: 14, fontSize: 14, color: W.textBody, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
          {proposal.terms}
        </div>
      ) : null}

      {inclusions ? (
        <div style={estimateInnerBox({ marginTop: 16, padding: '16px 16px' })}>
          <div style={{ fontSize: 14, fontWeight: 800, color: W.blueDeeper, marginBottom: 6 }}>
            What your commercial pest service includes
          </div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {inclusions.map((line) => (
              <li key={line} style={{ fontSize: 14, color: W.textBody, lineHeight: 1.6 }}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
