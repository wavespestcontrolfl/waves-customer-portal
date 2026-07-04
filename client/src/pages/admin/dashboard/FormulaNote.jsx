// Collapsible "how this number is built" footnote for metric cards. Fine to
// fold away — unlike sample-size warnings (SampleBadge), a formula is reference
// material, not a caveat the owner must see before trusting the number.
export default function FormulaNote({ summary = "How this is calculated", children }) {
  return (
    <details className="mt-3">
      <summary className="list-none cursor-pointer select-none text-11 text-ink-tertiary underline decoration-dotted underline-offset-2 hover:text-ink-secondary">
        {summary}
      </summary>
      <div className="mt-1.5 text-11 text-ink-tertiary leading-relaxed">{children}</div>
    </details>
  );
}
