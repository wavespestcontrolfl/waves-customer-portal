import React, { useMemo } from "react";
import PropTypes from "prop-types";
import { Bug, HelpCircle, Leaf, PawPrint, ShieldCheck, Trees } from "lucide-react";
import { classifyEstimate } from "./EstimatePage";
import { Card, cn } from "../../components/ui";
import { etParts } from "../../lib/timezone";

const ROBOTO = "'Roboto', Arial, sans-serif";
const DAY = 86400000;
const HOUR = 3600000;
const DATE_RANGES = [
  { key: "all", label: "All" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "90d", label: "90d" },
  { key: "ytd", label: "YTD" },
];

// Service-line classifier for top-level estimate records. Mirrors
// serviceLineFromAuditLine() in EstimatePage.jsx but operates on the
// estimate-level serviceInterest text (which is what the list API returns)
// rather than audit lines.
export function classifyEstimateServiceLine(estimate) {
  const interest = String(
    estimate?.serviceInterest || estimate?.description || "",
  ).toLowerCase();
  if (/termite|bora.?care|termidor|trelona|advance/.test(interest))
    return "termite";
  if (/mosquito/.test(interest)) return "mosquito";
  if (/rodent|rat|mouse/.test(interest)) return "rodent";
  if (/lawn|turf|fertili[sz]/.test(interest)) return "lawn";
  if (/tree|shrub|palm|ornamental/.test(interest)) return "tree_shrub";
  if (/pest|roach|cockroach|flea|wasp|bed.?bug|ant|spider|general/.test(interest))
    return "pest";
  return "unknown";
}

const SERVICE_META = {
  commercial_pest: { label: "Commercial pest", icon: Bug, ticketSuffix: "manual quote" },
  commercial_lawn: { label: "Commercial lawn", icon: Leaf, ticketSuffix: "manual quote" },
  commercial_mosquito: { label: "Commercial mosquito", icon: Bug, ticketSuffix: "/mo recurring" },
  commercial_termite_bait: { label: "Commercial termite bait", icon: ShieldCheck, ticketSuffix: "/mo recurring" },
  commercial_rodent_bait: { label: "Commercial rodent bait", icon: PawPrint, ticketSuffix: "/mo recurring" },
  pest: { label: "Pest control", icon: Bug, ticketSuffix: "/mo recurring" },
  mosquito: { label: "Mosquito", icon: Bug, ticketSuffix: "/mo recurring" },
  lawn: { label: "Lawn care", icon: Leaf, ticketSuffix: "/mo recurring" },
  tree_shrub: { label: "Tree & shrub", icon: Trees, ticketSuffix: "per visit" },
  rodent: { label: "Rodent", icon: PawPrint, ticketSuffix: "/mo recurring" },
  palm_injection: { label: "Palm injection", icon: Trees, ticketSuffix: "/mo recurring" },
  termite: { label: "Termite bait", icon: ShieldCheck, ticketSuffix: "one-time" },
  unknown: { label: "Unknown", icon: HelpCircle, ticketSuffix: "unclassified" },
};

export function withinDateRange(iso, range, nowMs = Date.now()) {
  if (!iso) return false;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return false;
  const ms = nowMs - ts;
  if (range === "7d") return ms <= 7 * DAY;
  if (range === "30d") return ms <= 30 * DAY;
  if (range === "90d") return ms <= 90 * DAY;
  if (range === "ytd")
    return etParts(new Date(ts)).year === etParts(new Date(nowMs)).year;
  return true;
}

// Most recent customer touch on the estimate. First-view timestamps alone
// misclassify customers who re-open or click days later, so idle-time checks
// must key off the latest of view/re-view/click.
export function lastEngagementMs(estimate) {
  const stamps = [
    estimate?.lastViewedAt,
    estimate?.viewedAt,
    estimate?.lastClickedAt,
  ]
    .map((iso) => (iso ? new Date(iso).getTime() : NaN))
    .filter((ts) => !Number.isNaN(ts));
  return stamps.length ? Math.max(...stamps) : null;
}

