// Labeled anchor target for the jump-nav. The scroll-mt offsets clear the sticky
// nav bar, which at md–lg stacks the ~116px workspace command header, its gap and
// the two-row period card — over 240px including the wrapper's bottom padding, so
// the old md:scroll-mt-52 (208px) dropped headings under the chrome. md–xl clears
// 288px; xl+ collapses the period strip onto one row and needs less.
// `about` renders a native-details dropdown under the header explaining what
// the section is for and how to read it — tap "What is this?" to expand.
export default function DashboardSection({ id, title, caption, about, children }) {
  return (
    <section
      id={id}
      aria-label={title}
      className="mb-6 scroll-mt-56 md:scroll-mt-72 xl:scroll-mt-56"
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
