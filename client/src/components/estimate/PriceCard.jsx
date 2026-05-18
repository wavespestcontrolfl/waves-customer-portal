/**
 * Primary price display — frequency-aware. The API stores recurring rates
 * as monthly equivalents, but customers see the actual service cadence:
 * quarterly per quarter, bi-monthly per bi-monthly visit, monthly per month.
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
  if (raw.includes('termite')) return 'termite_bait';
  if (raw.includes('palm')) return 'palm_injection';
  if (raw.includes('rodent') || raw.includes('bait station')) return 'rodent_bait';
  return 'pest_control';
}

function serviceInclusions(row = {}) {
  return SERVICE_INCLUSIONS[serviceKey(row)] || SERVICE_INCLUSIONS.pest_control;
}

export default function PriceCard({ frequency, waveGuardTier }) {
  if (!frequency) return null;

  const monthly = frequency.monthly;
  const annual = frequency.annual;
  const intervalMonths = frequency.key === 'quarterly' ? 3 : frequency.key === 'bi_monthly' ? 2 : 1;
  const periodLabel = frequency.key === 'quarterly' ? '/quarter' : frequency.key === 'bi_monthly' ? '/bi-monthly' : '/mo';
  const cadencePrice = monthly == null ? null : Math.round(Number(monthly) * intervalMonths * 100) / 100;
  const anchorPrice = Number(frequency.perVisit || 0);
  const savings = cadencePrice != null && anchorPrice > cadencePrice ? Math.round((anchorPrice - cadencePrice) * 100) / 100 : 0;
  const dayPrice = monthly == null ? null : Math.round((Number(monthly) / 30) * 100) / 100;
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
        {savings > 0 ? (
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
          fontSize: 58,
          fontWeight: 500,
          color: W.blueDeeper,
          lineHeight: 1,
        }}>
        {fmtMoney(cadencePrice)}
        </span>
        <span style={{ fontSize: 24, fontWeight: 500, color: '#6B7280' }}>{periodLabel}</span>
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

      {savings > 0 && waveGuardTier ? (
        <div style={{ marginTop: 12, color: W.green, fontSize: 16, fontWeight: 800 }}>
          You save {fmtMoney(savings)}{periodLabel} with WaveGuard {waveGuardTier}
        </div>
      ) : null}

      {annual ? (
        <div style={{ fontSize: 14, color: '#6B7280', marginTop: 8 }}>
          {fmtMoney(annual)} / year
        </div>
      ) : null}

      {dayPrice ? (
        <div style={{ fontSize: 15, color: '#6B7280', marginTop: 8, lineHeight: 1.5 }}>
          That's just {fmtMoney(dayPrice)}/day for complete home protection.
        </div>
      ) : null}

      <div style={{ fontSize: 16, color: W.blueDeeper, marginTop: 14, lineHeight: 1.5 }}>
        Try us risk-free — 90-day money-back guarantee.
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
