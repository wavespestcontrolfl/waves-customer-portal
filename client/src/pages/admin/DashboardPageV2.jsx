import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  cn,
} from "../../components/ui";
import {
  AgingBar,
  AttributionScorecard,
  CaptureGauge,
  CHART_SUCCESS,
  ChartCard,
  CompletionGauge,
  EmptyState,
  EstimateFunnel,
  KpiBullet,
  KpiDivergingBar,
  KpiRing,
  KpiSparklineTile,
  MrrTrendChart,
  RetentionCohortGrid,
  ReviewTrendChart,
  RevenueByCity,
  RevenueTrendArea,
  ServiceMixDonut,
  TechLeaderboardBars,
  fmtInt,
  fmtMoney,
  fmtMoneyCompact,
} from "../../components/dashboard/charts";
import useIsMobile from "../../hooks/useIsMobile";
import { useFeatureFlag } from "../../hooks/useFeatureFlag";
import AiChartsPanel from "../../components/dashboard/AiChartsPanel";
import {
  adminFetch,
  isForbiddenError,
  isRateLimitError,
} from "../../utils/admin-fetch";

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

// Build a daily-revenue sparkline series from the array of { date, total }
// returned by /admin/dashboard. Pad to at least 2 points so the sparkline
// renders even on day 1 of the month.
function sparkSeries(daily) {
  if (!Array.isArray(daily) || daily.length === 0) return [];
  if (daily.length === 1) return [0, daily[0].total];
  return daily.map((d) => Number(d.total) || 0);
}

