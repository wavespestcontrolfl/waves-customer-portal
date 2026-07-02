// Collapsible wrapper for lower-priority dashboard cards on mobile — a native
// <details> so heavy charts stay unmounted-cheap and the fold state needs no JS.
export default function MobileFold({ title, sub, children }) {
  return (
    <details className="md:hidden mb-3 rounded-xl border-hairline border-zinc-200 bg-white shadow-sm overflow-hidden">
      <summary className="list-none cursor-pointer select-none px-4 py-4 flex items-center justify-between gap-3">
        <span className="u-label text-zinc-900">{title}</span>
        {sub && (
          <span className="text-12 text-ink-secondary text-right truncate">
            {sub}
          </span>
        )}
      </summary>
      <div className="px-3 pb-3">{children}</div>
    </details>
  );
}
