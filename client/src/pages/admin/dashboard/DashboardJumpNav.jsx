import { useEffect, useState } from "react";
import { cn } from "../../../components/ui";

// Point-in-time → rolling windows (inclusive of today) → calendar-to-date.
// Server resolves each id via the shared periodStartDate (admin-dashboard.js).
const PERIODS = [
  { id: "today", label: "Today" },
  { id: "last_7", label: "7D" },
  { id: "last_30", label: "30D" },
  { id: "last_90", label: "90D" },
  { id: "wtd", label: "WTD" },
  { id: "mtd", label: "MTD" },
  { id: "qtd", label: "QTD" },
  { id: "ytd", label: "YTD" },
];

// Sticky section tabs + the period selector that drives the period-scoped
// panels (Core-KPI tiles + Marketing Attribution). Sections are anchors on the
// same page; the active tab tracks scroll via one IntersectionObserver.
export default function DashboardJumpNav({
  sections,
  period,
  customRange,
  todayISO,
  periodLabel,
  onSelectPeriod,
  onApplyCustomRange,
}) {
  const [active, setActive] = useState(sections[0]?.id || null);
  const [showRangePicker, setShowRangePicker] = useState(false);
  const [draftFrom, setDraftFrom] = useState("");

  useEffect(() => {
    // jsdom (tests) has no IntersectionObserver — the nav still renders and
    // scrolls, it just won't live-track the active section.
    if (typeof IntersectionObserver === "undefined") return undefined;
    const els = sections
      .map((s) => document.getElementById(s.id))
      .filter(Boolean);
    if (!els.length) return undefined;
    // A narrow band around the upper third of the viewport: the section whose
    // content crosses it becomes active. Bottom-heavy margin so short trailing
    // sections still win when scrolled to the end.
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { rootMargin: "-15% 0px -70% 0px", threshold: 0 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [sections]);

  const jumpTo = (id) => {
    setActive(id);
    const el = document.getElementById(id);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const applyCustom = () => {
    if (!draftFrom || draftFrom > todayISO) return;
    onApplyCustomRange(draftFrom);
    setShowRangePicker(false);
  };

  // Mobile sticky offset clears the fixed AdminLayoutV2 header (52px + safe
  // area, z-90) — its isMobile cutoff is 768px, i.e. Tailwind's md:.
  return (
    <div className="sticky top-[calc(52px+env(safe-area-inset-top))] md:top-0 z-20 -mx-3 sm:-mx-6 px-3 sm:px-6 pt-2 pb-0 mb-4 bg-surface-page border-b border-hairline border-zinc-200">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-1 md:gap-3">
        {/* Section tabs */}
        <nav
          aria-label="Dashboard sections"
          className="flex items-center gap-1 overflow-x-auto"
        >
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => jumpTo(s.id)}
              className={cn(
                "h-11 sm:h-8 px-2.5 text-12 font-medium u-focus-ring border-b-2 -mb-px transition-colors whitespace-nowrap shrink-0",
                active === s.id
                  ? "border-zinc-900 text-zinc-900"
                  : "border-transparent text-ink-secondary hover:text-zinc-900",
              )}
            >
              {s.label}
            </button>
          ))}
        </nav>

        {/* Period selector — drives the KPI tiles + attribution panels */}
        <div className="relative flex items-center gap-2 pb-1.5 max-md:pb-2">
          {periodLabel && (
            <span className="hidden lg:inline text-12 text-ink-tertiary whitespace-nowrap">
              {periodLabel}
            </span>
          )}
          <div className="max-w-full overflow-x-auto">
            <div className="inline-flex items-center border-hairline border-zinc-200 rounded-sm overflow-hidden">
              {PERIODS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    onSelectPeriod(p.id);
                    setShowRangePicker(false);
                  }}
                  className={cn(
                    "h-11 sm:h-7 px-3 text-11 uppercase tracking-label font-medium u-focus-ring transition-colors shrink-0",
                    period === p.id
                      ? "bg-zinc-900 text-white"
                      : "bg-white text-ink-secondary hover:bg-zinc-50",
                  )}
                >
                  {p.label}
                </button>
              ))}
              <button
                onClick={() => {
                  setDraftFrom(customRange?.from || "");
                  setShowRangePicker((v) => !v);
                }}
                className={cn(
                  "h-11 sm:h-7 px-3 text-11 uppercase tracking-label font-medium u-focus-ring transition-colors shrink-0 border-l border-hairline border-zinc-200 whitespace-nowrap",
                  period === "custom"
                    ? "bg-zinc-900 text-white"
                    : "bg-white text-ink-secondary hover:bg-zinc-50",
                )}
                title="Custom lookback — pick a start date (through today)"
              >
                {period === "custom" && customRange
                  ? `Since ${customRange.from}`
                  : "Custom"}
              </button>
            </div>
          </div>
          {showRangePicker && (
            <div className="absolute right-0 top-full mt-1 z-30 bg-white border-hairline border-zinc-200 rounded-sm shadow-lg p-3 flex flex-col gap-2">
              <label className="text-11 text-ink-tertiary flex items-center justify-between gap-3">
                Since
                <input
                  type="date"
                  max={todayISO}
                  value={draftFrom}
                  onChange={(e) => setDraftFrom(e.target.value)}
                  className="text-12 border-hairline border-zinc-300 rounded-sm px-2 py-1 u-focus-ring"
                />
              </label>
              <div className="text-11 text-ink-tertiary">through today</div>
              <div className="flex justify-end gap-2 mt-1">
                <button
                  onClick={() => setShowRangePicker(false)}
                  className="text-11 text-ink-tertiary hover:text-ink-secondary u-focus-ring"
                >
                  Cancel
                </button>
                <button
                  onClick={applyCustom}
                  disabled={!draftFrom}
                  className="text-11 font-medium px-3 py-1 rounded-sm bg-zinc-900 text-white disabled:opacity-40 u-focus-ring"
                >
                  Apply
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
