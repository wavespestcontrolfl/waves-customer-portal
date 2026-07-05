import { useState } from 'react';
import { quoteRequiredReasonText } from '../../lib/quoteDisplay';
import { glassCopyActive, glassPestInclusions, glassTierDisplay } from '../../lib/estimate-glass-copy';

/**
 * Primary price display. Pest frequencies bill by the selected cadence;
 * service-tier programs can keep a monthly bill while showing visit cadence.
 */
const W = {
  blue: '#065A8C', blueBright: '#009CDE', blueDeeper: '#1B2C5B',
  yellow: '#FFD700', green: '#16A34A',
  navy: '#0F172A', textBody: '#334155', textCaption: '#64748B',
  white: '#FFFFFF', offWhite: '#F1F5F9', sand: '#FEF7E0', border: '#CBD5E1',
};

const SERVICE_INCLUSIONS = {
  pest_control: [
    'Exterior perimeter protection around entry-prone areas',
    'Interior service support when activity is reported',
    'Free re-service between recurring visits',
  ],
  lawn_care: [
    'Seasonal turf treatments matched to the lawn program',
    'Weed, fungus, chinch, and turf-stress observations',
    'Treatment notes carried forward for future visits',
  ],
  mosquito: [
    'Targeted barrier application in mosquito resting zones',
    'Standing-water and breeding-pressure observations',
    'Weather-aware treatment timing',
  ],
  tree_shrub: [
    'Ornamental inspection during service visits',
    'Targeted insect, mite, and disease observations',
    'Seasonal plant-health treatment support',
  ],
  termite_bait: [
    'Termite bait station monitoring',
    'Activity documentation when stations are checked',
    'Annual termite inspection support',
  ],
  palm_injection: [
    'Palm health and canopy observations',
    'Nutrition and pest-pressure support by palm count',
    'Future visit notes for visible decline or recovery',
  ],
  rodent_bait: [
    'Exterior bait station monitoring',
    'Rodent activity documentation',
    'Entry-point observations when visible',
  ],
  foam_recurring: [
    'Targeted drill-and-foam treatment at active termite points',
    'Recurring coverage at your selected service cadence',
    'Treatment notes carried forward for each visit',
  ],
};

function fmtMoney(n) {
  if (n == null) return '—';
  const v = Math.round(Number(n) * 100) / 100;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function normalizedTier(value) {
  const raw = String(value || '').replace(/^WaveGuard\s+/i, '');
  return ['Bronze', 'Silver', 'Gold', 'Platinum'].find((tier) => tier.toLowerCase() === raw.toLowerCase()) || raw;
}

function serviceKey(row = {}) {
  const raw = String(row.service || row.key || row.label || '').toLowerCase();
  if (raw.includes('lawn')) return 'lawn_care';
  if (raw.includes('mosquito')) return 'mosquito';
  if (raw.includes('tree') || raw.includes('shrub')) return 'tree_shrub';
  if (raw.includes('foam')) return 'foam_recurring';
  if (raw.includes('termite')) return 'termite_bait';
  if (raw.includes('palm')) return 'palm_injection';
  if (raw.includes('rodent') || raw.includes('bait station')) return 'rodent_bait';
  return 'pest_control';
}

function serviceInclusions(row = {}) {
  return SERVICE_INCLUSIONS[serviceKey(row)] || SERVICE_INCLUSIONS.pest_control;
}

function billingKeyForFrequency(frequency = {}) {
  return frequency.billingFrequencyKey || frequency.key;
}

function isSeparateServiceCadence(frequency = {}) {
  return !!frequency.billingFrequencyKey
    && frequency.billingFrequencyKey !== frequency.key
    && !!frequency.label;
}

const DEFAULT_WORDING = {
  dayLine: "That's just {amount}/day for complete home protection.",
  guaranteeLine: 'Try us risk-free — 90-day money-back guarantee.',
};

// Pre-discount anchor for a frequency entry, expressed in the displayed
// billing period. Pest entries carry a per-visit anchor (pest bills one visit
// per interval, so per-visit == per-interval); non-pest entries (own-cadence
// ladders and mirrored bundle rows) never get perVisit — they carry
// monthlyBase, the pre-WaveGuard-discount monthly, so the anchor derives from
// it. Without this fallback a tier-discounted lawn/tree/mosquito/termite
// section shows its member price with no evidence a discount was applied.
function anchorPeriodPrice(frequency = {}, intervalMonths = 1) {
  const perVisit = Number(frequency.perVisit || 0);
  if (perVisit > 0) return perVisit;
  const monthlyBase = Number(frequency.monthlyBase || 0);
  if (!(monthlyBase > 0)) return 0;
  return Math.round(monthlyBase * intervalMonths * 100) / 100;
}

// A frequency whose entry carries a manualDiscount has its `monthly` already
// net of that discount (lawn/tree/mosquito single-service ladders subtract it;
// shapeFromV1 bundle totals do too), and the card renders the manual discount
// as its own labeled row. Subtract the manual slice from the anchor-vs-billed
// gap so a promo is never double-reported or mislabeled as WaveGuard savings.
function manualDiscountPerInterval(frequency = {}, intervalMonths = 1) {
  const md = frequency.manualDiscount;
  if (!md || !(Number(md.amount) > 0)) return 0;
  const recurringAnnual = Number(md.recurringAmount ?? md.amount);
  if (!(recurringAnnual > 0)) return 0;
  return Math.round((recurringAnnual / 12) * intervalMonths * 100) / 100;
}

// Inclusion list for a treatment row. Under glass the pest offer stack is
// an accordion, collapsed by default behind "See everything included (N)"
// (approved blueprint behavior) — the full seven bullets are a wall on
// first paint; the count is the hook.
function RowInclusions({ items, collapsible = false }) {
  const [open, setOpen] = useState(false);
  const list = (
    <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: '12px 0 0', borderTop: `1px solid ${W.offWhite}`, display: 'grid', gap: 7 }}>
      {items.map((item) => (
        <li key={item} style={{ position: 'relative', paddingLeft: 18, color: W.textBody, fontSize: 13, fontWeight: 600, lineHeight: 1.4 }}>
          <span style={{ position: 'absolute', left: 0, top: 7, width: 6, height: 6, borderRadius: 999, background: W.blueDeeper }} />
          {item}
        </li>
      ))}
    </ul>
  );
  if (!collapsible) return list;
  return (
    <>
      <button
        type="button"
        className="gc-svc-hint"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide details ▴' : `See everything included (${items.length}) ▾`}
      </button>
      {open ? list : null}
    </>
  );
}

