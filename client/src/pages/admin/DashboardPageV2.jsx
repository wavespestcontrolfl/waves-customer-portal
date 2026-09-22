import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ActionFeedback, Card, CardBody, UiSurface } from "../../components/ui";
import useIsMobile from "../../hooks/useIsMobile";
import { useFeatureFlag } from "../../hooks/useFeatureFlag";
import AiChartsPanel from "../../components/dashboard/AiChartsPanel";
import useDashboardData from "./dashboard/useDashboardData";
import { isForbiddenError, isRateLimitError } from "../../utils/admin-fetch";
import DashboardJumpNav from "./dashboard/DashboardJumpNav";
import TodaySection from "./dashboard/sections/TodaySection";
import GrowthSection from "./dashboard/sections/GrowthSection";
import ProfitSection from "./dashboard/sections/ProfitSection";
import RetentionSection from "./dashboard/sections/RetentionSection";
import CashSection from "./dashboard/sections/CashSection";

// The command-center sections, in page order. Each answers one owner question;
// the jump-nav pills scroll to these anchors.
const SECTIONS = [
  { id: "today", label: "Today" },
  { id: "growth", label: "Growth" },
  { id: "profit", label: "Profit" },
  { id: "retention", label: "Retention" },
  { id: "cash", label: "Cash" },
];

const greeting = () => {
  // Eastern hour so the greeting matches the ET header date/clock regardless of
  // the viewer's browser timezone.
  const h =
    parseInt(
      new Date().toLocaleString("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        hour12: false,
      }),
      10,
    ) % 24;
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
};

// Human-friendly "time since last refresh" label for the header control.
function relativeTime(ts) {
  if (ts == null) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 30) return "just now";
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function adminFirstName() {
  try {
    if (typeof localStorage === "undefined") return "there";
    const user = JSON.parse(localStorage.getItem("waves_admin_user") || "null");
    const raw = user?.name || user?.first_name || user?.email || "";
    const first = String(raw).trim().split(/\s+/)[0] || "there";
    return first.includes("@") ? first.split("@")[0] : first;
  } catch {
    return "there";
  }
}

function DashboardAccessState({ forbidden, children }) {
  if (!forbidden) return children;
  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1300px] text-ui-body">
      <Card>
        <CardBody>
          <ActionFeedback error>
            Dashboard access requires an admin account.
          </ActionFeedback>
        </CardBody>
      </Card>
    </UiSurface>
  );
}

