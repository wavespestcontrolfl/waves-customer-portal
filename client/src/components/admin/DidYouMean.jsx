// "Did you mean" divider for the admin customer pickers (GATE_CUSTOMER_SEARCH_FUZZY).
//
// The customer list endpoints append sound-alike rows after the exact rows,
// each flagged `approximate: true`. A picker that renders the list puts this
// divider before the first approximate row, so a sound-alike is never read as
// an exact hit. Pickers that do not use it show the rows as ordinary ones.

export function isApproximateRow(row) {
  return Boolean(row && row.approximate === true);
}

// Rows in the order given, plus the index of the first approximate row
// (-1 when there is none). Approximate rows always stay after the exact ones.
export function splitApproximate(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const exact = list.filter((row) => !isApproximateRow(row));
  const approximate = list.filter(isApproximateRow);
  return { exact, approximate, rows: [...exact, ...approximate], firstApproximateIndex: approximate.length ? exact.length : -1 };
}

export default function DidYouMean({ className = '', style }) {
  return (
    <div
      role="separator"
      aria-label="Did you mean"
      data-testid="did-you-mean"
      className={className}
      style={{
        padding: '6px 14px',
        // 14px: the portal's minimum readable text.
        fontSize: 14,
        fontWeight: 600,
        color: '#71717A',
        background: '#FAFAFA',
        borderTop: '1px solid #E4E4E7',
        borderBottom: '1px solid #E4E4E7',
        textAlign: 'left',
        ...style,
      }}
    >
      Did you mean
    </div>
  );
}