export default function PriceCard({ frequency, waveGuardTier, wording = DEFAULT_WORDING, showSavings = true, showGuarantee = true, glassSetupBullet = false }) {
  if (!frequency) return null;

  // Glass copy pack (?glass=1, PR B): tier display + save-line + pest
  // inclusion swaps live here because they're card-internal content the
  // parent never threads through props.
  const glass = glassCopyActive();
  const monthly = frequency.monthly;
  const annual = frequency.annual;
  const quoteRequired = frequency.quoteRequired === true;
  const quoteReason = quoteRequired ? quoteRequiredReasonText(frequency) : '';
  const billingKey = billingKeyForFrequency(frequency);
  const intervalMonths = billingKey === 'quarterly' ? 3 : billingKey === 'bi_monthly' ? 2 : 1;
  const periodLabel = wording?.periodLabelByKey?.[billingKey]
    || (billingKey === 'quarterly' ? '/quarter' : billingKey === 'bi_monthly' ? '/bi-monthly' : '/mo');
  const cadencePrice = quoteRequired || monthly == null ? null : Math.round(Number(monthly) * intervalMonths * 100) / 100;
  const anchorPrice = anchorPeriodPrice(frequency, intervalMonths);
  // cadencePrice round-trips through the rounded monthly figure (e.g. a $94
  // quarterly visit → $31.33/mo → $93.99/quarter), so a 0%-discount tier
  // (WaveGuard Bronze) can land a phantom cent or two under the per-visit
  // anchor. Anything below this threshold is rounding noise, not a member
  // discount — show no anchor strike-through for it.
  const SAVINGS_ROUNDING_NOISE = 0.05;
  const rawSavings = cadencePrice != null && anchorPrice > cadencePrice
    ? Math.round((anchorPrice - cadencePrice - manualDiscountPerInterval(frequency, intervalMonths)) * 100) / 100
    : 0;
  const savings = rawSavings >= SAVINGS_ROUNDING_NOISE ? rawSavings : 0;
  // True daily rate: annual cost / 365 (monthly * 12 / 365).
  const dayPrice = quoteRequired || monthly == null ? null : Math.round((Number(monthly) * 12 / 365) * 100) / 100;
  // Applications-per-year highlight — only when the count is unambiguous.
  const CADENCE_VISITS = { quarterly: 4, bi_monthly: 6, monthly: 12 };
  const treatmentVisitRows = Array.isArray(frequency.perServiceTreatments)
    ? frequency.perServiceTreatments.filter((row) => Number(row?.visitsPerYear) > 0)
    : [];
  // The cadence-key fallback only applies when there are NO per-service
  // treatment rows: an unsplit combined frequency with several rows of
  // differing counts must not advertise one number for all of them.
  const visitsPerYear = Number(frequency.visitsPerYear) > 0
    ? Number(frequency.visitsPerYear)
    : (treatmentVisitRows.length === 1
      ? Number(treatmentVisitRows[0].visitsPerYear)
      : (treatmentVisitRows.length === 0 ? (CADENCE_VISITS[frequency.key] || null) : null));
  const showVisitsLine = !quoteRequired && Number.isFinite(visitsPerYear) && visitsPerYear > 0;
  // A narrow low-confidence commercial line prices as a ±pct RANGE tied to the
  // displayed cadence price ("$X–$Y/mo, confirmed on site"). The server flags the
  // frequency with lowConfidenceRangePct; the WIDE case is already quote-required
  // upstream (site-confirmation), so this only fires for the self-serve narrow band.
  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  const lowConfidenceRangePct = quoteRequired ? 0 : Number(frequency.lowConfidenceRangePct) || 0;
  // Band only the LOW-confidence SHARE of the price. fraction is 1 for a single
  // all-LOW commercial line and < 1 when the card mixes LOW + exact MEDIUM lines,
  // so a mixed card never overstates the range (e.g. LOW $400 + MED $500 → ±$80,
  // not ±$180). Defaults to 1 if the server didn't send a fraction.
  const rawFraction = Number(frequency.lowConfidenceFraction);
  const lowConfidenceFraction = Number.isFinite(rawFraction) && rawFraction > 0 ? Math.min(rawFraction, 1) : 1;
  const showLowConfidenceRange = lowConfidenceRangePct > 0 && cadencePrice != null && cadencePrice > 0;
  const monthlyBand = showLowConfidenceRange ? cadencePrice * lowConfidenceFraction * lowConfidenceRangePct : 0;
  const rangeLow = showLowConfidenceRange ? round2(cadencePrice - monthlyBand) : null;
  const rangeHigh = showLowConfidenceRange ? round2(cadencePrice + monthlyBand) : null;
  const annualBand = showLowConfidenceRange && annual ? Number(annual) * lowConfidenceFraction * lowConfidenceRangePct : 0;
  const annualRangeLow = showLowConfidenceRange && annual ? round2(Number(annual) - annualBand) : null;
  const annualRangeHigh = showLowConfidenceRange && annual ? round2(Number(annual) + annualBand) : null;
  const manualDiscount = frequency.manualDiscount && Number(frequency.manualDiscount.amount) > 0
    ? frequency.manualDiscount
    : null;
  // Only the recurring slice belongs on a per-interval recurring price card; the
  // one-time slice (recurringAmount vs amount) is shown with one-time services.
  const manualDiscountRecurringAnnual = manualDiscount
    ? Number(manualDiscount.recurringAmount ?? manualDiscount.amount)
    : 0;
  const manualDiscountInterval = manualDiscountRecurringAnnual > 0
    ? Math.round((manualDiscountRecurringAnnual / 12) * intervalMonths * 100) / 100
    : 0;
  // Per-application treatment rows expose EXACT per-visit prices, which would
  // contradict the "confirmed on site" range — so drop them while ranging.
  const treatmentRows = !showLowConfidenceRange && Array.isArray(frequency.perServiceTreatments)
    ? frequency.perServiceTreatments
      .map((row) => ({ ...row, displayPrice: Number(row.displayPrice ?? row.perTreatment) }))
      .filter((row) => Number.isFinite(row.displayPrice) && row.displayPrice > 0)
    : [];

  return (
    <div style={{
      padding: '8px 0 14px',
      marginBottom: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        {showSavings && savings > 0 && !showLowConfidenceRange ? (
          <span style={{
            fontFamily: "'Source Serif 4', Georgia, serif",
            fontSize: 14,
            color: '#9CA3AF',
            textDecoration: 'line-through',
            lineHeight: 1,
          }}>
            {fmtMoney(anchorPrice)}{periodLabel}
          </span>
        ) : null}
        <span style={{
          fontFamily: "'Source Serif 4', Georgia, serif",
          fontSize: quoteRequired ? 26 : showLowConfidenceRange ? 24 : 26,
          fontWeight: 500,
          color: W.blueDeeper,
          lineHeight: 1,
        }}>
        {quoteRequired
          ? 'Quote required'
          : showLowConfidenceRange
          ? `${fmtMoney(rangeLow)}–${fmtMoney(rangeHigh)}`
          : fmtMoney(cadencePrice)}
        </span>
        {!quoteRequired ? (
          <span style={{ fontSize: 14, fontWeight: 500, color: '#6B7280', whiteSpace: 'nowrap' }}>{periodLabel}</span>
        ) : null}
        {waveGuardTier ? (
          <span style={{
            display: 'inline-block',
            padding: '5px 11px',
            background: '#EEF2FF',
            color: W.blueDeeper,
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: '0.02em',
          }}>
            WaveGuard {glass ? glassTierDisplay(waveGuardTier) : waveGuardTier}
          </span>
        ) : null}
      </div>

      {showVisitsLine ? (
        <div style={{ marginTop: 10, color: W.blueDeeper, fontSize: 15, fontWeight: 700 }}>
          <span aria-hidden="true" style={{ color: W.green, marginRight: 6 }}>&#10003;</span>
          {visitsPerYear} application{visitsPerYear === 1 ? '' : 's'} per year included
        </div>
      ) : null}

      {/* Standard exact prices show no annual figure (owner directive
          2026-07-03) — only the site-confirmation commercial range keeps
          its annual band, since the ranged /mo figure alone understates
          the commitment being confirmed on site. */}
      {!quoteRequired && annual && showLowConfidenceRange ? (
        <div style={{ fontSize: 14, color: '#6B7280', marginTop: 8 }}>
          {`${fmtMoney(annualRangeLow)} – ${fmtMoney(annualRangeHigh)} / year`}
        </div>
      ) : null}

      {showLowConfidenceRange ? (
        <div style={{ fontSize: 14, color: '#475569', marginTop: 10, lineHeight: 1.5, fontWeight: 600 }}>
          Estimated range — we confirm your exact price with a quick site visit before your first service.
        </div>
      ) : null}

      {quoteRequired && quoteReason ? (
        <div style={{ fontSize: 15, color: '#92400E', marginTop: 10, lineHeight: 1.45, fontWeight: 700 }}>
          {quoteReason}
        </div>
      ) : null}

      {manualDiscount && manualDiscountInterval > 0 ? (
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 12,
          alignItems: 'center',
          marginTop: 12,
          padding: '10px 12px',
          border: '1px solid #DCFCE7',
          borderRadius: 10,
          background: '#F0FDF4',
          color: W.green,
          fontSize: 14,
          fontWeight: 800,
          lineHeight: 1.35,
        }}>
          <span>{manualDiscount.label || 'Discount'}</span>
          <strong style={{ whiteSpace: 'nowrap' }}>-{fmtMoney(manualDiscountInterval)}{periodLabel}</strong>
        </div>
      ) : null}

      {dayPrice && !showLowConfidenceRange ? (
        <div style={{ fontSize: 15, color: '#6B7280', marginTop: 8, lineHeight: 1.5 }}>
          {(wording?.dayLineByKey?.[billingKey] || wording?.dayLine || DEFAULT_WORDING.dayLine).replace('{amount}', fmtMoney(dayPrice))}
        </div>
      ) : null}

      {showGuarantee ? (
        <div style={{ fontSize: 15, color: W.blueDeeper, marginTop: 12, lineHeight: 1.5 }}>
          {wording?.guaranteeLine || DEFAULT_WORDING.guaranteeLine}
        </div>
      ) : null}

      {treatmentRows.length ? (
        <div style={{ display: 'grid', gap: 12, marginTop: 18 }}>
          {treatmentRows.map((row, index) => (
            <div
              key={`${row.service || row.label || 'service'}-${index}`}
              style={{
                border: `1px solid ${W.border}`,
                borderRadius: 10,
                padding: 14,
                background: W.white,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: W.blueDeeper, lineHeight: 1.35 }}>
                  {row.label || 'Service application'}
                </div>
                <div style={{ fontSize: 15, fontWeight: 800, color: W.blueDeeper, whiteSpace: 'nowrap' }}>
                  {fmtMoney(row.displayPrice)} <span style={{ color: W.textCaption, fontWeight: 500 }}>/ application</span>
                </div>
              </div>
              <div style={{ marginTop: 3, fontSize: 12, color: W.textCaption, lineHeight: 1.4 }}>
                {Number(row.visitsPerYear) > 0 ? `${row.visitsPerYear} applications/year` : 'Service applications/year'}
                {waveGuardTier ? (glass ? ` · WaveGuard ${glassTierDisplay(normalizedTier(waveGuardTier))}` : ` - WaveGuard ${normalizedTier(waveGuardTier)}`) : ''}
              </div>
              <RowInclusions
                items={glass && serviceKey(row) === 'pest_control'
                  ? glassPestInclusions(row.visitsPerYear, glassSetupBullet)
                  : serviceInclusions(row)}
                collapsible={glass && serviceKey(row) === 'pest_control'}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
