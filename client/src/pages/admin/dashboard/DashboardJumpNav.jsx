import { useEffect, useRef, useState } from "react";
import { LayoutDashboard } from "lucide-react";
import AdminCommandHeader from "../../../components/admin/AdminCommandHeader";
import {
  Button,
  Card,
  CardBody,
  Field,
  Input,
  Select,
} from "../../../components/ui";

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

// A clicked tab keeps its highlight while its smooth scroll runs; the hold
// ends once scrolling has been quiet this long.
const JUMP_SETTLE_MS = 200;

// The nearest scrolling ancestor: the admin shell's main pane (overflow-y
// auto) on desktop, else the document.
function scrollParent(el) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return document.scrollingElement || document.documentElement;
}

// Scroll mode's active section, from live geometry: the last section whose
// top has passed a line a quarter of the way down the area under the sticky
// nav (measured, since the nav's height changes with the breakpoint and the
// period card's wrapping). A jumped-to heading lands at its scroll margin
// just under the nav, above that line. At the very end of the page the last
// section wins: a short one can never reach the line.
function activeSectionId(els, navBottom, atEnd) {
  if (atEnd) return els[els.length - 1].id;
  const line = navBottom + (window.innerHeight - navBottom) / 4;
  let id = els[0].id;
  for (const el of els) {
    if (el.getBoundingClientRect().top <= line) id = el.id;
  }
  return id;
}

