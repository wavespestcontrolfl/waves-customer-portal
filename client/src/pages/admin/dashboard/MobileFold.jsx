import { Card } from "../../../components/ui";

// Collapsible wrapper for lower-priority dashboard cards on mobile — a native
// <details> so heavy charts stay unmounted-cheap and the fold state needs no JS.
export default function MobileFold({ title, sub, children }) {
  return (
    <Card className="mb-3 overflow-hidden md:hidden">
      <details>
        <summary className="flex min-h-11 cursor-pointer list-none select-none items-center justify-between gap-3 px-4 py-3 u-focus-ring">
          <span className="text-14 font-medium text-zinc-900">{title}</span>
          {sub && (
            <span className="truncate text-right text-ui-caption text-ink-secondary">
              {sub}
            </span>
          )}
        </summary>
        <div className="px-4 pb-4">{children}</div>
      </details>
    </Card>
  );
}
