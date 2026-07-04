import { useEffect, useState } from "react";
import { cn } from "../../../components/ui";

// Point-in-time → rolling windows (inclusive of today) → calendar-to-date.
// Server resolves each id via the shared periodStartDate (admin-dashboard.js).
// `long` is the mobile <select> label — the abbreviations earn their keep as
// desktop pills but read like alphabet soup in a dropdown.
const PERIODS = [
  { id: "today", label: "Today", long: "Today" },
  { id: "last_7", label: "7D", long: "Last 7 days" },
  { id: "last_30", label: "30D", long: "Last 30 days" },
  { id: "last_90", label: "90D", long: "Last 90 days" },
  { id: "wtd", label: "WTD", long: "Week to date" },
  { id: "mtd", label: "MTD", long: "Month to date" },
  { id: "qtd", label: "QTD", long: "Quarter to date" },
  { id: "ytd", label: "YTD", long: "Year to date" },
];

// Sticky section tabs + the period selector that drives the period-scoped
// panels (Core-KPI tiles + Marketing Attribution). Two modes:
//   - scroll mode (default): sections are anchors on the same page; the active
//     tab tracks scroll via one IntersectionObserver.
//   - controlled mode (activeSection + onSelectSection passed — the mobile
//     scorecard): the pills are real tabs; the parent owns which single
//     section renders, so the observer is skipped entirely.
export default function DashboardJumpNav({
  sections,
  period,
  customRange,
  todayISO,
  periodLabel,
  onSelectPeriod,
  onApplyCustomRange,
  activeSection,
  onSelectSection,
}) {
  const controlled = typeof onSelectSection === "function";
  const [active, setActive] = useState(sections[0]?.id || null);
  const [showRangePicker, setShowRangePicker] = useState(false);
  const [draftFrom, setDraftFrom] = useState("");
  const current = controlled ? activeSection : active;

  useEffect(() => {
    // Controlled mode renders one section at a time — nothing to observe.
    if (controlled) return undefined;
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
  }, [sections, controlled]);

  const jumpTo = (id) => {
    if (controlled) {
      onSelectSection(id);
      return;
    }
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

  // Mobile sticky offset: .admin-main is the scroll container and its
  // paddingTop is 52px + safe-area + 16px, and sticky offsets resolve from the
  // padding edge — so top:-16px parks the bar exactly flush under the fixed
  // 52px+safe-area AdminLayoutV2 header (a positive 52px offset doubled the
  // header height and let content scroll through a see-through band above the
  // pills). isMobile cutoff is 768px, i.e. Tailwind's md:.
  return (
    <div className="sticky top-[-16px] md:top-0 z-20 -mx-3 sm:-mx-6 px-3 sm:px-6 pt-1.5 md:pt-2 pb-0 mb-3 md:mb-4 bg-surface-page border-b border-hairline border-zinc-200">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-1.5 md:gap-3">
        {/* Section tabs — a full-width 5-up segmented row on mobile (every tab
            always visible, no scroll), inline pills on desktop. */}
        <nav
          aria-label="Dashboard sections"
          className="grid grid-cols-5 md:flex md:items-center md:gap-1 md:overflow-x-auto"
        >
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => jumpTo(s.id)}
              aria-current={current === s.id ? "true" : undefined}
              className={cn(
                "h-10 md:h-8 px-0 md:px-2.5 text-12 font-medium u-focus-ring border-b-2 -mb-px transition-colors whitespace-nowrap md:shrink-0",
                current === s.id
                  ? "border-zinc-900 text-zinc-900"
                  : "border-transparent text-ink-secondary hover:text-zinc-900",
              )}
            >
              {s.label}
            </button>
          ))}
        </nav>

        {/* Period selector — drives the KPI tiles + attribution panels.
            Mobile: one compact native select (the 9-pill strip overflowed a
            390px viewport). Desktop: the original pill strip. */}
        <div className="relative flex items-center gap-2 pb-1.5">
          {periodLabel && (
            <span className="hidden lg:inline text-12 text-ink-tertiary whitespace-nowrap">
              {periodLabel}
            </span>
          )}
          <select
            aria-label="Period"
            value={period}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "custom") {
                // Selecting Custom… opens the date picker; the select snaps
                // back to the current period until a date is actually applied.
                setDraftFrom(customRange?.from || "");
                setShowRangePicker(true);
                return;
              }
              onSelectPeriod(v);
              setShowRangePicker(false);
            }}
            className="md:hidden w-full h-9 text-13 border-hairline border-zinc-200 rounded-sm bg-white px-2 text-zinc-900 u-focus-ring"
          >
            {PERIODS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.long}
              </option>
            ))}
            <option value="custom">
              {period === "custom" && customRange
                ? `Since ${customRange.from}`
                : "Custom range…"}
            </option>
          </select>
          <div className="hidden md:block max-w-full overflow-x-auto">
            <div className="inline-flex items-center border-hairline border-zinc-200 rounded-sm overflow-hidden">
              {PERIODS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    onSelectPeriod(p.id);
                    setShowRangePicker(false);
                  }}
                  className={cn(
                    "h-7 px-3 text-11 uppercase tracking-label font-medium u-focus-ring transition-colors shrink-0",
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
                  "h-7 px-3 text-11 uppercase tracking-label font-medium u-focus-ring transition-colors shrink-0 border-l border-hairline border-zinc-200 whitespace-nowrap",
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