export default function DashboardPageV2() {
  const isMobile = useIsMobile();
  const aiChartsEnabled = useFeatureFlag("dashboard-ai-charts");
  const [data, setData] = useState(null); // /admin/dashboard
  const [kpis, setKpis] = useState(null); // /admin/dashboard/core-kpis
  const [compare, setCompare] = useState(null); // /admin/dashboard/compare
  const [salesCapture, setSalesCapture] = useState(null); // /admin/dashboard/sales-capture
  const [funnel, setFunnel] = useState(null);
  const [aging, setAging] = useState(null);
  const [mrrTrend, setMrrTrend] = useState(null);
  const [cohort, setCohort] = useState(null);
  // /lead-source (downstream string aggregation) is intentionally dropped
  // in favor of the upstream attribution endpoints below.
  const [callsBySource, setCallsBySource] = useState(null);
  const [leadsBySource, setLeadsBySource] = useState(null);
  const [channelMix, setChannelMix] = useState(null);
  const [mix, setMix] = useState(null);
  const [revenueByCity, setRevenueByCity] = useState(null);
  const [reviewTrend, setReviewTrend] = useState(null);
  const [today, setToday] = useState(null);
  const [billing, setBilling] = useState(null);
  const [alerts, setAlerts] = useState([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [clockTick, setClockTick] = useState(0);
  // Bumped on every auto/manual refresh so the period-based effects (Core KPIs +
  // attribution) re-fetch too — otherwise "Updated Nm ago" would imply a
  // freshness those panels don't have. The period refs let those effects blank
  // ONLY on a real period switch, not on a silent refresh.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const mountedRef = useRef(true);
  const kpisPeriodRef = useRef(null);
  const attribPeriodRef = useRef(null);
  // Serializes refreshes: while a loadAll() is in flight, the 3-min timer and
  // the manual button skip starting another, so overlapping responses can't
  // race to write shared state and then stamp a newer "Updated" time.
  const inFlightRef = useRef(false);
  const nonceRef = useRef(0);
  // Freshness gate. A refresh "generation" has up to 3 participants — loadAll
  // plus the two period effects (Core KPIs + attribution) when they re-run for
  // a refresh (not a period switch). "Updated just now" advances only once every
  // participant of the current generation reports success, so a transient
  // failure in ANY panel (not just the loadAll ones) keeps the stamp honest.
  const freshGateRef = useRef({ gen: 0, pending: 0, failed: false });
  const settleGate = useCallback((gen, ok) => {
    const g = freshGateRef.current;
    if (g.gen !== gen) return; // superseded by a newer refresh — ignore
    if (!ok) g.failed = true;
    g.pending -= 1;
    if (g.pending <= 0 && !g.failed && mountedRef.current) setLastUpdated(Date.now());
  }, []);
  const [period, setPeriod] = useState("mtd");
  // Custom date range (drives both Core KPIs + attribution when period==='custom').
  const [customRange, setCustomRange] = useState(null); // { from, to } | null
  const [showRangePicker, setShowRangePicker] = useState(false);
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const todayISO = useMemo(
    () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
    [],
  );
  const applyCustomRange = () => {
    if (!draftFrom || !draftTo) return;
    const [a, b] = draftFrom <= draftTo ? [draftFrom, draftTo] : [draftTo, draftFrom];
    setCustomRange({ from: a, to: b });
    setPeriod("custom");
    setShowRangePicker(false);
  };
  const selectNamedPeriod = (id) => {
    setPeriod(id);
    setCustomRange(null);
    setShowRangePicker(false);
  };
  const navigate = useNavigate();
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
  const [showAllKpis, setShowAllKpis] = useState(false);
  const [kpisLoading, setKpisLoading] = useState(false);
  const [kpisError, setKpisError] = useState(null);
  const [attributionLoading, setAttributionLoading] = useState(false);
  const [attributionError, setAttributionError] = useState(null);

  // Run the 11 fan-out fetches in two staggered waves so a fresh mount
  // doesn't burst-trigger the per-user rate limiter (the original code
  // fired all 11 simultaneously). The hero KPIs land first, then the
  // attribution panels backfill. Re-callable on an interval / manual refresh:
  // every setState is guarded by mountedRef and loading is NEVER re-raised, so
  // an auto/manual refresh swaps data in place without blanking the page.
  const loadAll = useCallback(async () => {
    inFlightRef.current = true;
    // Capture the generation this run belongs to (set up by the caller before
    // loadAll is invoked) so a late settle can't credit a newer refresh.
    const gen = freshGateRef.current.gen;
    let anyFailed = false;
    function track(label, p) {
      return p.catch((e) => {
        console.error(`[dashboard-v2] ${label}`, e);
        anyFailed = true;
        if (mountedRef.current) setLoadError((prev) => prev || e);
        return null;
      });
    }
    const wave1 = await Promise.all([
      track("/dashboard", adminFetch("/admin/dashboard")),
      track(
        "/compare",
        adminFetch(
          "/admin/dashboard/compare?period=this_month&against=last_month",
        ),
      ),
      track("/sales-capture", adminFetch("/admin/dashboard/sales-capture")),
      track(
        "/today-completion",
        adminFetch("/admin/dashboard/today-completion"),
      ),
      track("/billing-health", adminFetch("/admin/billing-health")),
      track("/alerts", adminFetch("/admin/dashboard/alerts")),
    ]);
    const [d, cmp, sc, td, bh, al] = wave1;
    if (!mountedRef.current) { inFlightRef.current = false; return; }
    // Preserve prior values when a refresh fetch transiently fails (track →
    // null), so an auto/manual refresh never blanks a panel that was populated.
    // On the first load prev is null, so the loading/error path is unchanged.
    setData((prev) => d ?? prev);
    setCompare((prev) => cmp ?? prev);
    setSalesCapture((prev) => sc ?? prev);
    setToday((prev) => td ?? prev);
    setBilling((prev) => bh?.summary ?? prev);
    setAlerts((prev) => (Array.isArray(al?.alerts) ? al.alerts : prev));
    setLoading(false);

    const wave2 = await Promise.all([
      track("/funnel", adminFetch("/admin/dashboard/funnel")),
      track("/aging", adminFetch("/admin/dashboard/aging")),
      track("/mrr-trend", adminFetch("/admin/dashboard/mrr-trend?months=12")),
      track("/service-mix", adminFetch("/admin/dashboard/service-mix")),
      track("/revenue-by-city", adminFetch("/admin/dashboard/revenue-by-city")),
      track("/review-trend", adminFetch("/admin/dashboard/review-trend")),
      track("/retention-cohort", adminFetch("/admin/dashboard/retention-cohort?months=12")),
    ]);
    if (!mountedRef.current) { inFlightRef.current = false; return; }
    const [fnl, ag, mrr, mx, rbc, rev, coh] = wave2;
    setFunnel((prev) => fnl ?? prev);
    setAging((prev) => ag ?? prev);
    setMrrTrend((prev) => mrr ?? prev);
    setMix((prev) => mx ?? prev);
    setRevenueByCity((prev) => rbc ?? prev);
    setReviewTrend((prev) => rev ?? prev);
    setCohort((prev) => coh ?? prev);
    inFlightRef.current = false;
    // Report this generation's outcome to the freshness gate. "Updated just
    // now" only advances once loadAll AND the period effects (Core KPIs +
    // attribution) of the same generation have all reported success — see
    // settleGate — so a transient failure in any panel never claims freshness.
    settleGate(gen, !anyFailed);
  }, [settleGate]);

  // Start a refresh generation: bump the nonce (re-running the period effects),
  // arm the freshness gate for all 3 participants, then run loadAll. Skipped
  // while a refresh is already in flight so generations never overlap.
  const triggerRefresh = useCallback(() => {
    if (inFlightRef.current) return Promise.resolve();
    const gen = nonceRef.current + 1;
    nonceRef.current = gen;
    freshGateRef.current = { gen, pending: 3, failed: false };
    setRefreshNonce(gen);
    return loadAll();
  }, [loadAll]);

  useEffect(() => {
    mountedRef.current = true;
    // Initial load: only loadAll participates in the gate (the period effects
    // run with periodChanged=true and surface their own error state instead).
    freshGateRef.current = { gen: 0, pending: 1, failed: false };
    loadAll();
    // Auto-refresh every 3 min in place; a faster clock tick keeps the
    // "Updated Nm ago" label fresh without re-fetching. Skip the tick if a
    // refresh is still running so we never stack overlapping loads.
    const auto = setInterval(() => {
      if (!inFlightRef.current) triggerRefresh();
    }, 180000);
    const tick = setInterval(() => setClockTick((t) => t + 1), 30000);
    return () => {
      mountedRef.current = false;
      clearInterval(auto);
      clearInterval(tick);
    };
  }, [loadAll, triggerRefresh]);

  const refresh = async () => {
    if (refreshing || inFlightRef.current) return;
    setRefreshing(true);
    try {
      await triggerRefresh();
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  };

  useEffect(() => {
    const ctrl = new AbortController();
    // Blank + show the loading state only on a real period switch. A silent
    // auto/manual refresh (refreshNonce bump) keeps the current KPIs on screen,
    // swaps them in place, and won't surface an error over still-good data.
    const periodKey =
      period === "custom" && customRange
        ? `custom:${customRange.from}:${customRange.to}`
        : period;
    const periodQS =
      period === "custom" && customRange
        ? `period=custom&from=${customRange.from}&to=${customRange.to}`
        : `period=${period}`;
    const periodChanged = kpisPeriodRef.current !== periodKey;
    kpisPeriodRef.current = periodKey;
    // A refresh-driven run (periodChanged=false) is a participant in the
    // freshness gate for this generation; a period switch is not.
    const gateGen = refreshNonce;
    let ok = true;
    if (periodChanged) {
      setKpis(null);
      setKpisError(null);
      setKpisLoading(true);
    }
    adminFetch(`/admin/dashboard/core-kpis?${periodQS}`, {
      signal: ctrl.signal,
    })
      .then((d) => {
        setKpis(d);
        setKpisError(null);
      })
      .catch((e) => {
        if (e?.name === "AbortError") return;
        ok = false;
        console.error("[dashboard-v2] /core-kpis", e);
        if (periodChanged) setKpisError(e);
      })
      .finally(() => {
        if (ctrl.signal.aborted) return;
        setKpisLoading(false);
        if (!periodChanged) settleGate(gateGen, ok);
      });
    return () => ctrl.abort();
  }, [period, customRange, refreshNonce, settleGate]);

  useEffect(() => {
    const ctrl = new AbortController();
    const periodKey =
      period === "custom" && customRange
        ? `custom:${customRange.from}:${customRange.to}`
        : period;
    const periodQS =
      period === "custom" && customRange
        ? `period=custom&from=${customRange.from}&to=${customRange.to}`
        : `period=${period}`;
    const periodChanged = attribPeriodRef.current !== periodKey;
    attribPeriodRef.current = periodKey;
    const gateGen = refreshNonce;
    let ok = true;
    if (periodChanged) {
      setCallsBySource(null);
      setLeadsBySource(null);
      setChannelMix(null);
      setAttributionError(null);
      setAttributionLoading(true);
    }

    Promise.all([
      adminFetch(`/admin/dashboard/calls-by-source?${periodQS}`, {
        signal: ctrl.signal,
      }),
      adminFetch(`/admin/dashboard/leads-by-source?${periodQS}`, {
        signal: ctrl.signal,
      }),
      adminFetch(`/admin/dashboard/channel-mix?${periodQS}`, {
        signal: ctrl.signal,
      }),
    ])
      .then(([calls, leads, channels]) => {
        setCallsBySource(calls);
        setLeadsBySource(leads);
        setChannelMix(channels);
        setAttributionError(null);
      })
      .catch((e) => {
        if (e?.name === "AbortError") return;
        ok = false;
        console.error("[dashboard-v2] attribution", e);
        if (periodChanged) setAttributionError(e);
      })
      .finally(() => {
        if (ctrl.signal.aborted) return;
        setAttributionLoading(false);
        if (!periodChanged) settleGate(gateGen, ok);
      });
    return () => ctrl.abort();
  }, [period, customRange, refreshNonce, settleGate]);

  if (loading) {
    return (
      <div className="p-16 text-center text-14 sm:text-13 text-ink-secondary">
        Loading dashboard…
      </div>
    );
  }
  if (!data || data.error || !data.kpis) {
    // 429 from the global limiter used to render as "Try logging in again",
    // sending operators in circles. Show the real cause + a Retry button.
    if (isRateLimitError(loadError)) {
      return (
        <div className="p-16 text-center text-14 sm:text-13 text-alert-fg">
          Too many requests. Wait a few seconds and{" "}
          <button
            onClick={() => window.location.reload()}
            className="underline"
          >
            retry
          </button>
          .
        </div>
      );
    }
    if (isForbiddenError(loadError)) {
      return (
        <div className="p-16 text-center text-14 sm:text-13 text-alert-fg">
          Dashboard access requires an admin account.
        </div>
      );
    }
    return (
      <div className="p-16 text-center text-14 sm:text-13 text-alert-fg">
        Failed to load dashboard.{" "}
        <button onClick={() => window.location.reload()} className="underline">
          Retry
        </button>
        .
      </div>
    );
  }

  const k = data.kpis;
  const dailySpark = sparkSeries(data.revenueChart?.daily);
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
  const mrrTrendSub =
    mrrTrend?.avg_growth_pct != null
      ? `${mrrTrend.avg_growth_pct >= 0 ? "↑" : "↓"} ${Math.abs(mrrTrend.avg_growth_pct)}% avg monthly growth`
      : "last 12 months";

  // Hero KPI tiles. Google Rating tile intentionally removed. Review Index
  // uses /rate/:token submissions and is not a standard NPS calculation.
  const HERO = [
    {
      label: "Revenue MTD",
      value: fmtMoney(k.revenueMTD),
      delta: compare?.deltas?.revenue ?? k.revenueChangePercent,
      deltaSuffix: "% vs same days last month",
      series: dailySpark,
    },
    {
      label: "Active Customers",
      value: fmtInt(k.activeCustomers),
      sub: `+${fmtInt(k.newCustomersThisMonth)} new MTD`,
    },
    {
      label: "MRR",
      value: fmtMoney(data.mrr),
      // Headline MRR counts every recurring account, but paused-autopay and
      // overdue accounts aren't actually going to bill. When any MRR is at
      // risk, surface the committed-vs-at-risk split instead of ARR so the
      // headline doesn't silently overstate the run-rate.
      sub:
        data.mrrBreakdown?.atRisk > 0
          ? `${fmtMoneyCompact(data.mrrBreakdown.committed)} committed · ${fmtMoneyCompact(data.mrrBreakdown.atRisk)} at risk`
          : `ARR ${fmtMoneyCompact(data.mrr * 12)}`,
    },
    {
      label: "Review Index",
      value: kpis?.quality?.nps != null ? String(kpis.quality.nps) : "—",
      sub: kpis?.quality?.csatResponses
        ? `${kpis.quality.csatResponses} responses · ${kpis.quality.csatAvg}/10 avg`
        : "awaiting rate-page submissions",
      alert: kpis?.quality?.nps != null && kpis.quality.nps < 30,
    },
  ];
  const sales = kpis?.sales || {};
  const salesUnavailable = !!sales.error;

  return (
    <div className="dashboard-blackout font-sans bg-surface-page min-h-full p-3 sm:p-6 pb-[calc(6rem+env(safe-area-inset-bottom))] md:pb-6 text-zinc-900">
      {" "}
      <header className="mb-5 max-md:mb-6">
        {" "}
        <div className="flex items-start justify-between flex-wrap gap-3">
          {" "}
          <div>
            {" "}
            <div className="u-label text-ink-secondary max-md:text-13 max-md:tracking-normal max-md:normal-case max-md:font-medium max-md:text-zinc-500">
              {todayLabel} · {timeLabel}
            </div>{" "}
            <h1 className="text-28 font-normal tracking-h1 mt-1 max-md:mt-2">
              {" "}
              <span
                className="md:hidden"
                style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.1 }}
              >
                {greeting()}, {firstName}
              </span>{" "}
              <span className="hidden md:inline">
                {greeting()}, {firstName}
              </span>{" "}
            </h1>{" "}
          </div>{" "}
          <div className="text-12 text-ink-tertiary flex items-center gap-1.5">
            {/* clockTick keeps this label fresh between auto-refreshes */}
            <span>Updated {relativeTime(lastUpdated, clockTick)}</span>{" "}
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              aria-label="Refresh dashboard"
              className="hover:text-ink-secondary u-focus-ring"
            >
              <span className={`inline-block ${refreshing ? "animate-spin" : ""}`}>
                ↻
              </span>
            </button>
          </div>{" "}
        </div>{" "}
      </header>
      {alerts.length > 0 && <DashboardAlertsBanner alerts={alerts} />}
      {/* Row 1: Sales Capture gauge + Revenue trend — capture rate next to the
          revenue it drives. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4 md:mb-5">
        {salesCapture && (
          <ChartCard
            title="Sales Capture"
            sub={`${fmtMoney(salesCapture.captured)} captured of ${fmtMoney(
              (salesCapture.captured || 0) + (salesCapture.missed || 0),
            )} estimated · MTD`}
          >
            <CaptureGauge
              captureRate={salesCapture.captureRate}
              captured={salesCapture.captured}
              missed={salesCapture.missed}
              wonCount={salesCapture.wonCount}
              lostCount={salesCapture.lostCount}
            />
          </ChartCard>
        )}
        <ChartCard
          title={`Revenue — ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "America/New_York" })}`}
          sub={
            compare?.deltas?.revenue != null
              ? `${compare.deltas.revenue >= 0 ? "↑" : "↓"} ${Math.abs(compare.deltas.revenue)}% vs ${compare.against?.label?.toLowerCase() || "prior period"}`
              : "vs same days last month"
          }
          action={
            <span className="text-12 text-ink-secondary">
              MRR{" "}
              <span className="u-nums font-medium text-zinc-900 ml-1">
                {fmtMoney(data.mrr)}
              </span>{" "}
            </span>
          }
        >
          <RevenueTrendArea
            current={compare?.period?.series || data.revenueChart?.daily || []}
            prior={compare?.against?.series || []}
          />
        </ChartCard>
      </div>
      {/* Row 2: Hero KPI row — sparkline + delta */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 mb-4 md:mb-5">
        {HERO.map((h) => (
          <KpiSparklineTile key={h.label} {...h} />
        ))}
      </div>
      {/* Row 3: Reviews trend (2/3) + Today completion gauge (1/3) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
        {" "}
        <div className="md:col-span-2">
          {" "}
          <ChartCard
            title="Reviews"
            sub={`${reviewTrend?.total ?? 0} reviews · ${reviewTrend?.avgRating ?? "—"}★ avg`}
            action={
              kpis?.quality?.nps != null ? (
                <span className="text-12 text-ink-secondary">
                  Index{" "}
                  <span className="u-nums font-medium text-zinc-900 ml-1">
                    {kpis.quality.nps}
                  </span>
                </span>
              ) : null
            }
          >
            {" "}
            <ReviewTrendChart trend={reviewTrend?.trend || []} />{" "}
          </ChartCard>{" "}
        </div>{" "}
        <ChartCard
          title="Today's Completion"
          sub={
            today?.date
              ? new Date(today.date + "T12:00").toLocaleDateString("en-US", {
                  weekday: "long",
                })
              : ""
          }
        >
          {today ? (
            <CompletionGauge
              completed={today.completed}
              total={today.total}
              remaining={today.remaining}
              cancelled={today.cancelled}
              noShow={today.noShow}
            />
          ) : (
            <EmptyState>Loading…</EmptyState>
          )}
        </ChartCard>{" "}
      </div>
      {/* Row: Service mix donut + Estimate funnel */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
        {" "}
        <ChartCard
          title="Service Mix"
          sub={`${mix?.total_services || 0} completed services this month`}
        >
          {" "}
          <ServiceMixDonut mix={mix?.mix || []} />{" "}
        </ChartCard>{" "}
        <ChartCard
          title="Estimate Funnel"
          sub={
            funnel?.period ? `${funnel.period.from} → ${funnel.period.to}` : ""
          }
        >
          {" "}
          <EstimateFunnel
            funnel={funnel?.funnel || {}}
            rates={funnel?.rates || {}}
            totalAcceptedValue={funnel?.total_accepted_value}
          />{" "}
        </ChartCard>{" "}
      </div>
      {/* Revenue by city — ServiceTitan-style geo cut of MTD completed revenue */}
      {revenueByCity && (
        <div className="mb-5">
          {" "}
          <ChartCard
            title="Revenue by City"
            sub={`${fmtMoney(revenueByCity.total || 0)} · MTD`}
          >
            {" "}
            <RevenueByCity
              cities={revenueByCity.cities || []}
              total={revenueByCity.total || 0}
            />{" "}
          </ChartCard>{" "}
        </div>
      )}
      {/* AR aging — full width, the 90+ bucket is the only place alert-fg */}
      <div className="mb-5">
        {" "}
        <ChartCard
          title="Accounts Receivable Aging"
          sub={
            aging?.invoice_count != null
              ? `${aging.invoice_count} open invoices`
              : ""
          }
        >
          {" "}
          <AgingBar
            aging={aging?.aging || {}}
            totalOutstanding={aging?.total_outstanding}
            totalOverdue={aging?.total_overdue}
          />{" "}
        </ChartCard>{" "}
      </div>
      {/* Core operational KPIs (period switcher) */}
      <Card className="mb-5 max-md:border-0 max-md:shadow-sm max-md:rounded-xl">
        {" "}
        <CardHeader className="flex items-center justify-between gap-3 flex-wrap">
          {" "}
          <div>
            {" "}
            <CardTitle>Core KPIs</CardTitle>{" "}
            <div className="text-12 text-ink-secondary mt-1">
              {kpis?.periodLabel || "Month to Date"}
            </div>{" "}
          </div>{" "}
          <div className="relative flex items-center gap-2">
            <div className="max-w-full overflow-x-auto">
              <div className="inline-flex items-center border-hairline border-zinc-200 rounded-sm overflow-hidden">
                {PERIODS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => selectNamedPeriod(p.id)}
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
                    setDraftTo(customRange?.to || "");
                    setShowRangePicker((v) => !v);
                  }}
                  className={cn(
                    "h-11 sm:h-7 px-3 text-11 uppercase tracking-label font-medium u-focus-ring transition-colors shrink-0 border-l border-hairline border-zinc-200",
                    period === "custom"
                      ? "bg-zinc-900 text-white"
                      : "bg-white text-ink-secondary hover:bg-zinc-50",
                  )}
                  title="Custom date range"
                >
                  {period === "custom" && customRange ? `${customRange.from} – ${customRange.to}` : "Custom"}
                </button>
              </div>
            </div>
            {showRangePicker && (
              <div className="absolute right-0 top-full mt-1 z-20 bg-white border-hairline border-zinc-200 rounded-sm shadow-lg p-3 flex flex-col gap-2">
                <label className="text-11 text-ink-tertiary flex items-center justify-between gap-3">
                  From
                  <input type="date" max={todayISO} value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)}
                    className="text-12 border-hairline border-zinc-300 rounded-sm px-2 py-1 u-focus-ring" />
                </label>
                <label className="text-11 text-ink-tertiary flex items-center justify-between gap-3">
                  To
                  <input type="date" max={todayISO} value={draftTo} onChange={(e) => setDraftTo(e.target.value)}
                    className="text-12 border-hairline border-zinc-300 rounded-sm px-2 py-1 u-focus-ring" />
                </label>
                <div className="flex justify-end gap-2 mt-1">
                  <button onClick={() => setShowRangePicker(false)} className="text-11 text-ink-tertiary hover:text-ink-secondary u-focus-ring">Cancel</button>
                  <button onClick={applyCustomRange} disabled={!draftFrom || !draftTo}
                    className="text-11 font-medium px-3 py-1 rounded-sm bg-zinc-900 text-white disabled:opacity-40 u-focus-ring">Apply</button>
                </div>
              </div>
            )}
          </div>{" "}
        </CardHeader>{" "}
        <CardBody>
          {kpisLoading ? (
            <EmptyState>Loading KPIs…</EmptyState>
          ) : kpisError ? (
            <EmptyState>Failed to load KPIs for this period</EmptyState>
          ) : !kpis ? (
            <EmptyState>No KPI data for this period</EmptyState>
          ) : (
            <>
              {" "}
              <KpiGrid>
                {" "}
                {kpis.momentum && (
                  <>
                    {" "}
                    <KpiTile
                      label="Net MRR"
                      value={signed(kpis.momentum.mrr?.net, fmtMoney)}
                      sub={`+${fmtMoneyCompact(kpis.momentum.mrr?.new ?? 0)} new · ${fmtMoneyCompact(kpis.momentum.mrr?.churned ?? 0)} lost`}
                      alert={kpis.momentum.mrr?.net < 0}
                      chart={{
                        kind: "diverging",
                        positive: kpis.momentum.mrr?.new ?? 0,
                        negative: kpis.momentum.mrr?.churned ?? 0,
                      }}
                    />{" "}
                    <KpiTile
                      label="Net Customers"
                      value={signed(kpis.momentum.customers?.net, fmtInt)}
                      sub={`+${fmtInt(kpis.momentum.customers?.new ?? 0)} new · ${fmtInt(kpis.momentum.customers?.lost ?? 0)} lost`}
                      alert={kpis.momentum.customers?.net < 0}
                      chart={{
                        kind: "diverging",
                        positive: kpis.momentum.customers?.new ?? 0,
                        negative: kpis.momentum.customers?.lost ?? 0,
                      }}
                    />{" "}
                  </>
                )}{" "}
                <KpiTile
                  label="Lead → Booked"
                  value={
                    !salesUnavailable && sales.conversion != null
                      ? `${sales.conversion}%`
                      : "—"
                  }
                  sub={
                    salesUnavailable
                      ? "lead metrics unavailable"
                      : `${sales.booked ?? 0}/${sales.leads ?? 0} leads`
                  }
                  alert={
                    salesUnavailable ||
                    (sales.conversion != null && sales.conversion < 20)
                  }
                  chart={{ kind: "gauge", value: sales.conversion, max: 100, target: 20 }}
                />{" "}
                <KpiTile
                  label="Response Speed"
                  value={
                    !salesUnavailable && sales.avgResponseMin != null
                      ? `${sales.avgResponseMin}m`
                      : "—"
                  }
                  sub={
                    salesUnavailable
                      ? "lead metrics unavailable"
                      : "lead → first contact"
                  }
                  alert={
                    salesUnavailable ||
                    (sales.avgResponseMin != null && sales.avgResponseMin > 60)
                  }
                  chart={{ kind: "bullet", value: sales.avgResponseMin, target: 60, lowerIsBetter: true }}
                />{" "}
                <KpiTile
                  label="Service Completion"
                  value={pct(kpis.service.completionRate)}
                  sub={`${kpis.service.completed}/${kpis.service.scheduled} jobs`}
                  alert={
                    kpis.service.completionRate != null &&
                    kpis.service.completionRate < 85
                  }
                  chart={{ kind: "gauge", value: kpis.service.completionRate, max: 100, target: 85 }}
                />{" "}
                <KpiTile
                  label="Collection Rate"
                  value={
                    kpis.billing?.collectionRate != null
                      ? `${kpis.billing.collectionRate}%`
                      : "—"
                  }
                  sub={
                    kpis.billing?.issuedCount
                      ? `${fmtMoneyCompact(kpis.billing.collected)} / ${fmtMoneyCompact(kpis.billing.billed)} · ${kpis.billing.collectedCount}/${kpis.billing.issuedCount} paid`
                      : "no invoices issued"
                  }
                  alert={
                    kpis.billing?.collectionRate != null &&
                    kpis.billing.issuedCount >= 5 &&
                    kpis.billing.collectionRate < 70
                  }
                  chart={{ kind: "gauge", value: kpis.billing?.collectionRate, max: 100, target: 70 }}
                />{" "}
                <KpiTile
                  label="Gross Margin"
                  value={
                    kpis.financial.grossMarginWeighted != null
                      ? `${Math.round(kpis.financial.grossMarginWeighted)}%`
                      : "—"
                  }
                  sub={
                    kpis.financial.grossMarginAvg != null
                      ? `per-job avg ${Math.round(kpis.financial.grossMarginAvg)}%`
                      : "revenue-weighted"
                  }
                  alert={
                    kpis.financial.grossMarginWeighted != null &&
                    kpis.financial.grossMarginWeighted < 40
                  }
                  chart={{ kind: "gauge", value: kpis.financial.grossMarginWeighted, max: 100, target: 40 }}
                />{" "}
                <KpiTile
                  label="Retention"
                  value={
                    kpis.retention.pct != null ? `${kpis.retention.pct}%` : "—"
                  }
                  sub={`${kpis.retention.lost} lost`}
                  alert={kpis.retention.pct != null && kpis.retention.pct < 85}
                  chart={{ kind: "gauge", value: kpis.retention.pct, max: 100, target: 85 }}
                />{" "}
              </KpiGrid>{" "}
              <button
                type="button"
                onClick={() => setShowAllKpis((v) => !v)}
                className="mt-3 u-label text-ink-secondary hover:text-zinc-900 u-focus-ring"
              >
                {showAllKpis ? "Show fewer metrics ▴" : "Show all metrics ▾"}
              </button>{" "}
              {showAllKpis && (
                <KpiGrid>
                  {" "}
                  <KpiTile
                    label="Callback Rate"
                    value={
                      kpis.service.callbackRate != null
                        ? `${kpis.service.callbackRate}%`
                        : "—"
                    }
                    sub={`${kpis.service.callbacks} callbacks`}
                    alert={
                      kpis.service.callbackRate != null &&
                      kpis.service.callbackRate >= 6
                    }
                    chart={{ kind: "gauge", value: kpis.service.callbackRate, max: 12, target: 6, lowerIsBetter: true }}
                  />{" "}
                  <KpiTile
                    label="Revenue / Job"
                    value={
                      kpis.financial.revPerJob != null
                        ? fmtMoney(kpis.financial.revPerJob)
                        : "—"
                    }
                    sub={`${kpis.financial.jobsDone} completed`}
                  />{" "}
                  <KpiTile
                    label="Revenue / Man-Hour"
                    value={
                      kpis.financial.rpmh != null
                        ? fmtMoney(kpis.financial.rpmh)
                        : "—"
                    }
                    sub="target $120"
                    alert={
                      kpis.financial.rpmh != null && kpis.financial.rpmh < 90
                    }
                    chart={{ kind: "bullet", value: kpis.financial.rpmh, target: 120 }}
                  />{" "}
                  <KpiTile
                    label="AR Days"
                    value={kpis.ar.days != null ? `${kpis.ar.days}d` : "—"}
                    sub={`${fmtMoneyCompact(kpis.ar.open)} open · ${kpis.ar.overdueCount} overdue`}
                    alert={kpis.ar.days != null && kpis.ar.days > 30}
                    chart={{ kind: "bullet", value: kpis.ar.days, target: 30, lowerIsBetter: true }}
                  />{" "}
                  <KpiTile
                    label="CSAT"
                    value={
                      kpis.quality.csatAvg != null
                        ? `${kpis.quality.csatAvg}/10`
                        : "—"
                    }
                    sub={
                      kpis.quality.csatResponses
                        ? `${kpis.quality.csatResponses} rate-page responses`
                        : "no responses yet"
                    }
                    alert={
                      kpis.quality.csatAvg != null &&
                      parseFloat(kpis.quality.csatAvg) < 8
                    }
                    chart={{
                      kind: "gauge",
                      value: kpis.quality.csatAvg != null ? parseFloat(kpis.quality.csatAvg) : null,
                      max: 10,
                      target: 8,
                    }}
                  />{" "}
                  <KpiTile
                    label="Autopay Coverage"
                    value={
                      kpis.billing?.autopayPct != null
                        ? `${kpis.billing.autopayPct}%`
                        : "—"
                    }
                    sub={
                      kpis.billing?.customerBase
                        ? `${kpis.billing.autopayCount} of ${kpis.billing.customerBase} customers`
                        : "no customers"
                    }
                    chart={{ kind: "gauge", value: kpis.billing?.autopayPct, max: 100 }}
                  />{" "}
                  <KpiTile
                    label="Memberships Sold"
                    value={
                      kpis.membershipsSold != null
                        ? fmtInt(kpis.membershipsSold)
                        : "—"
                    }
                    sub="new WaveGuard members"
                  />{" "}
                  <KpiTile
                    label="Call → Booking"
                    value={
                      !salesUnavailable && sales.callToBooking != null
                        ? `${sales.callToBooking}%`
                        : "—"
                    }
                    sub={
                      salesUnavailable
                        ? "lead metrics unavailable"
                        : `${sales.booked ?? 0} booked / ${sales.inboundCalls ?? 0} calls`
                    }
                    chart={{ kind: "gauge", value: salesUnavailable ? null : sales.callToBooking, max: 100 }}
                  />{" "}
                </KpiGrid>
              )}{" "}
            </>
          )}
        </CardBody>{" "}
      </Card>
      {/* MRR trend — full width above the attribution row */}
      {isMobile ? (
        <MobileFold title="MRR Trend" sub={mrrTrendSub}>
          {" "}
          <ChartCard title="MRR Trend" sub={mrrTrendSub}>
            {" "}
            <MrrTrendChart trend={mrrTrend?.trend || []} />{" "}
          </ChartCard>{" "}
        </MobileFold>
      ) : (
        <div className="mb-5">
          {" "}
          <ChartCard title="MRR Trend" sub={mrrTrendSub}>
            {" "}
            <MrrTrendChart trend={mrrTrend?.trend || []} />{" "}
          </ChartCard>{" "}
        </div>
      )}
      {/* Retention by signup cohort — % of each month's new customers still
          active over the months since they joined. */}
      {isMobile ? (
        <MobileFold
          title="Retention by Cohort"
          sub="% still active by signup month"
        >
          {" "}
          <ChartCard
            title="Retention by Cohort"
            sub="% still active by signup month"
          >
            {" "}
            <RetentionCohortGrid
              cohorts={cohort?.cohorts || []}
              maxOffset={cohort?.maxOffset || 0}
            />{" "}
          </ChartCard>{" "}
        </MobileFold>
      ) : (
        <div className="mb-5">
          {" "}
          <ChartCard
            title="Retention by Cohort"
            sub="% of each signup month still active"
          >
            {" "}
            <RetentionCohortGrid
              cohorts={cohort?.cohorts || []}
              maxOffset={cohort?.maxOffset || 0}
            />{" "}
          </ChartCard>{" "}
        </div>
      )}
      {/* AI chart builder — describe a metric, the AI builds + pins it. Gated off
          by default; the model only proposes SQL, the server sandboxes it. */}
      {aiChartsEnabled && (
        <div className="mb-5">
          <AiChartsPanel />
        </div>
      )}
      {/* Upstream lead-attribution row.
          Replaces the prior single Lead Source panel (which aggregated the
          downstream customers.lead_source string) with three upstream views
          we actually capture:
            - Calls by Source: call_log JOIN lead_sources by dialed number
            - Leads by Source: leads GROUP BY lead_source_id
            - Channel Mix:     leads.first_contact_channel breakdown
          Uses the same period selector as Core KPIs. */}
      {isMobile ? (
        <MobileFold
          title="Marketing Attribution"
          sub={
            callsBySource?.period?.label || kpis?.periodLabel || "Month to Date"
          }
        >
          {" "}
          <AttributionScorecard
            callsBySource={callsBySource}
            leadsBySource={leadsBySource}
            channelMix={channelMix}
            loading={attributionLoading}
            error={attributionError}
            onDrillSource={drillToSource}
          />{" "}
        </MobileFold>
      ) : (
        <ChartCard
          title="Marketing Attribution"
          sub={
            callsBySource?.period?.label || kpis?.periodLabel || "Month to Date"
          }
          className="mb-5"
        >
          <AttributionScorecard
            callsBySource={callsBySource}
            leadsBySource={leadsBySource}
            channelMix={channelMix}
            loading={attributionLoading}
            error={attributionError}
            onDrillSource={drillToSource}
          />
        </ChartCard>
      )}
      {/* Tech leaderboard — bar variant */}
      {kpis?.leaderboard?.length > 0 &&
        (isMobile ? (
          <MobileFold title="Tech Leaderboard" sub={kpis.periodLabel}>
            {" "}
            <ChartCard title="Tech Leaderboard" sub={kpis.periodLabel}>
              {" "}
              <TechLeaderboardBars leaderboard={kpis.leaderboard} />{" "}
            </ChartCard>{" "}
          </MobileFold>
        ) : (
          <ChartCard
            title="Tech Leaderboard"
            sub={kpis.periodLabel}
            className="mb-5"
          >
            {" "}
            <TechLeaderboardBars leaderboard={kpis.leaderboard} />{" "}
          </ChartCard>
        ))}
      {/* Billing Health — kept as a peer panel per user instruction */}
      {billing &&
        (isMobile ? (
          <MobileFold
            title="Billing Health"
            sub={`${billing.total_billable} billable`}
          >
            {" "}
            <BillingHealthPanel summary={billing} embedded />{" "}
          </MobileFold>
        ) : (
          <BillingHealthPanel summary={billing} />
        ))}
    </div>
  );
}

