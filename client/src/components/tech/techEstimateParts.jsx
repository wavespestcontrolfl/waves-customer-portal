// Pieces shared by the technician estimate screens (TechEstimateSheet, TechMyEstimates). The field dialogs
// keep FieldLeadModal's look: inline styles, ink on white, red only for a genuine error.

export const INK = '#1c1917';
export const MUTED = '#57534e';
export const LINE = '#d6d3d1';

export const s = {
  label: { display: 'block', fontSize: 14, fontWeight: 500, color: MUTED, marginBottom: 6 },
  input: {
    width: '100%', padding: '10px 12px', borderRadius: 4, border: `1px solid ${LINE}`, fontSize: 16,
    color: INK, marginBottom: 10, background: '#fff', boxSizing: 'border-box', minHeight: 44,
  },
  card: { background: '#fafaf9', border: '0.5px solid #e7e5e4', borderRadius: 6, padding: 14, marginBottom: 16, color: INK },
  primary: {
    width: '100%', minHeight: 48, padding: 12, borderRadius: 4, border: 'none', background: INK, color: '#fff',
    fontSize: 16, fontWeight: 500, cursor: 'pointer', marginBottom: 10,
  },
  secondary: {
    width: '100%', minHeight: 44, padding: 10, borderRadius: 4, border: `1px solid ${LINE}`, background: '#fff',
    color: INK, fontSize: 14, fontWeight: 500, cursor: 'pointer', marginBottom: 10,
  },
  small: {
    minHeight: 44, minWidth: 44, padding: '0 12px', borderRadius: 4, border: `1px solid ${LINE}`, background: '#fff',
    color: INK, fontSize: 14, fontWeight: 500, cursor: 'pointer',
  },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '6px 0', fontSize: 14, color: INK },
  muted: { fontSize: 14, color: MUTED, margin: '4px 0 0' },
  notice: { padding: '10px 12px', margin: '0 0 14px', borderRadius: 6, background: '#fef3c7', color: '#854d0e', fontSize: 14 },
  error: { padding: '10px 12px', margin: '0 0 14px', borderRadius: 6, background: '#fcebeb', color: '#a32d2d', fontSize: 14 },
};

// "$45.00 a month · $540.00 a year", leaving out a total that is zero.
export const totalsWords = (quote) => [
  [quote.monthlyTotal, 'a month'], [quote.annualTotal, 'a year'], [quote.oneTimeTotal, 'one time'],
].filter(([value]) => Number(value) > 0).map(([value, unit]) => `${money(value)} ${unit}`).join(' · ') || 'No total';

export const money = (value) => Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const STATUS_WORDS = {
  draft: 'Draft', sent: 'Sent', viewed: 'Viewed', accepted: 'Accepted', declined: 'Declined', expired: 'Expired',
  scheduled: 'Scheduled', send_failed: 'Send failed',
};
export const statusWords = (status) => STATUS_WORDS[status]
  || (String(status || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) || 'Draft');

export function LineList({ lines }) {
  return (
    <div>
      {(lines || []).map((line, i) => (
        <div key={`${line.label}-${i}`} style={s.row}>
          <span>{line.label}</span>
          <span style={{ textAlign: 'right', flexShrink: 0 }}>
            {line.oneTime !== undefined
              ? `${money(line.oneTime)} one time`
              : <>{money(line.monthly)} a month<span style={{ display: 'block', color: MUTED }}>{money(line.annual)} a year</span></>}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Totals({ quote }) {
  return (
    <div style={{ borderTop: `0.5px solid ${LINE}`, marginTop: 6, paddingTop: 6 }}>
      <div style={s.row}><span>Monthly total</span><strong>{money(quote.monthlyTotal)}</strong></div>
      <div style={s.row}><span>Yearly total</span><strong>{money(quote.annualTotal)}</strong></div>
      <div style={s.row}><span>One-time total</span><strong>{money(quote.oneTimeTotal)}</strong></div>
    </div>
  );
}
