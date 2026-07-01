import { quoteRequiredReasonText } from '../../lib/quoteDisplay';

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

export default function PriceCard({ frequency, waveGuardTier, wording = DEFAULT_WORDING }) {
  if (!frequency) return null;

  const monthly = frequency.monthly;
  const annual = frequency.annual;
  const quoteRequired = frequency.quoteRequired === true;
  const quoteReason = quoteRequired ? quoteRequiredReasonText(frequency) : '';
  const billingKey = billingKeyForFrequency(frequency);
  const intervalMonths = billingKey === 'quarterly' ? 3 : billingKey === 'bi_monthly' ? 2 : 1;
  const periodLabel = wording?.periodLabelByKey?.[billingKey]
    || (billingKey === 'quarterly' ? '/quarter' : billingKey === 'bi_monthly' ? '/bi-monthly' : '/mo');
  const serviceCadenceLabel = isSeparateServiceCadence(frequency) ? frequency.label : null;
  const cadencePrice = quoteRequired || monthly == null ? null : Math.round(Number(monthly) * intervalMonths * 100) / 100;
  const anchorPrice = Number(frequency.perVisit || 0);
  const savings = cadencePrice != null && anchorPrice > cadencePrice ? Math.round((anchorPrice - cadencePrice) * 100) / 100 : 0;
  // True daily rate: annual cost / 365 (monthly * 12 / 365).
  const dayPrice = quoteRequired || monthly == null ? null : Math.round((Number(monthly) * 12 / 365) * 100) / 100;
  // A narrow low-confidence commercial line prices as a ±pct RANGE tied to the
  // displayed cadence price ("$X–$Y/mo, confirmed on site"). The server flags the
  // frequency with lowConfidenceRangePct; the WIDE case is already quote-required
  // upstream (site-confirmation), so this only fires for the self-serve narrow band.
  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  const lowConfidenceRangePct = quoteRequired ? 0 : Number(frequency.lowConfidenceRangePct) || 0;
  const showLowConfidenceRange = lowConfidenceRangePct > 0 && cadencePrice != null && cadencePrice > 0;
  const rangeLow = showLowConfidenceRange ? round2(cadencePrice * (1 - lowConfidenceRangePct)) : null;
  const rangeHigh = showLowConfidenceRange ? round2(cadencePrice * (1 + lowConfidenceRangePct)) : null;
  const annualRangeLow = showLowConfidenceRange && annual ? round2(Number(annual) * (1 - lowConfidenceRangePct)) : null;
  const annualRangeHigh = showLowConfidenceRange && annual ? round2(Number(annual) * (1 + lowConfidenceRangePct)) : null;
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
  const treatmentRows = Array.isArray(frequency.perServiceTreatments)
    ? frequency.perServiceTreatments
      .map((row) => ({ ...row, displayPrice: Number(row.displayPrice ?? row.perTreatment) }))
      .filter((row) => Number.isFinite(row.displayPrice) && row.displayPrice > 0)
    : [];

  return (
    <div style={{
      padding: '8px 0 14px',
      marginBottom: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
        {savings > 0 && !showLowConfidenceRange ? (
          <span style={{
            fontFamily: "'Source Serif 4', Georgia, serif",
            fontSize: 26,
            color: '#9CA3AF',
            textDecoration: 'line-through',
            lineHeight: 1,
          }}>
            {fmtMoney(anchorPrice)}{periodLabel}
          </span>
        ) : null}
        <span style={{
          fontFamily: "'Source Serif 4', Georgia, serif",
          fontSize: quoteRequired ? 42 : showLowConfidenceRange ? 40 : 58,
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
          <span style={{ fontSize: 24, fontWeight: 500, color: '#6B7280' }}>{periodLabel}</span>
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
            WaveGuard {waveGuardTier}
          </span>
        ) : null}
      </div>

      {savings > 0 && waveGuardTier && !showLowConfidenceRange ? (
        <div style={{ marginTop: 12, color: W.green, fontSize: 16, fontWeight: 800 }}>
          You save {fmtMoney(savings)}{periodLabel} with WaveGuard {waveGuardTier}
        </div>
      ) : null}

      {!quoteRequired && annual ? (
        <div style={{ fontSize: 14, color: '#6B7280', marginTop: 8 }}>
          {showLowConfidenceRange
            ? `${fmtMoney(annualRangeLow)} – ${fmtMoney(annualRangeHigh)} / year`
            : `${fmtMoney(annual)} / year`}
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

      {serviceCadenceLabel ? (
        <div style={{ fontSize: 14, color: '#475569', marginTop: 8, fontWeight: 700 }}>
          Service visits: {serviceCadenceLabel}
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
          {(wording?.dayLine || DEFAULT_WORDING.dayLine).replace('{amount}', fmtMoney(dayPrice))}
        </div>
      ) : null}

      <div style={{ fontSize: 16, color: W.blueDeeper, marginTop: 14, lineHeight: 1.5 }}>
        {wording?.guaranteeLine || DEFAULT_WORDING.guaranteeLine}
      </div>

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
                {waveGuardTier ? ` - WaveGuard ${normalizedTier(waveGuardTier)}` : ''}
              </div>
              <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: '12px 0 0', borderTop: `1px solid ${W.offWhite}`, display: 'grid', gap: 7 }}>
                {serviceInclusions(row).map((item) => (
                  <li key={item} style={{ position: 'relative', paddingLeft: 18, color: W.textBody, fontSize: 13, fontWeight: 600, lineHeight: 1.4 }}>
                    <span style={{ position: 'absolute', left: 0, top: 7, width: 6, height: 6, borderRadius: 999, background: W.blueDeeper }} />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