function DashboardAlertsBanner({ alerts }) {
  const visible = alerts.slice(0, 4);
  const criticalCount = alerts.filter((a) => a.severity === "critical").length;
  return (
    <Card className="mb-4 max-md:border-0 max-md:shadow-sm max-md:rounded-xl">
      {" "}
      <CardBody className="p-4">
        {" "}
        <div className="flex items-center justify-between gap-3">
          {" "}
          <div>
            {" "}
            <div className="u-label text-ink-secondary">
              Operational Alerts
            </div>{" "}
            <div className="mt-1 text-13 text-zinc-900">
              {criticalCount > 0
                ? `${criticalCount} critical alert${criticalCount === 1 ? "" : "s"}`
                : `${alerts.length} active alert${alerts.length === 1 ? "" : "s"}`}
            </div>{" "}
          </div>{" "}
          <Badge tone={criticalCount > 0 ? "alert" : "neutral"}>
            {alerts.length}
          </Badge>{" "}
        </div>{" "}
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
          {visible.map((alert) => (
            <a
              key={alert.id}
              href={alert.href || "#"}
              className="flex items-center justify-between gap-3 rounded-sm border-hairline border-zinc-200 bg-surface-sunken px-3 py-2 text-13 text-zinc-900 hover:bg-white"
            >
              {" "}
              <span className="flex items-center gap-2 min-w-0">
                {" "}
                <span
                  className={cn(
                    "h-2 w-2 rounded-full flex-shrink-0",
                    alert.severity === "critical"
                      ? "bg-alert-fg"
                      : "bg-amber-500",
                  )}
                />{" "}
                <span className="truncate">{alert.label}</span>{" "}
              </span>
              {alert.amount != null && (
                <span className="u-nums text-12 text-ink-secondary flex-shrink-0">
                  {fmtMoneyCompact(alert.amount)}
                </span>
              )}
            </a>
          ))}
        </div>{" "}
      </CardBody>{" "}
    </Card>
  );
}