// When the offer left the pipeline: acceptance, decline, or expiry date.
// Fallbacks cover rows that predate the timestamp columns. Returns null for
// still-open offers.
export function resolutionDate(estimate) {
  if (estimate?.status === "accepted")
    return estimate.acceptedAt || estimate.createdAt;
  if (estimate?.status === "declined")
    return estimate.declinedAt || estimate.updatedAt || estimate.createdAt;
  if (estimate?.status === "expired")
    return estimate.expiresAt || estimate.updatedAt || estimate.createdAt;
  return null;
}

// Follow-up overdue = offers needing action NOW: a send unopened past 72h, or a
// viewed offer gone quiet past the going-cold window (7d+). Kept DISJOINT from
// isGoingColdEstimate so the two "Needs attention" cards never double-count the
// same offer — every open offer lands in at most one bucket.
export function isFollowUpOverdueEstimate(estimate, nowMs = Date.now()) {
  if (
    estimate?.status === "sent" &&
    !estimate.viewedAt &&
    estimate.sentAt
  ) {
    const sentAt = new Date(estimate.sentAt).getTime();
    return !Number.isNaN(sentAt) && nowMs - sentAt > 72 * HOUR;
  }
  if (estimate?.status === "viewed") {
    const last = lastEngagementMs(estimate);
    return last != null && nowMs - last >= 168 * HOUR;
  }
  return false;
}

// Going cold = the early-warning window only: a VIEWED offer idle 48h–7d. A
// never-opened send is follow-up-overdue (not "cold"), and past 7d a viewed
// offer crosses into follow-up-overdue too — so this is the complement slice,
// disjoint from isFollowUpOverdueEstimate.
export function isGoingColdEstimate(estimate, nowMs = Date.now()) {
  if (estimate?.status !== "viewed") return false;
  const last = lastEngagementMs(estimate);
  if (last == null) return false;
  const age = nowMs - last;
  return age > 48 * HOUR && age < 168 * HOUR;
}

function serviceLineEntriesForEstimate(estimate) {
  if (Array.isArray(estimate.serviceLines) && estimate.serviceLines.length) {
    return estimate.serviceLines
      .map((line) => ({
        key: line && SERVICE_META[line.key] ? line.key : "unknown",
        amount: Number(line?.amount || 0),
        basis: line?.amountBasis === "one_time" ? "one_time" : "monthly",
      }));
  }
  const key = classifyEstimateServiceLine(estimate);
  return [
    { key, amount: Number(estimate.monthlyTotal || 0), basis: "monthly" },
  ];
}

// Aggregate offers/won/avg-ticket per service line. Offers = any non-draft
// estimate in the window, counted once per quoted service line when the API
// provides line-level service data. Won = status === 'accepted'. Monthly and
// one-time amounts are averaged separately — the displayed ticket uses
// whichever basis dominates the line so a one-time job can't inflate a
// "/mo recurring" average (and vice versa).
export function aggregateServiceLineRows(estimates) {
  const buckets = new Map();
  for (const e of estimates) {
    if (e.status === "draft") continue;
    for (const entry of serviceLineEntriesForEstimate(e)) {
      const line = entry.key;
      if (!buckets.has(line))
        buckets.set(line, {
          sent: 0,
          won: 0,
          monthlySum: 0,
          monthlyCount: 0,
          oneTimeSum: 0,
          oneTimeCount: 0,
        });
      const b = buckets.get(line);
      b.sent += 1;
      if (e.status === "accepted") b.won += 1;
      if (entry.amount > 0) {
        if (entry.basis === "one_time") {
          b.oneTimeSum += entry.amount;
          b.oneTimeCount += 1;
        } else {
          b.monthlySum += entry.amount;
          b.monthlyCount += 1;
        }
      }
    }
  }
  return Array.from(buckets.entries())
    .map(([key, b]) => {
      const useOneTime = b.oneTimeCount > b.monthlyCount;
      const ticketSum = useOneTime ? b.oneTimeSum : b.monthlySum;
      const ticketCount = useOneTime ? b.oneTimeCount : b.monthlyCount;
      const metaSuffix = SERVICE_META[key].ticketSuffix;
      let ticketSuffix = metaSuffix;
      if (ticketCount > 0) {
        if (useOneTime) ticketSuffix = "one-time";
        else if (metaSuffix === "one-time") ticketSuffix = "/mo recurring";
      }
      return {
        key,
        ...SERVICE_META[key],
        sent: b.sent,
        won: b.won,
        acceptancePct: b.sent > 0 ? Math.round((b.won / b.sent) * 100) : 0,
        avgTicket: ticketCount > 0 ? Math.round(ticketSum / ticketCount) : 0,
        ticketSuffix,
      };
    })
    .sort((a, b) => b.sent - a.sent || a.label.localeCompare(b.label));
}

