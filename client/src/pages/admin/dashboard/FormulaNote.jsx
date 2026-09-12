// Collapsible "how this number is built" footnote for metric cards. Fine to
// fold away — unlike sample-size warnings (SampleBadge), a formula is reference
// material, not a caveat the owner must see before trusting the number.
export default function FormulaNote({ summary = "How this is calculated", children }) {
  return (
    <details className="mt-3">
      <summary className="min-h-11 cursor-pointer list-none select-none py-2.5 text-ui-caption text-ink-secondary underline decoration-dotted underline-offset-2 hover:text-zinc-900 u-focus-ring">
        {summary}
      </summary>
      <div className="mt-1.5 text-ui-caption text-ink-secondary">{children}</div>
    </details>
  );
}