export default function DashboardPageV2() {
  const isMobile = useIsMobile();
  const aiChartsEnabled = useFeatureFlag("dashboard-ai-charts");
  const [mobileTab, setMobileTab] = useState(SECTIONS[0].id);
  const [clockTick, setClockTick] = useState(0);
  const [period, setPeriod] = useState("mtd");
  // Custom lookback: a START date through today, driving Core KPIs + attribution
  // when period==='custom'. End is always today, so every metric stays valid.
  const [customRange, setCustomRange] = useState(null); // { from } | null
  // Recomputed as the dashboard's freshness clock ticks, so an overnight session
  // gets the new ET day as the date-input max without a reload.
  const todayISO = useMemo(
    () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
    [clockTick],
  );
  const applyCustomRange = useCallback((from) => {
    setCustomRange({ from });
    setPeriod("custom");
  }, []);
  const selectNamedPeriod = useCallback((id) => {
    setPeriod(id);
    setCustomRange(null);
  }, []);
  const periodQS = period === "custom" && customRange
    ? `period=custom&from=${customRange.from}` : `period=${period}`;
  const { values, errors, pending, lastUpdated, refreshing, refresh } = useDashboardData(
    isMobile ? mobileTab : "all", periodQS,
  );
  const {
    data, kpis, compare, salesCapture, funnel, aging, mrrTrend, cohort, capAlloc,
    callsBySource, leadsBySource, channelMix, leadFunnel, channelRoi, mix,
    revenueByCity, reviewTrend, today, billing, alerts, kpiHistory, ebitda,
    mrrBridge, revenueOverview, churnReasons, staleVisits,
  } = values;
  const kpiTargets = useMemo(() => Object.fromEntries(
    (values.kpiTargets?.targets || []).map((row) => [row.metric, row]),
  ), [values.kpiTargets]);
  const kpisLoading = pending.kpis && !kpis;
  const kpisError = kpis ? null : errors.kpis;
  const attributionKeys = ["callsBySource", "leadsBySource", "channelMix"];
  const attributionReady = attributionKeys.every((key) => values[key]);
  const attributionLoading = !attributionReady && attributionKeys.some((key) => pending[key] && !values[key]);
  const attributionError = attributionReady ? null : attributionKeys.map((key) => errors[key]).find(Boolean);
  const hasErrors = Object.values(errors).some(Boolean);
  const forbidden = Object.values(errors).some(isForbiddenError);
  const rateLimited = Object.values(errors).some(isRateLimitError);
  const retryFeed = rateLimited || refreshing ? undefined : refresh;
  const hasMetricErrors = Object.entries(errors).some(([key, error]) => error && !["alerts", "today", "staleVisits"].includes(key));

  useEffect(() => {
    const tick = setInterval(() => setClockTick((t) => t + 1), 30000);
    return () => clearInterval(tick);
  }, []);
  const navigate = useNavigate();
  // Mobile tab switch: swap the visible section and snap the admin scroll
  // container back to the top so every tab opens at its header.
  const selectMobileTab = useCallback((id) => {
    setMobileTab(id);
    const scroller = document.querySelector(".admin-main");
    if (scroller && typeof scroller.scrollTo === "function") {
      // "instant" opts out of the shell's smooth scroll-behavior — the
      // content swaps at the same moment, so animating would be jarring.
      scroller.scrollTo({ top: 0, behavior: "instant" });
    }
  }, []);
  // On mobile only the active tab's section mounts (five sections of recharts
  // is heavy on a phone); on desktop every section renders for the one-page scroll.
  const sectionVisible = (id) => !isMobile || mobileTab === id;
  // Drill-down: open the Leads list filtered to this attribution source, scoped
  // to the same period window the panel is showing so the list matches the count.
  const drillToSource = useCallback(
    (name) => {
      if (!name) return;
      const p = new URLSearchParams({ source_name: name });
      const w = leadsBySource?.period;
      if (w?.from) p.set("from", w.from);
      if (w?.to) p.set("to", w.to);
      if (w?.label) p.set("period_label", w.label);
      navigate(`/admin/leads?${p.toString()}`);
    },
    [navigate, leadsBySource],
  );
  // Eastern-time everywhere — the business (and every operator) is in ET, so the
  // header date/clock must not drift to the viewer's browser timezone.
  const todayLabel = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
  // Recomputed on each clockTick (30s) re-render so the header clock stays current.
  void clockTick;
  const timeLabel = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
  const firstName = adminFirstName();
  // Sparklines are daily MONTH-TO-DATE snapshots (kpi-snapshot cron) — under
  // any other period the tile's number and the trend would silently disagree
  // on basis, so the series only render while the selector is on MTD.
  const kpiStripProps = {
    kpis,
    kpisLoading,
    kpisError,
    kpiTargets,
    kpiHistory: period === "mtd" ? kpiHistory?.series : null,
  };

  return (
    <DashboardAccessState forbidden={forbidden}>
      <UiSurface density="comfortable" className="dashboard-blackout mx-auto min-h-full max-w-[1300px] text-ui-body text-zinc-900">
      {/* Sticky jump-nav + period selector. The period drives the KPI tiles
          (distributed across sections) and the Marketing Attribution panels;
          everything else keeps its fixed window (labeled per card). */}
      <DashboardJumpNav
        title={`${greeting()}, ${firstName}`}
        dateLabel={`${todayLabel} · ${timeLabel}`}
        updatedLabel={`${hasErrors ? "Some data unavailable · " : ""}Updated ${relativeTime(lastUpdated)}`}
        onRefresh={refresh}
        refreshing={refreshing}
        sections={SECTIONS}
        period={period}
        customRange={customRange}
        todayISO={todayISO}
        periodLabel={kpis?.periodLabel}
        onSelectPeriod={selectNamedPeriod}
        onApplyCustomRange={applyCustomRange}
        activeSection={isMobile ? mobileTab : undefined}
        onSelectSection={isMobile ? selectMobileTab : undefined}
      />

      {rateLimited && <ActionFeedback error className="mb-4">
        Too many requests. Wait a few seconds, then use Refresh.
      </ActionFeedback>}

      {/* Alerts stay the first dashboard content, even with AI charts pinned. */}
      {sectionVisible("today") && (
        <TodaySection alerts={alerts?.alerts ?? null} alertsStale={!!errors.alerts}
          alertsLoading={pending.alerts && !alerts} today={today} staleVisits={staleVisits}
          errors={errors} pending={pending} onRetry={retryFeed} {...kpiStripProps} />
      )}

      {/* AI chart builder — describe a metric, the AI builds + pins it. Gated off
          by default; the model only proposes SQL, the server sandboxes it. */}
      {aiChartsEnabled && sectionVisible("today") && (
        <div className="mb-5">
          <AiChartsPanel />
        </div>
      )}


      {hasMetricErrors && !rateLimited && (
        <ActionFeedback error onRetry={retryFeed} className="mb-4">
          Some dashboard data could not be refreshed. Previously loaded values may be out of date.
        </ActionFeedback>
      )}

      {sectionVisible("growth") && (
        <GrowthSection
          data={data}
          loadError={errors.data}
          pending={pending}
          onRetry={retryFeed}
          compare={compare}
          salesCapture={salesCapture}
          funnel={funnel}
          revenueByCity={revenueByCity}
          capAlloc={capAlloc}
          callsBySource={callsBySource}
          leadsBySource={leadsBySource}
          channelMix={channelMix}
          leadFunnel={leadFunnel}
          channelRoi={channelRoi}
          attributionLoading={attributionLoading}
          attributionError={attributionError}
          leadFunnelLoading={pending.leadFunnel}
          leadFunnelError={errors.leadFunnel}
          channelRoiLoading={pending.channelRoi}
          channelRoiError={errors.channelRoi}
          onDrillSource={drillToSource}
          isMobile={isMobile}
          {...kpiStripProps}
        />
      )}

      {sectionVisible("profit") && (
        <ProfitSection
          pending={pending}
          onRetry={retryFeed}
          mix={mix}
          ebitda={ebitda}
          revenueOverview={revenueOverview}
          isMobile={isMobile}
          {...kpiStripProps}
        />
      )}

      {sectionVisible("retention") && (
        <RetentionSection
          pending={pending}
          onRetry={retryFeed}
          mrrTrend={mrrTrend}
          mrrBridge={mrrBridge}
          churnReasons={churnReasons}
          cohort={cohort}
          reviewTrend={reviewTrend}
          isMobile={isMobile}
          {...kpiStripProps}
        />
      )}

      {sectionVisible("cash") && (
        <CashSection
          pending={pending}
          onRetry={retryFeed}
          aging={aging}
          billing={billing?.summary}
          isMobile={isMobile}
          {...kpiStripProps}
        />
      )}
      </UiSurface>
    </DashboardAccessState>
  );
}