function money(value) {
  return `$${Math.round(Number(value || 0)).toLocaleString()}`;
}

function amount(e) {
  return Number(e?.monthlyTotal || 0);
}

// Avg ticket = mean recurring price across priced, non-draft offers. Unpriced
// drafts and one-time-only estimates carry monthlyTotal 0 and would otherwise
// drag the average far below any real ticket.
function pricedOffers(estimates) {
  return estimates.filter((e) => e.status !== "draft" && amount(e) > 0);
}

function avgTicketFor(estimates) {
  const priced = pricedOffers(estimates);
  if (priced.length === 0) return 0;
  return Math.round(priced.reduce((sum, e) => sum + amount(e), 0) / priced.length);
}

// The prior equal-length window immediately before the selected range, so the
// avg-ticket trend compares like-for-like (90d vs prior 90d, not a fixed 30d).
// Returns null for "all" — there is no comparable prior period.
function priorPeriodWindow(range, nowMs) {
  if (range === "7d") return { start: nowMs - 14 * DAY, end: nowMs - 7 * DAY, label: "vs prior 7d" };
  if (range === "30d") return { start: nowMs - 60 * DAY, end: nowMs - 30 * DAY, label: "vs prior 30d" };
  if (range === "90d") return { start: nowMs - 180 * DAY, end: nowMs - 90 * DAY, label: "vs prior 90d" };
  if (range === "ytd") {
    // Anchor Jan 1 at ET midnight (same basis as withinDateRange's ET-year
    // boundary) so the prior window lines up with the current YTD window in any
    // browser timezone. January is always EST (UTC-5), so this is unambiguous.
    const jan1 = Date.UTC(etParts(new Date(nowMs)).year, 0, 1, 5, 0, 0);
    const span = nowMs - jan1;
    return { start: jan1 - span, end: jan1, label: "vs prior period" };
  }
  return null; // "all" — no comparable prior period
}

function estimatesInWindow(estimates, win) {
  if (!win) return [];
  return estimates.filter((e) => {
    if (!e.createdAt) return false;
    const ts = new Date(e.createdAt).getTime();
    return !Number.isNaN(ts) && ts >= win.start && ts < win.end;
  });
}

function StatCard({ label, value, sub }) {
  return (
    <Card className="flex-1 min-w-[140px] p-4 min-h-[104px] flex flex-col items-center justify-center text-center">
      <div className="text-11 uppercase tracking-label text-ink-tertiary mb-1">
        {label}
      </div>
      <div className="text-22 font-medium u-nums text-zinc-900">{value}</div>
      {sub && <div className="text-11 text-ink-tertiary mt-1">{sub}</div>}
    </Card>
  );
}

StatCard.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.node.isRequired,
  sub: PropTypes.node,
};

function SectionHeader({ title, sub }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-hairline border-zinc-200">
      <div className="text-11 uppercase tracking-label text-ink-tertiary">
        {title}
      </div>
      {sub && <div className="text-11 text-ink-tertiary">{sub}</div>}
    </div>
  );
}

SectionHeader.propTypes = {
  title: PropTypes.string.isRequired,
  sub: PropTypes.string,
};

function FunnelTile({ label, value, sub, filterKey, activeFilter, onFilterChange }) {
  const active = activeFilter === filterKey;
  return (
    <button
      type="button"
      onClick={() => onFilterChange(active ? "all" : filterKey)}
      aria-pressed={active}
      className={cn(
        "w-full min-h-9 px-3 py-4 rounded-sm text-left",
        "border-hairline flex items-center justify-between gap-2 u-focus-ring",
        active
          ? "bg-zinc-900 text-white border-zinc-900"
          : "bg-white text-zinc-900 border-zinc-200 hover:bg-zinc-50",
      )}
    >
      <span>
        <span className="block text-11 uppercase tracking-label">{label}</span>
        <span className="block text-11 mt-1 opacity-80">{sub}</span>
      </span>
      <span className="text-22 font-medium u-nums">{value}</span>
    </button>
  );
}

