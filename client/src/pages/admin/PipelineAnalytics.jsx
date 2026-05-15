import React, { useMemo } from "react";
import PropTypes from "prop-types";
import { Bug, Leaf, PawPrint, ShieldCheck, Trees } from "lucide-react";
import { classifyEstimate } from "./EstimatePage";
import { Card, cn } from "../../components/ui";

const ROBOTO = "'Roboto', Arial, sans-serif";
const DAY = 86400000;
const HOUR = 3600000;
const DATE_RANGES = [
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
  return "pest";
}

const SERVICE_META = {
  pest: { label: "Pest control", icon: Bug, ticketSuffix: "/mo recurring" },
  mosquito: { label: "Mosquito", icon: Bug, ticketSuffix: "/mo recurring" },
  lawn: { label: "Lawn care", icon: Leaf, ticketSuffix: "/mo recurring" },
  tree_shrub: { label: "Tree & shrub", icon: Trees, ticketSuffix: "per visit" },
  rodent: { label: "Rodent", icon: PawPrint, ticketSuffix: "/mo recurring" },
  termite: { label: "Termite bait", icon: ShieldCheck, ticketSuffix: "one-time" },
};

export function withinDateRange(iso, range, nowMs = Date.now()) {
  if (!iso) return false;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return false;
  const ms = nowMs - ts;
  if (range === "7d") return ms <= 7 * DAY;
  if (range === "30d") return ms <= 30 * DAY;
  if (range === "90d") return ms <= 90 * DAY;
  if (range === "ytd") return new Date(ts).getFullYear() === new Date(nowMs).getFullYear();
  return true;
}

// Aggregate sent/won/avg-ticket per service line. Sent = any non-draft estimate
// in the window. Won = status === 'accepted'.
export function aggregateServiceLineRows(estimates) {
  const buckets = new Map();
  for (const e of estimates) {
    if (e.status === "draft") continue;
    const line = classifyEstimateServiceLine(e);
    if (!buckets.has(line))
      buckets.set(line, { sent: 0, won: 0, ticketSum: 0, ticketCount: 0 });
    const b = buckets.get(line);
    const monthlyTotal = Number(e.monthlyTotal || 0);
    b.sent += 1;
    if (e.status === "accepted") b.won += 1;
    if (monthlyTotal > 0) {
      b.ticketSum += monthlyTotal;
      b.ticketCount += 1;
    }
  }
  return Array.from(buckets.entries())
    .map(([key, b]) => ({
      key,
      ...SERVICE_META[key],
      sent: b.sent,
      won: b.won,
      acceptancePct: b.sent > 0 ? Math.round((b.won / b.sent) * 100) : 0,
      avgTicket: b.ticketCount > 0 ? Math.round(b.ticketSum / b.ticketCount) : 0,
    }))
    .sort((a, b) => b.sent - a.sent);
}

function money(value) {
  return `$${Math.round(Number(value || 0)).toLocaleString()}`;
}

function amount(e) {
  return Number(e?.monthlyTotal || 0);
}

function avgTicketFor(estimates) {
  if (estimates.length === 0) return 0;
  return Math.round(estimates.reduce((sum, e) => sum + amount(e), 0) / estimates.length);
}