// Sticky section tabs + the period selector that drives the period-scoped
// panels (Core-KPI tiles + Marketing Attribution). Two modes:
//   - scroll mode (default): sections are anchors on the same page; the active
//     tab tracks scroll position (activeSectionId above).
//   - controlled mode (activeSection + onSelectSection passed — the mobile
//     scorecard): the pills are real tabs; the parent owns which single
//     section renders, so scroll tracking is skipped entirely.
export default function DashboardJumpNav({
  title,
  dateLabel,
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
  const navRef = useRef(null);
  // Set while scroll mode is tracking: hold(id) keeps a clicked section lit
  // while its smooth scroll passes other sections.
  const tracker = useRef(null);
  const current = controlled ? activeSection : active;

  useEffect(() => {
    // Controlled mode renders one section at a time — nothing to track.
    const nav = navRef.current;
    if (controlled || !nav) return undefined;
    const scroller = scrollParent(nav);
    const scrollEvents = scroller === document.documentElement || scroller === document.body ? window : scroller;
    let frame = null;
    let holdId = null;
    let holdTimer = null;
    const sync = () => {
      frame = null;
      const els = sections.map((s) => document.getElementById(s.id)).filter(Boolean);
      const navRect = nav.getBoundingClientRect();
      // Nothing laid out yet (or no layout at all, as in jsdom): no geometry
      // to read, so keep the current highlight.
      if (holdId || !els.length || !navRect.height) return;
      const atEnd = scroller.scrollHeight > scroller.clientHeight
        && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      setActive(activeSectionId(els, navRect.bottom, atEnd));
    };
    // The click's scroll went quiet. The clicked section stays lit while its
    // heading is on screen under the nav, even when it is too short to reach
    // the line; if the user scrolled it away mid-flight, follow them instead.
    const release = () => {
      const target = holdId && document.getElementById(holdId);
      holdId = null;
      if (!target) return;
      const { top } = target.getBoundingClientRect();
      if (top < nav.getBoundingClientRect().bottom - 1 || top >= window.innerHeight) sync();
    };
    const settle = () => {
      clearTimeout(holdTimer);
      holdTimer = setTimeout(release, JUMP_SETTLE_MS);
    };
    const onScroll = () => {
      if (holdId) {
        settle();
        return;
      }
      if (frame == null) frame = requestAnimationFrame(sync);
    };
    tracker.current = {
      hold(id) {
        holdId = id;
        settle();
      },
    };
    scrollEvents.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    frame = requestAnimationFrame(sync);
    return () => {
      scrollEvents.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame != null) cancelAnimationFrame(frame);
      clearTimeout(holdTimer);
      tracker.current = null;
    };
  }, [sections, controlled]);

  const jumpTo = (id) => {
    if (controlled) {
      onSelectSection(id);
      return;
    }
    setActive(id);
    const el = document.getElementById(id);
    if (el && typeof el.scrollIntoView === "function") {
      tracker.current?.hold(id);
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const applyCustom = () => {
    if (!draftFrom || draftFrom > todayISO) return;
    onApplyCustomRange(draftFrom);
    setShowRangePicker(false);
  };

  return (
    <div ref={navRef} data-qa="dashboard-jump-nav" className="z-20 mb-5 md:sticky md:top-0 md:bg-surface-page/95 md:pb-3">
      <AdminCommandHeader
        title={title}
        subtitle={dateLabel}
        icon={LayoutDashboard}
        sections={sections.map((section) => ({ key: section.id, label: section.label }))}
        activeKey={current}
        onSectionChange={jumpTo}
        ariaLabel="Dashboard sections"
        navGridClassName="grid-cols-5"
        variant="workspace"
        sticky={false}
        className="mb-3 md:mb-3 md:bg-transparent md:pb-0"
      />

      <Card>
        <CardBody className="flex flex-col gap-3 py-3 xl:flex-row xl:items-center xl:justify-between">
          {/* The period controls keep the dashboard's current state and fetch
              semantics; shared controls provide the comfortable target size. */}
          <div className="relative flex min-w-0 items-center gap-2">
          {periodLabel && (
            <span className="hidden whitespace-nowrap text-ui-caption text-ink-secondary lg:inline">
              {periodLabel}
            </span>
          )}
          <Select
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
            className="md:hidden"
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
          </Select>
          {/* Re-selecting the already-active custom option fires no change
              event, so once a range is applied the select alone can't reopen
              the picker — this button is the way back in on mobile. */}
          {period === "custom" && (
            <Button
              type="button"
              onClick={() => {
                setDraftFrom(customRange?.from || "");
                setShowRangePicker((v) => !v);
              }}
              variant="secondary"
              className="shrink-0 md:hidden"
            >
              Edit
            </Button>
          )}
          <div className="hidden max-w-full overflow-x-auto md:block">
            <div className="inline-flex items-center gap-1">
              {PERIODS.map((p) => (
                <Button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onSelectPeriod(p.id);
                    setShowRangePicker(false);
                  }}
                  variant={period === p.id ? "primary" : "secondary"}
                  aria-pressed={period === p.id}
                  className="shrink-0 px-3"
                >
                  {p.label}
                </Button>
              ))}
              <Button
                type="button"
                onClick={() => {
                  setDraftFrom(customRange?.from || "");
                  setShowRangePicker((v) => !v);
                }}
                variant={period === "custom" ? "primary" : "secondary"}
                aria-pressed={period === "custom"}
                className="shrink-0 whitespace-nowrap px-3"
                title="Custom lookback — pick a start date (through today)"
              >
                {period === "custom" && customRange
                  ? `Since ${customRange.from}`
                  : "Custom"}
              </Button>
            </div>
          </div>
          {showRangePicker && (
            <Card className="absolute right-0 top-full z-30 mt-1 w-[min(320px,calc(100vw-32px))]">
              <CardBody className="flex flex-col gap-3">
                <Field label="Since">
                  <Input
                  type="date"
                  max={todayISO}
                  value={draftFrom}
                  onChange={(e) => setDraftFrom(e.target.value)}
                  />
                </Field>
                <div className="text-ui-caption text-ink-secondary">through today</div>
                <div className="ui-record-actions justify-end">
                <Button
                  type="button"
                  onClick={() => setShowRangePicker(false)}
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={applyCustom}
                  disabled={!draftFrom}
                >
                  Apply
                </Button>
                </div>
              </CardBody>
            </Card>
          )}
        </div>
        </CardBody>
      </Card>
    </div>
  );
}
