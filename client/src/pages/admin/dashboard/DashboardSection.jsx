// Labeled anchor target for the jump-nav. The scroll-mt offset clears the sticky
// nav bar, which from md stacks the workspace command header, its gap and the
// period card — 272px including the wrapper's bottom padding, measured the same
// at 768, 1024, 1280 and 1440 (the period card is one row at every md+ width).
// md+ clears 288px, so a jumped-to heading lands just under the nav; the old
// xl:scroll-mt-56 (224px) dropped headings 36px under it at 1280 and up.
// `about` renders a native-details dropdown under the header explaining what
// the section is for and how to read it — tap "What is this?" to expand.
export default function DashboardSection({ id, title, caption, about, children }) {
  return (
    <section
      id={id}
      aria-label={title}
      className="mb-6 scroll-mt-56 md:scroll-mt-72"
    >
      <div className="flex items-baseline justify-between gap-3 pb-1.5 border-b border-hairline border-zinc-200">
        <h2 className="text-18 font-medium leading-[1.35] text-zinc-900">{title}</h2>
        {caption && (
          <span className="text-right text-ui-caption text-ink-secondary">{caption}</span>
        )}
      </div>
      {about ? (
        <details className="mb-3">
          <summary className="inline-block min-h-11 cursor-pointer list-none select-none py-2.5 text-ui-caption text-ink-secondary underline decoration-dotted underline-offset-2 hover:text-zinc-900 u-focus-ring">
            What is this?
          </summary>
          <p className="max-w-prose pb-2 text-ui-caption text-ink-secondary">
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
