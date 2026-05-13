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

function fmtMoney(n) {
  if (n == null) return '—';
  const v = Math.round(Number(n) * 100) / 100;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
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
    </div>
  );
}
