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

  return (
    <div style={{
      background: W.white, borderRadius: 16, padding: 24,
      boxShadow: '0 2px 12px rgba(15,23,42,0.06)',
      borderTop: `4px solid ${W.blueBright}`,
      marginBottom: 16,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: W.blueBright,
        textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
        {frequency.label} pest control
      </div>

      <div style={{ fontSize: 42, fontWeight: 700, color: W.navy, lineHeight: 1.1 }}>
        {fmtMoney(cadencePrice)}
        <span style={{ fontSize: 18, fontWeight: 500, color: W.textBody, marginLeft: 6 }}>{periodLabel}</span>
      </div>

      {annual ? (
        <div style={{ fontSize: 14, color: W.textCaption, marginTop: 4 }}>
          {fmtMoney(annual)} / year
        </div>
      ) : null}

      {waveGuardTier ? (
        <div style={{
          display: 'inline-block', marginTop: 14, padding: '6px 12px',
          background: W.sand, color: W.blueDeeper,
          borderRadius: 999, fontSize: 13, fontWeight: 600,
        }}>
          WaveGuard {waveGuardTier}
        </div>
      ) : null}

      <div style={{ fontSize: 13, color: W.textBody, marginTop: 16, lineHeight: 1.5 }}>
        Not satisfied after your first visit? We convert to one-time pricing and you pay the difference only.
      </div>
    </div>
  );
}
