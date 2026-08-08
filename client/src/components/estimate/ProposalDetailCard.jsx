import { fmtMoney } from '../../lib/money';
import { glassRowInclusions } from '../../lib/estimate-glass-copy';
import { commercialTermRows, proposalHasAuthoredTerms } from '../../lib/proposal-sections';
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
  // Programs-mode proposals (slice 1A-ii) have no top-level buildings —
  // either itemization renders the card.
  const programs = Array.isArray(proposal?.programs) ? proposal.programs : [];
  if (!proposal || ((!Array.isArray(proposal.buildings) || !proposal.buildings.length) && !programs.length)) return null;
  const totals = proposal.totals || {};
  const buildingsList = Array.isArray(proposal.buildings) ? proposal.buildings : [];
  const multiBuilding = buildingsList.length > 1;
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
  // Structured commercialTerms are authored terms in the same sense as the
  // free-text block, so they suppress the canned stack the same way — and
  // programs carry their OWN authored inclusions (slice 1A-ii), so the
  // canned stack would double them.
  const hasPrograms = programs.length > 0;
  const inclusions = proposal.pestRecurringOnly === true && !proposalHasAuthoredTerms(proposal) && !hasPrograms
    ? (glassRowInclusions('commercial_pest') || null)
    : null;
  // Structured agreement sections (slice 1A-i) — every one optional; a legacy
  // proposal (buildings + free terms) renders exactly as before.
  const propertyScopeItems = proposal.propertyScope?.items || [];
  const correctiveWork = Array.isArray(proposal.correctiveWork) ? proposal.correctiveWork : [];
  const responsibilities = Array.isArray(proposal.customerResponsibilities)
    ? proposal.customerResponsibilities : [];
  const termRows = commercialTermRows(proposal.commercialTerms);
  const sectionTitle = {
    fontSize: 14, fontWeight: 800, color: W.blueDeeper, marginTop: 14, marginBottom: 2,
  };
  // Taxable-line identification (codex #3281 r4) — parity with the PDF and
  // the pdfkit document it replaced: mark each taxed amount, show the rate,
  // explain the marker. A mixed taxable/exempt proposal must let the
  // customer verify the calculation line by line.
  const anyTaxableLine = buildingsList.some((b) => (b.lineItems || []).some((li) => li.taxable === true))
    || correctiveWork.some((work) => work.taxable === true)
    || programs.some((program) => program.taxable === true);
  const taxRateSource = Number(totals.taxRate) > 0 ? Number(totals.taxRate) : Number(proposal.taxRate);
  const taxRatePct = taxRateSource > 0 ? (taxRateSource * 100).toFixed(2) : null;
  // One-time-only proposals have no plan year — "First-year total" would
  // imply an ongoing program (codex #3281 r4; same rule as the PDF).
  const grandTotalLabel = Number(totals.annualRecurring) > 0 ? 'First-year total' : 'Total';

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

      {propertyScopeItems.length ? (
        <div style={{ marginBottom: 6 }}>
          <div style={{ ...sectionTitle, marginTop: 0 }}>Property scope</div>
          {propertyScopeItems.map((item, idx) => (
            <div key={`${item.label}-${idx}`} style={{ ...lineRow, padding: '6px 0' }}>
              <span style={{ color: W.textCaption }}>{item.label}</span>
              <span style={{ fontWeight: 600, color: W.textBody, textAlign: 'right', minWidth: 0 }}>{item.value}</span>
            </div>
          ))}
        </div>
      ) : null}

      {programs.length ? (
        <div>
          {/* Overview line (derived, never typed): the agreement at a glance. */}
          <div style={{ ...lineRow, padding: '6px 0', fontWeight: 600 }}>
            <span>{programs.reduce((acc, p) => acc + (Number(p.frequencyPerYear) || 0), 0)} service visits per year across {programs.length} program{programs.length === 1 ? '' : 's'}</span>
            {Number(totals.firstYearTotal) > 0 ? (
              <span style={amtStyle}>{fmtMoney(totals.firstYearTotal)} first year</span>
            ) : null}
          </div>
          {programs.map((program, pIdx) => (
            <div key={`${program.label}-${pIdx}`} style={{ marginTop: pIdx === 0 ? 8 : 14 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: W.blueDeeper, marginBottom: 2 }}>{program.label}</div>
              {program.note ? (
                <div style={{ fontSize: 14, color: W.textCaption, marginBottom: 4, lineHeight: 1.5 }}>{program.note}</div>
              ) : null}
              <div style={lineRow}>
                <span>{program.frequencyPerYear} visit{program.frequencyPerYear === 1 ? '' : 's'} per year</span>
                <span style={amtStyle}>
                  {fmtMoney(program.pricePerApplication)}
                  {program.taxable === true ? ' *' : ''}
                  <span style={{ fontWeight: 500, color: W.textCaption }}> per application</span>
                </span>
              </div>
              <div style={lineRow}>
                <span>Annual program total</span>
                <span style={amtStyle}>{fmtMoney(program.annual)}</span>
              </div>
              {(program.buildings || []).length ? (
                <div style={{ fontSize: 14, color: W.textCaption, marginTop: 4, lineHeight: 1.5 }}>
                  Covers: {program.buildings.map((b) => b.name).join(' · ')}
                </div>
              ) : null}
              {(program.inclusions || []).length ? (
                <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                  {program.inclusions.map((line) => (
                    <li key={line} style={{ fontSize: 14, color: W.textBody, lineHeight: 1.6 }}>{line}</li>
                  ))}
                </ul>
              ) : null}
              {(program.exclusions || []).length ? (
                <div style={{ fontSize: 14, color: W.textCaption, marginTop: 4, lineHeight: 1.55 }}>
                  Not included (quoted separately): {program.exclusions.join(' · ')}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {buildingsList.map((building, bIdx) => (
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
                {item.taxable === true ? ' *' : ''}
                {item.frequencyLabel ? (
                  <span style={{ fontWeight: 500, color: W.textCaption }}> {String(item.frequencyLabel).toLowerCase()}</span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ))}

      {correctiveWork.length ? (
        <div>
          <div style={sectionTitle}>Corrective work (one-time)</div>
          {correctiveWork.map((work, idx) => (
            <div key={`${work.label}-${idx}`} style={lineRow}>
              <span style={{ minWidth: 0 }}>
                {work.label}
                {(work.includes || []).length ? (
                  <ul style={{ margin: '2px 0 0', paddingLeft: 20 }}>
                    {work.includes.map((inc) => (
                      <li key={inc} style={{ fontSize: 14, color: W.textCaption, lineHeight: 1.55 }}>{inc}</li>
                    ))}
                  </ul>
                ) : null}
              </span>
              <span style={amtStyle}>
                {fmtMoney(work.amount)}
                {work.taxable === true ? ' *' : ''}
                <span style={{ fontWeight: 500, color: W.textCaption }}> one-time</span>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {responsibilities.length ? (
        <div>
          <div style={sectionTitle}>Customer responsibilities</div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {responsibilities.map((line) => (
              <li key={line} style={{ fontSize: 14, color: W.textBody, lineHeight: 1.6 }}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

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
            <span>
              {proposal.taxLabel || 'Sales tax'}
              {taxRatePct ? ` (${taxRatePct}%)` : ''}
            </span>
            <span style={amtStyle}>{fmtMoney(totals.totalTax)}</span>
          </div>
        ) : null}
        <div style={{ ...lineRow, borderBottom: 0, fontWeight: 800, color: W.blueDeeper, fontSize: 16 }}>
          <span>{grandTotalLabel}</span>
          <span style={{ ...amtStyle, fontSize: 18 }}>{fmtMoney(totals.firstYearTotal)}</span>
        </div>
        {Number(totals.annualRecurring) > 0 ? (
          <div style={{ fontSize: 14, color: W.textCaption, marginTop: 2 }}>
            Averages {fmtMoney(totals.monthlyEquivalent)}/month across the year for the recurring service.
          </div>
        ) : null}
        {totals.hasTax || anyTaxableLine ? (
          <div style={{ fontSize: 13, color: W.textCaption, marginTop: 6, lineHeight: 1.5 }}>
            * Taxable line. Tax applies only to lines marked taxable, at the Florida state rate plus
            the service county surtax. Residential pest control and residential lawn maintenance are
            tax-exempt in Florida; commercial services may be taxable.
          </div>
        ) : null}
      </div>

      {termRows.length ? (
        <div>
          <div style={sectionTitle}>Service terms</div>
          {termRows.map(([label, value]) => (
            <div key={label} style={{ ...lineRow, padding: '6px 0' }}>
              <span style={{ flex: 'none', width: 150, color: W.textCaption }}>{label}</span>
              <span style={{ minWidth: 0, textAlign: 'right' }}>{value}</span>
            </div>
          ))}
        </div>
      ) : null}

      {proposal.terms ? (
        <div>
          {termRows.length ? <div style={sectionTitle}>Additional terms</div> : null}
          <div style={{ marginTop: termRows.length ? 0 : 14, fontSize: 14, color: W.textBody, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
            {proposal.terms}
          </div>
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
