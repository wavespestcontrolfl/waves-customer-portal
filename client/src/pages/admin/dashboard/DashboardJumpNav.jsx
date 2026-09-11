import { useEffect, useState } from "react";
import { LayoutDashboard, RefreshCw } from "lucide-react";
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

// Sticky section tabs + the period selector that drives the period-scoped
// panels (Core-KPI tiles + Marketing Attribution). Two modes:
//   - scroll mode (default): sections are anchors on the same page; the active
//     tab tracks scroll via one IntersectionObserver.
//   - controlled mode (activeSection + onSelectSection passed — the mobile
//     scorecard): the pills are real tabs; the parent owns which single
//     section renders, so the observer is skipped entirely.
export default function DashboardJumpNav({
  title,
  dateLabel,
  updatedLabel,
  onRefresh,
  refreshing,
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

  return (
    <div data-qa="dashboard-jump-nav" className="z-20 mb-5 md:sticky md:top-0 md:bg-surface-page/95 md:pb-3">
      <AdminCommandHeader
        title={title}
        icon={LayoutDashboard}
        sections={sections.map((section) => ({ key: section.id, label: section.label }))}
        activeKey={current}
        onSectionChange={jumpTo}
        ariaLabel="Dashboard sections"
        navGridClassName="grid-cols-5"
        variant="workspace"
        sticky={false}
        actions={[
          {
            key: "refresh",
            label: refreshing ? "Refreshing" : "Refresh",
            icon: RefreshCw,
            variant: "secondary",
            onClick: onRefresh,
            disabled: refreshing,
          },
        ]}
        className="mb-3 md:mb-3 md:bg-transparent md:pb-0"
      />

      <Card>
        <CardBody className="flex flex-col gap-3 py-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-ui-caption text-ink-secondary">
            <span>{dateLabel}</span>
            <span>{updatedLabel}</span>
          </div>

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
