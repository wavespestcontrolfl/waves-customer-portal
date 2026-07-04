// Labeled anchor target for the jump-nav. The scroll-mt offsets clear the
// sticky nav bar (taller on mobile where the bar stacks into two rows).
// `about` renders a native-details dropdown under the header explaining what
// the section is for and how to read it — tap "What is this?" to expand.
export default function DashboardSection({ id, title, caption, about, children }) {
  return (
    <section
      id={id}
      aria-label={title}
      className="scroll-mt-16 max-md:scroll-mt-32 mb-6"
    >
      <div className="flex items-baseline justify-between gap-3 pb-1.5 border-b border-hairline border-zinc-200">
        <h2 className="u-label text-zinc-900">{title}</h2>
        {caption && (
          <span className="text-12 text-ink-tertiary text-right">{caption}</span>
        )}
      </div>
      {about ? (
        <details className="mb-3">
          <summary className="list-none cursor-pointer select-none inline-block py-1.5 text-11 text-ink-tertiary underline decoration-dotted underline-offset-2 hover:text-ink-secondary u-focus-ring">
            What is this?
          </summary>
          <p className="pb-2 text-12 text-ink-secondary leading-relaxed max-w-prose">
            {about}
          </p>
        </details>
      ) : (
        <div className="mb-3" />
      )}
      {children}
    </section>
  );
}