function prior30Estimates(estimates, nowMs) {
  return estimates.filter((e) => {
    if (!e.createdAt) return false;
    const ts = new Date(e.createdAt).getTime();
    if (Number.isNaN(ts)) return false;
    const age = nowMs - ts;
    return age > 30 * DAY && age <= 60 * DAY;
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

export default function PipelineAnalytics({
  estimates,
  onFilterChange,
  activeFilter,
  dateRange = "30d",
  onDateRangeChange,
}) {
  const selectedRange = dateRange || "30d";
  const metrics = useMemo(() => {
    const nowMs = Date.now();
    const inRange = estimates.filter((e) =>
      withinDateRange(e.createdAt, selectedRange, nowMs),
    );
    const classified = inRange.map((e) => ({
      ...e,
      _class: e._class || classifyEstimate(e),
    }));

    const total = inRange.length;
    const accepted = inRange.filter((e) => e.status === "accepted").length;
    const sent = inRange.filter((e) => ["sent", "viewed"].includes(e.status)).length;
    const declined = inRange.filter(
      (e) => e.status === "declined" || e.status === "expired",
    ).length;
    const conversionDenominator = sent + accepted + declined;
    const totalMRRWon = inRange
      .filter((e) => e.status === "accepted")
      .reduce((sum, e) => sum + amount(e), 0);
    const pipelineEstimates = inRange.filter(
      (e) => !["accepted", "declined", "expired"].includes(e.status),
    );
    const pipelineValue = pipelineEstimates.reduce((sum, e) => sum + amount(e), 0);
    const avgTicket = avgTicketFor(inRange);
    const priorAvg = avgTicketFor(prior30Estimates(estimates, nowMs));
    const avgDelta = Math.round(avgTicket - priorAvg);
    const avgTrend =
      priorAvg === 0
        ? "→ vs prior 30d"
        : `${avgDelta > 0 ? "↑" : avgDelta < 0 ? "↓" : "→"} ${money(Math.abs(avgDelta))} vs prior 30d`;

    const needsEstimate = classified.filter((e) => e._class === "needs_estimate").length;
    const readyToSend = classified.filter((e) => e._class === "ready_to_send").length;
    const awaiting = classified.filter((e) => e._class === "awaiting").length;
    const followUp = classified.filter((e) => e._class === "follow_up").length;
    const scheduled = classified.filter((e) => e._class === "scheduled").length;
    const won = classified.filter((e) => e._class === "won");
    const lost = classified.filter((e) => e._class === "lost");
    const wonMrr = won.reduce((sum, e) => sum + amount(e), 0);
    const declinedCount = inRange.filter((e) => e.status === "declined").length;
    const expiredCount = inRange.filter((e) => e.status === "expired").length;

    const followUpOverdue = inRange.filter((e) => {
      if (
        e.status === "sent" &&
        !e.viewedAt &&
        e.sentAt &&
        nowMs - new Date(e.sentAt).getTime() > 72 * HOUR
      )
        return true;
      if (
        e.status === "viewed" &&
        e.viewedAt &&
        nowMs - new Date(e.viewedAt).getTime() > 48 * HOUR
      )
        return true;
      return false;
    });
    const atRiskMRR = followUpOverdue.reduce((sum, e) => sum + amount(e), 0);
    const pricingRisk = inRange.filter((e) => e.pricingRisk?.hasRisk);
    const missingCogs = inRange.filter(
      (e) => (e.pricingRisk?.missingCogsCount || 0) > 0,
    ).length;
    const lowMargin = inRange.filter(
      (e) => (e.pricingRisk?.lowMarginCount || 0) > 0,
    ).length;
    const goingCold = inRange.filter((e) => {
      if (e.status !== "viewed" || !e.viewedAt) return false;
      const age = nowMs - new Date(e.viewedAt).getTime();
      return age > 48 * HOUR && age < 168 * HOUR;
    }).length;

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
        wonAccounts: accepted,
      },
      funnel: {
        drafts: needsEstimate + readyToSend,
        needsEstimate,
        readyToSend,
        sent: awaiting + followUp + scheduled,
        awaiting,
        viewed: followUp,
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
        goingCold,
      },
      total,
    };
  }, [estimates, selectedRange]);

  return (
    <div style={{ fontFamily: ROBOTO }}>
      <div className="flex gap-2 mb-5 flex-wrap">
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
          label="Acceptance rate"
          value={`${metrics.kpis.acceptanceRate}%`}
          sub={`${metrics.kpis.accepted} won of ${metrics.kpis.closed} closed`}
        />
        <StatCard
          label="MRR won"
          value={money(metrics.kpis.totalMRRWon)}
          sub={`${metrics.kpis.wonAccounts} new accounts`}
        />
      </div>

      <Card className="mb-5 overflow-hidden">
        <SectionHeader title="Funnel" />
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
            sub={`${metrics.funnel.awaiting} awaiting · ${metrics.funnel.viewed} viewed`}
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
        <SectionHeader title="ROI by service line" sub="Sent · accepted · avg ticket" />
        <div className="hidden md:grid md:grid-cols-4 gap-3 px-3 py-2 bg-zinc-50 text-10 uppercase tracking-label text-ink-tertiary font-medium">
          <div>Service</div>
          <div className="u-nums">Sent</div>
          <div>Acceptance bar</div>
          <div>Avg ticket</div>
        </div>
        {metrics.serviceRows.length === 0 ? (
          <div className="p-4 text-13 text-ink-secondary">
            No sent estimates in this date range.
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

      <div className="grid grid-cols-3 gap-2 mb-5">
        <AttentionCard
          label="Follow-up overdue"
          value={metrics.attention.followUpOverdue}
          sub={`${money(metrics.attention.atRiskMRR)}/mo at risk`}
          filterKey="follow_up"
          alert={metrics.attention.followUpOverdue > 0}
          onFilterChange={onFilterChange}
        />
        <AttentionCard
          label="Pricing risk"
          value={metrics.attention.pricingRisk}
          sub={`${metrics.attention.missingCogs} missing COGS · ${metrics.attention.lowMargin} low margin`}
          filterKey="pricing_risk"
          onFilterChange={onFilterChange}
        />
        <AttentionCard
          label="Going cold"
          value={metrics.attention.goingCold}
          sub="Viewed over 48h"
          filterKey="follow_up"
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
  dateRange: PropTypes.oneOf(["7d", "30d", "90d", "ytd"]),
  onDateRangeChange: PropTypes.func,
};