function MobileFold({ title, sub, children }) {
  return (
    <details className="md:hidden mb-3 rounded-xl border-hairline border-zinc-200 bg-white shadow-sm overflow-hidden">
      {" "}
      <summary className="list-none cursor-pointer select-none px-4 py-4 flex items-center justify-between gap-3">
        {" "}
        <span className="u-label text-zinc-900">{title}</span>
        {sub && (
          <span className="text-12 text-ink-secondary text-right truncate">
            {sub}
          </span>
        )}
      </summary>{" "}
      <div className="px-3 pb-3">{children}</div>{" "}
    </details>
  );
}


function pct(n) {
  return n == null ? "—" : `${n}%`;
}

// Signed display for net-momentum tiles: explicit + on gains, a true minus
// glyph on losses, bare 0 at flat. Magnitude is formatted by `fmt`.
function signed(n, fmt) {
  if (n == null) return "—";
  const v = Number(n);
  if (v === 0) return fmt(0);
  return `${v > 0 ? "+" : "−"}${fmt(Math.abs(v))}`;
}

function KpiGrid({ children }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{children}</div>
  );
}

function KpiTile({ label, value, sub, alert, chart }) {
  // Gauge tiles let the ring BE the value (number in the center), with the
  // sub beside it — no duplicate big number.
  if (chart?.kind === "gauge") {
    return (
      <div className="bg-surface-sunken border-hairline border-zinc-200 rounded-sm p-3">
        <div className="u-label text-ink-secondary">{label}</div>
        <div className="flex items-center gap-3 mt-2">
          <KpiRing
            value={chart.value}
            max={chart.max}
            target={chart.target}
            lowerIsBetter={chart.lowerIsBetter}
            alert={alert}
            display={value}
          />
          {sub && <div className="text-11 text-ink-secondary min-w-0">{sub}</div>}
        </div>
      </div>
    );
  }
  // Bullet / diverging tiles keep the big number, with the bar beneath.
  return (
    <div className="bg-surface-sunken border-hairline border-zinc-200 rounded-sm p-3">
      {" "}
      <div className="u-label text-ink-secondary">{label}</div>{" "}
      <div
        className={cn(
          "u-nums text-22 font-medium tracking-tight mt-2 leading-none",
          alert ? "text-alert-fg" : "text-zinc-900",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-11 text-ink-secondary">{sub}</div>}
      {chart?.kind === "bullet" && (
        <div className="mt-2">
          <KpiBullet
            value={chart.value}
            target={chart.target}
            max={chart.max}
            lowerIsBetter={chart.lowerIsBetter}
            alert={alert}
          />
        </div>
      )}
      {chart?.kind === "diverging" && (
        <div className="mt-2">
          <KpiDivergingBar positive={chart.positive} negative={chart.negative} />
        </div>
      )}
    </div>
  );
}

function BillingHealthPanel({ summary: h, embedded = false }) {
  const billable = h.total_billable || 0;
  const autopayActive = h.autopay_active || 0; // enabled minus paused
  const paused = h.autopay_paused || 0;
  const enabled = autopayActive + paused; // all autopay-enabled accounts
  // Autopay-off accounts (billed manually). The backend reports this directly;
  // fall back to billable − enabled (every billable row is enabled or disabled).
  const manual = h.autopay_disabled != null ? h.autopay_disabled : Math.max(billable - enabled, 0);
  const autopayPct = billable > 0 ? Math.round((enabled / billable) * 100) : 0;
  const seg = (n) => (billable > 0 ? (n / billable) * 100 : 0);

  // Every state that means an account WON'T be billed cleanly — not just charge
  // failures. `no_payment_method` is autopay-enabled-with-no-card (so autopay
  // silently can't run) and `paused` autopay is skipped by the billing cron;
  // both belong in the verdict, not hidden. Verdict is healthy only when all clear.
  const attention = [
    { label: "No card", value: h.no_payment_method || 0 },
    { label: "Paused", value: paused },
    { label: "Failed", value: h.failed_last_30_days || 0 },
    { label: "In retry", value: h.in_retry_queue || 0 },
    { label: "Escalated", value: h.escalated_last_30_days || 0 },
    // 60-day window (incl. already-expired) — labelled so it isn't read as a 30d event.
    { label: "Cards expiring (60d)", value: h.expiring_cards_60_days || 0 },
  ];
  const healthy = attention.every((a) => a.value === 0);

  // Autopay-enabled vs manual — sums to the billable base, no inference. (We do
  // NOT split out "has a saved method" because the backend only reports the
  // no-card count within autopay-enabled accounts, so it can't be derived here.)
  const coverage = [
    { label: "Autopay", value: enabled, color: CHART_SUCCESS, suffix: ` (${autopayPct}%)` },
    { label: "Manual", value: manual, color: "#D4D4D8" },
  ];

  // Status-first verdict — green only when every won't-bill state is clear.
  const verdict = (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-11 font-medium whitespace-nowrap",
        !healthy && "text-alert-fg bg-alert-bg",
      )}
      style={healthy ? { color: CHART_SUCCESS, background: "rgba(16,185,129,0.10)" } : undefined}
    >
      {healthy ? "✓ Healthy" : "⚠ Needs attention"}
    </span>
  );

  const body = (
    <>
      {/* Autopay coverage — enabled vs manual; sums to the billable base. */}
      <div className="u-label text-ink-tertiary mb-2">Autopay coverage</div>
      <div className="flex h-2.5 rounded-sm overflow-hidden bg-surface-sunken mb-2">
        {coverage.map((r) => (
          <div
            key={r.label}
            style={{ width: `${seg(r.value)}%`, background: r.color }}
            title={`${r.label}: ${r.value}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-12">
        {coverage.map((r) => (
          <span key={r.label} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: r.color }} />
            <span className="text-ink-secondary">{r.label}</span>
            <span className="u-nums font-medium">{r.value}</span>
            {r.suffix && <span className="u-nums text-ink-tertiary">{r.suffix}</span>}
          </span>
        ))}
      </div>

      {/* Won't-bill / needs-attention — chips, green-✓ when clear, alert when not */}
      <div className="mt-4 pt-3 border-t border-hairline border-zinc-100">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="u-label text-ink-tertiary">Won't bill / needs attention</span>
          <span className="u-nums text-12 text-ink-tertiary whitespace-nowrap">
            {h.charged_this_month || 0} charged this month
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {attention.map((a) => {
            const bad = a.value > 0;
            return (
              <span
                key={a.label}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-12",
                  bad
                    ? "text-alert-fg bg-alert-bg border-alert-fg/30"
                    : "text-ink-secondary bg-surface-sunken border-zinc-200",
                )}
              >
                {!bad && <span style={{ color: CHART_SUCCESS }}>✓</span>}
                <span>{a.label}</span>
                <span className="u-nums font-medium">{a.value}</span>
              </span>
            );
          })}
        </div>
      </div>
    </>
  );

  // Embedded inside a MobileFold that already shows the "Billing Health" title +
  // billable count — render just the verdict + body (no duplicate Card/header/badge).
  if (embedded) {
    return (
      <div>
        <div className="mb-3">{verdict}</div>
        {body}
      </div>
    );
  }

  return (
    <Card className="mb-5 max-md:border-0 max-md:shadow-sm max-md:rounded-xl">
      <CardHeader className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <CardTitle>Billing Health</CardTitle>
          {verdict}
        </div>
        <Badge>{billable} billable</Badge>
      </CardHeader>
      <CardBody>{body}</CardBody>
    </Card>
  );
}