FunnelTile.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.number.isRequired,
  sub: PropTypes.string.isRequired,
  filterKey: PropTypes.string.isRequired,
  activeFilter: PropTypes.string,
  onFilterChange: PropTypes.func.isRequired,
};

function AttentionCard({ label, value, sub, filterKey, alert, onFilterChange }) {
  return (
    <Card className={alert ? "border-alert-fg" : ""}>
      <button
        type="button"
        onClick={() => onFilterChange(filterKey)}
        className={cn(
          "w-full p-4 text-left rounded-sm u-focus-ring",
          alert ? "bg-alert-bg text-alert-fg" : "bg-white text-zinc-900 hover:bg-zinc-50",
        )}
      >
        <div className="text-11 uppercase tracking-label">{label}</div>
        <div className="text-22 font-medium u-nums mt-1">{value}</div>
        <div className="text-11 mt-1">{sub}</div>
      </button>
    </Card>
  );
}

AttentionCard.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.number.isRequired,
  sub: PropTypes.string.isRequired,
  filterKey: PropTypes.string.isRequired,
  alert: PropTypes.bool,
  onFilterChange: PropTypes.func.isRequired,
};

function PricingRiskCard({ value, missingCogs, lowMargin, warnings, onFilterChange }) {
  return (
    <Card>
      <div className="w-full p-4 text-left rounded-sm bg-white text-zinc-900">
        <button
          type="button"
          onClick={() => onFilterChange("pricing_risk")}
          className="w-full text-left rounded-sm u-focus-ring hover:bg-zinc-50"
        >
          <div className="text-11 uppercase tracking-label">Pricing risk</div>
          <div className="text-22 font-medium u-nums mt-1">{value}</div>
        </button>
        <div className="mt-2 flex gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => onFilterChange("missing_cogs")}
            className="px-2 py-1 rounded-full text-11 border-hairline border-zinc-200 text-ink-tertiary u-focus-ring hover:bg-zinc-50"
          >
            <span className="u-nums">{missingCogs}</span> missing COGS
          </button>
          <button
            type="button"
            onClick={() => onFilterChange("low_margin")}
            className="px-2 py-1 rounded-full text-11 border-hairline border-zinc-200 text-ink-tertiary u-focus-ring hover:bg-zinc-50"
          >
            <span className="u-nums">{lowMargin}</span> low margin
          </button>
          {warnings > 0 && (
            <button
              type="button"
              onClick={() => onFilterChange("pricing_warning")}
              className="px-2 py-1 rounded-full text-11 border-hairline border-zinc-200 text-ink-tertiary u-focus-ring hover:bg-zinc-50"
            >
              <span className="u-nums">{warnings}</span> warnings
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

PricingRiskCard.propTypes = {
  value: PropTypes.number.isRequired,
  missingCogs: PropTypes.number.isRequired,
  lowMargin: PropTypes.number.isRequired,
  warnings: PropTypes.number,
  onFilterChange: PropTypes.func.isRequired,
};

export default function PipelineAnalytics({
  estimates,
  onFilterChange,
  activeFilter,
  dateRange = "all",
  onDateRangeChange,
}) {
  const selectedRange = dateRange || "all";
  const metrics = useMemo(() => {
    const nowMs = Date.now();
    // Archived rows ride along ONLY for the Won funnel and MRR-won KPI
    // ("won = won forever"). Every other metric — acceptance rate, avg
    // ticket and its trend, pipeline value, ROI table, attention counts —
    // excludes them: archived LOSSES are never fetched, so counting
    // archived wins there would skew the rates upward.
    const activeRows = estimates.filter((e) => !e.archivedAt);
    const inRange = activeRows.filter((e) =>
      withinDateRange(e.createdAt, selectedRange, nowMs),
    );
    const classified = estimates.map((e) => ({
      ...e,
      _class: e._class || classifyEstimate(e),
    }));

    const total = inRange.length;
    // Resolved-only close rate over RESOLUTION dates: still-open offers
    // don't count until they decline or expire, and the window is keyed on
    // when the offer was resolved — same basis as MRR won, so a win always
    // lands in the same range tab for both KPIs (an offer created before
    // the window but accepted inside it counts in both, not just one).
    const resolvedInRange = activeRows.filter((e) => {
      const resolvedAt = resolutionDate(e);
      return (
        resolvedAt != null && withinDateRange(resolvedAt, selectedRange, nowMs)
      );
    });
    const accepted = resolvedInRange.filter(
      (e) => e.status === "accepted",
    ).length;
    const conversionDenominator = resolvedInRange.length;
    // Won/MRR KPIs key off the acceptance date (createdAt fallback for rows
    // that predate accepted_at): "MRR won (30d)" means won IN the window,
    // not "created in the window and eventually won".
    const acceptedEstimates = estimates.filter(
      (e) =>
        e.status === "accepted" &&
        withinDateRange(e.acceptedAt || e.createdAt, selectedRange, nowMs),
    );
    const totalMRRWon = acceptedEstimates.reduce((sum, e) => sum + amount(e), 0);
    const wonRecurring = acceptedEstimates.filter((e) => amount(e) > 0).length;
    const wonOneTime = acceptedEstimates.length - wonRecurring;
    const pipelineEstimates = inRange.filter(
      (e) => !["accepted", "declined", "expired"].includes(e.status),
    );
    const pipelineValue = pipelineEstimates.reduce((sum, e) => sum + amount(e), 0);
    const avgTicket = avgTicketFor(inRange);
    const priorWin = priorPeriodWindow(selectedRange, nowMs);
    const priorAvg = avgTicketFor(estimatesInWindow(activeRows, priorWin));
    const avgDelta = Math.round(avgTicket - priorAvg);
    // "all" has no comparable prior window → no trend line (StatCard hides a
    // null sub) rather than a meaningless "vs prior period".
    const avgTrend = !priorWin
      ? null
      : priorAvg === 0
        ? `→ ${priorWin.label}`
        : `${avgDelta > 0 ? "↑" : avgDelta < 0 ? "↓" : "→"} ${money(Math.abs(avgDelta))} ${priorWin.label}`;

    const needsEstimate = classified.filter((e) => e._class === "needs_estimate").length;
    const readyToSend = classified.filter((e) => e._class === "ready_to_send").length;
    const awaiting = classified.filter((e) => e._class === "awaiting").length;
    const followUp = classified.filter((e) => e._class === "follow_up").length;
    const scheduled = classified.filter((e) => e._class === "scheduled").length;
    // Won = won forever: archiving an accepted estimate (housekeeping)
    // must not shrink the funnel, so archived-accepted rows still count.
    const won = classified.filter(
      (e) =>
        e._class === "won" ||
        (e._class === "archived" && e.status === "accepted"),
    );
    const lost = classified.filter((e) => e._class === "lost");
    const wonMrr = won.reduce((sum, e) => sum + amount(e), 0);
    const declinedCount = activeRows.filter(
      (e) => e.status === "declined",
    ).length;
    const expiredCount = activeRows.filter((e) => e.status === "expired").length;

    const followUpOverdue = activeRows.filter((e) =>
      isFollowUpOverdueEstimate(e, nowMs),
    );
    const atRiskMRR = followUpOverdue.reduce((sum, e) => sum + amount(e), 0);
    const pricingRisk = activeRows.filter((e) => e.pricingRisk?.hasRisk);
    const missingCogs = activeRows.filter(
      (e) => (e.pricingRisk?.missingCogsCount || 0) > 0,
    ).length;
    const lowMargin = activeRows.filter(
      (e) => (e.pricingRisk?.lowMarginCount || 0) > 0,
    ).length;
    // Pricing-warning rows (status 'warning' — billed but with audit warnings,
    // no missing-COGS/low-margin line). Surfacing this reconciles the headline
    // pricing-risk count, which is otherwise dominated by this hidden category.
    const pricingWarnings = activeRows.filter(
      (e) => e.pricingRisk?.status === "warning",
    ).length;
    const goingCold = activeRows.filter((e) =>
      isGoingColdEstimate(e, nowMs),
    ).length;

    return {
      inRange,
      kpis: {
        pipelineValue,
        openCount: pipelineEstimates.length,
        avgTicket,
        avgTrend,
        acceptanceRate:
          conversionDenominator > 0
            ? Math.round((accepted / conversionDenominator) * 100)
            : 0,
        accepted,
        closed: conversionDenominator,
        totalMRRWon,
        wonAccounts: acceptedEstimates.length,
        wonRecurring,
        wonOneTime,
      },
      funnel: {
        drafts: needsEstimate + readyToSend,
        needsEstimate,
        readyToSend,
        sent: awaiting + followUp + scheduled,
        awaiting,
        viewed: followUp,
        scheduled,
        won: won.length,
        wonMrr,
        lost: lost.length,
        declined: declinedCount,
        expired: expiredCount,
      },
      serviceRows: aggregateServiceLineRows(inRange),
      attention: {
        followUpOverdue: followUpOverdue.length,
        atRiskMRR,
        pricingRisk: pricingRisk.length,
        missingCogs,
        lowMargin,
        pricingWarnings,
        goingCold,
      },
      total,
    };
  }, [estimates, selectedRange]);

  return (
    <div style={{ fontFamily: ROBOTO }}>
      <div className="flex gap-2 mb-5 flex-wrap items-center">
        <div className="text-11 uppercase tracking-label text-ink-tertiary">
          KPI/ROI range
        </div>
        {DATE_RANGES.map((option) => {
          const active = option.key === selectedRange;
          return (
            <button
              key={option.key}
              type="button"
              onClick={() => onDateRangeChange?.(option.key)}
              aria-pressed={active}
              className={cn(
                "h-8 px-3 rounded-full text-11 font-medium border-hairline u-focus-ring",
                active
                  ? "bg-zinc-900 text-white border-zinc-900"
                  : "bg-white text-zinc-700 border-zinc-300 hover:bg-zinc-50",
              )}
            >
              {option.label}
            </button>
          );
        })}
        {activeFilter && activeFilter !== "all" && (
          <button
            type="button"
            onClick={() => onFilterChange("all")}
            className="h-8 px-3 rounded-full text-11 font-medium border-hairline u-focus-ring bg-white text-zinc-700 border-zinc-300 hover:bg-zinc-50"
          >
            Clear filter
          </button>
        )}
        <button
          type="button"
          onClick={() =>
            onFilterChange(activeFilter === "archived" ? "all" : "archived")
          }
          aria-pressed={activeFilter === "archived"}
          className={cn(
            "h-8 px-3 rounded-full text-11 font-medium border-hairline u-focus-ring",
            activeFilter === "archived"
              ? "bg-zinc-900 text-white border-zinc-900"
              : "bg-white text-zinc-700 border-zinc-300 hover:bg-zinc-50",
          )}
        >
          Archived
        </button>
      </div>

      <div className="flex gap-2 mb-5 flex-wrap">
        <StatCard
          label="Pipeline value"
          value={money(metrics.kpis.pipelineValue)}
          sub={`/mo recurring · ${metrics.kpis.openCount} open`}
        />
        <StatCard
          label="Avg ticket"
          value={money(metrics.kpis.avgTicket)}
          sub={metrics.kpis.avgTrend}
        />
        <StatCard
          label="Offer acceptance"
          value={`${metrics.kpis.acceptanceRate}%`}
          sub={`${metrics.kpis.accepted} accepted of ${metrics.kpis.closed} resolved`}
        />
        <StatCard
          label="MRR won"
          value={money(metrics.kpis.totalMRRWon)}
          sub={
            metrics.kpis.wonOneTime > 0
              ? `${metrics.kpis.wonRecurring} recurring · ${metrics.kpis.wonOneTime} one-time`
              : `${metrics.kpis.wonAccounts} new accounts`
          }
        />
      </div>

      <Card className="mb-5 overflow-hidden">
        <SectionHeader title="Funnel" sub="All-time queue" />
        <div className="p-4 grid grid-cols-1 md:grid-cols-4 gap-2">
          <FunnelTile
            label="Drafts"
            value={metrics.funnel.drafts}
            sub={`${metrics.funnel.readyToSend} ready to send · ${metrics.funnel.needsEstimate} need pricing`}
            filterKey="drafts"
            activeFilter={activeFilter}
            onFilterChange={onFilterChange}
          />
          <FunnelTile
            label="Sent"
            value={metrics.funnel.sent}
            sub={`${metrics.funnel.awaiting} awaiting · ${metrics.funnel.viewed} viewed · ${metrics.funnel.scheduled} scheduled`}
            filterKey="sent_group"
            activeFilter={activeFilter}
            onFilterChange={onFilterChange}
          />
          <FunnelTile
            label="Won"
            value={metrics.funnel.won}
            sub={`${money(metrics.funnel.wonMrr)} MRR added`}
            filterKey="won"
            activeFilter={activeFilter}
            onFilterChange={onFilterChange}
          />
          <FunnelTile
            label="Lost"
            value={metrics.funnel.lost}
            sub={`${metrics.funnel.declined} declined · ${metrics.funnel.expired} expired`}
            filterKey="lost"
            activeFilter={activeFilter}
            onFilterChange={onFilterChange}
          />
        </div>
      </Card>

      <Card className="mb-5 overflow-hidden">
        <SectionHeader
          title="ROI by service line"
          sub="Offers · accepted · avg ticket — counted per line, so bundled estimates appear under each service they quote"
        />
        <div className="hidden md:grid md:grid-cols-4 gap-3 px-3 py-2 bg-zinc-50 text-10 uppercase tracking-label text-ink-tertiary font-medium">
          <div>Service</div>
          <div className="u-nums">Offers</div>
          <div>Accepted / offers</div>
          <div>Avg ticket</div>
        </div>
        {metrics.serviceRows.length === 0 ? (
          <div className="p-4 text-13 text-ink-secondary">
            No non-draft estimates in this date range.
          </div>
        ) : (
          metrics.serviceRows.map((row) => {
            const Icon = row.icon;
            return (
              <div
                key={row.key}
                className="grid grid-cols-1 md:grid-cols-4 gap-3 px-3 py-3 border-t border-zinc-100 text-12"
              >
                <div className="flex items-center gap-2 text-zinc-900">
                  <Icon
                    size={15}
                    strokeWidth={1.8}
                    aria-hidden
                    title={row.key === "mosquito" ? "Mosquito" : undefined}
                  />
                  <span>{row.label}</span>
                </div>
                <div className="u-nums text-zinc-900">{row.sent}</div>
                <div className="flex items-center gap-2">
                  <div className="w-full h-1 rounded-full bg-zinc-100 overflow-hidden">
                    <div
                      className="h-1 rounded-full bg-zinc-900"
                      style={{ width: `${row.acceptancePct}%` }}
                    />
                  </div>
                  <div className="text-11 text-ink-tertiary u-nums">
                    {row.acceptancePct}% · {row.won}/{row.sent}
                  </div>
                </div>
                <div className="u-nums text-zinc-900">
                  {money(row.avgTicket)}{" "}
                  <span className="text-11 font-normal text-ink-tertiary">
                    {row.ticketSuffix}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="text-11 uppercase tracking-label text-ink-tertiary">
          Needs attention
        </div>
        <div className="text-11 text-ink-tertiary">All-time queue</div>
      </div>
      <div className="grid grid-cols-3 gap-2 mb-5">
        <AttentionCard
          label="Follow-up overdue"
          value={metrics.attention.followUpOverdue}
          sub={`${money(metrics.attention.atRiskMRR)}/mo at risk`}
          filterKey="follow_up_overdue"
          alert={metrics.attention.followUpOverdue > 0}
          onFilterChange={onFilterChange}
        />
        <PricingRiskCard
          value={metrics.attention.pricingRisk}
          missingCogs={metrics.attention.missingCogs}
          lowMargin={metrics.attention.lowMargin}
          warnings={metrics.attention.pricingWarnings}
          onFilterChange={onFilterChange}
        />
        <AttentionCard
          label="Going cold"
          value={metrics.attention.goingCold}
          sub="Viewed · idle 48h–7d"
          filterKey="going_cold"
          onFilterChange={onFilterChange}
        />
      </div>
    </div>
  );
}

PipelineAnalytics.propTypes = {
  estimates: PropTypes.array.isRequired,
  onFilterChange: PropTypes.func.isRequired,
  activeFilter: PropTypes.string,
  dateRange: PropTypes.oneOf(["all", "7d", "30d", "90d", "ytd"]),
  onDateRangeChange: PropTypes.func,
};
