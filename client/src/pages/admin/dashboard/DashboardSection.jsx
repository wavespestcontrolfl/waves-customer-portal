// Labeled anchor target for the jump-nav. The scroll-mt offsets clear the
// sticky nav bar (taller on mobile where the bar stacks into two rows).
export default function DashboardSection({ id, title, caption, children }) {
  return (
    <section
      id={id}
      aria-label={title}
      className="scroll-mt-16 max-md:scroll-mt-32 mb-6"
    >
      <div className="flex items-baseline justify-between gap-3 mb-3 pb-1.5 border-b border-hairline border-zinc-200">
        <h2 className="u-label text-zinc-900">{title}</h2>
        {caption && (
          <span className="text-12 text-ink-tertiary text-right">{caption}</span>
        )}
      </div>
      {children}
    </section>
  );
}
