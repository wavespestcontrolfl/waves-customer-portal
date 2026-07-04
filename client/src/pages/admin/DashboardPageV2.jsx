import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import useIsMobile from "../../hooks/useIsMobile";
import { useFeatureFlag } from "../../hooks/useFeatureFlag";
import AiChartsPanel from "../../components/dashboard/AiChartsPanel";
import {
  adminFetch,
  isForbiddenError,
  isRateLimitError,
} from "../../utils/admin-fetch";
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
  const [capAlloc, setCapAlloc] = useState(null); // /admin/ads/capital-allocation
  // /lead-source (downstream string aggregation) is intentionally dropped
  // in favor of the upstream attribution endpoints below.
  const [callsBySource, setCallsBySource] = useState(null);
  const [leadsBySource, setLeadsBySource] = useState(null);
  const [channelMix, setChannelMix] = useState(null);
  const [leadFunnel, setLeadFunnel] = useState(null); // /admin/dashboard/lead-funnel (period-driven)
  const [mix, setMix] = useState(null);
  const [revenueByCity, setRevenueByCity] = useState(null);
  const [reviewTrend, setReviewTrend] = useState(null);
  const [today, setToday] = useState(null);
  const [billing, setBilling] = useState(null);
  // null = alerts never loaded successfully. ActionInbox renders an explicit
  // unavailable state for null — only a real [] response may claim all-clear.
  const [alerts, setAlerts] = useState(null);
  // true = the LATEST alerts fetch failed (value above is a kept-previous).
  // ActionInbox suppresses the green all-clear while stale.
  const [alertsStale, setAlertsStale] = useState(false);
  // KPI-target store rows keyed by metric, + per-metric sparkline series
  // (wave3). null while unfetched — tiles fall back to DEFAULT_KPI_TARGETS.
  const [kpiTargets, setKpiTargets] = useState(null);
  const [kpiHistory, setKpiHistory] = useState(null);
  const [ebitda, setEbitda] = useState(null); // /admin/dashboard/ebitda-bridge (wave4)
  const [mrrBridge, setMrrBridge] = useState(null); // /admin/dashboard/mrr-bridge (wave5)
  const [revenueOverview, setRevenueOverview] = useState(null); // /admin/revenue/overview (wave6 — margin by line)
  // Mobile scorecard: below md the five sections render ONE at a time behind
  // the jump-nav pills (real tabs), so a phone isn't scrolling five sections
  // of charts. Desktop keeps the one-page scroll + IntersectionObserver nav.
  const [mobileTab, setMobileTab] = useState(SECTIONS[0].id);

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
  const navigate = useNavigate();
  // Mobile tab switch: swap the visible section and snap the admin scroll
  // container back to the top so every tab opens at its header.
  const selectMobileTab = useCallback((id) => {
    setMobileTab(id);
    const scroller = document.querySelector(".admin-main");
    if (scroller && typeof scroller.scrollTo === "function") {
      scroller.scrollTo({ top: 0 });
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
    // Mark refresh failures so ActionInbox can tell "confirmed empty" from
    // "kept the previous value" (the preserve-on-failure pattern above) —
    // a green all-clear must never render off a failed load.
    setAlertsStale(!Array.isArray(al?.alerts));
    setLoading(false);

    const wave2 = await Promise.all([
      track("/funnel", adminFetch("/admin/dashboard/funnel")),
      track("/aging", adminFetch("/admin/dashboard/aging")),
      track("/mrr-trend", adminFetch("/admin/dashboard/mrr-trend?months=12")),
      track("/service-mix", adminFetch("/admin/dashboard/service-mix")),
      track("/revenue-by-city", adminFetch("/admin/dashboard/revenue-by-city")),
      track("/review-trend", adminFetch("/admin/dashboard/review-trend")),
      track("/retention-cohort", adminFetch("/admin/dashboard/retention-cohort?months=12")),
      track("/capital-allocation", adminFetch("/admin/ads/capital-allocation?period=quarter")),
    ]);
    if (!mountedRef.current) { inFlightRef.current = false; return; }
    const [fnl, ag, mrr, mx, rbc, rev, coh, cap] = wave2;
    setFunnel((prev) => fnl ?? prev);
    setAging((prev) => ag ?? prev);
    setMrrTrend((prev) => mrr ?? prev);
    setMix((prev) => mx ?? prev);
    setRevenueByCity((prev) => rbc ?? prev);
    setReviewTrend((prev) => rev ?? prev);
    setCohort((prev) => coh ?? prev);
    setCapAlloc((prev) => cap ?? prev);

    // Wave 3 — KPI-target store + sparkline history for the tiles. A new wave
    // (never appended to 1/2) so the added fetches can't push an existing
    // wave over the per-user rate-limit budget. Both fail soft: tiles fall
    // back to DEFAULT_KPI_TARGETS / no sparkline.
    const wave3 = await Promise.all([
      track("/kpi-targets", adminFetch("/admin/kpi-targets")),
      track("/kpi-history", adminFetch("/admin/dashboard/kpi-history?days=90")),
    ]);
    if (!mountedRef.current) { inFlightRef.current = false; return; }
    const [tgt, hist] = wave3;
    setKpiTargets((prev) => {
      if (!Array.isArray(tgt?.targets)) return prev;
      const byMetric = {};
      for (const row of tgt.targets) byMetric[row.metric] = row;
      return byMetric;
    });
    setKpiHistory((prev) => (hist?.series && typeof hist.series === "object" ? hist.series : prev));

    // Wave 4 — the adjusted-EBITDA bridge. Its own wave for the same rate-limit
    // reason wave3 exists (never grow an existing wave); fails soft to the
    // card's loading/empty state.
    const wave4 = await Promise.all([
      track("/ebitda-bridge", adminFetch("/admin/dashboard/ebitda-bridge")),
    ]);
    if (!mountedRef.current) { inFlightRef.current = false; return; }
    const [eb] = wave4;
    setEbitda((prev) => eb ?? prev);

    // Wave 5 — the net-MRR bridge. Same one-fetch-per-new-wave rule as wave4
    // (rate-limiter budget); fails soft to the card's loading/empty state.
    const wave5 = await Promise.all([
      track("/mrr-bridge", adminFetch("/admin/dashboard/mrr-bridge?months=6")),
    ]);
    if (!mountedRef.current) { inFlightRef.current = false; return; }
    const [mb] = wave5;
    setMrrBridge((prev) => mb ?? prev);

    // Wave 6 — revenue overview for the margin-by-service-line card (reuses
    // the revenue page's job-costed byServiceLine; zero new SQL). Same
    // one-fetch-per-new-wave rate-limit rule; fails soft.
    const wave6 = await Promise.all([
      track("/revenue-overview", adminFetch("/admin/revenue/overview?period=month")),
    ]);
    if (!mountedRef.current) { inFlightRef.current = false; return; }
    const [ro] = wave6;
    setRevenueOverview((prev) => ro ?? prev);
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
        ? `custom:${customRange.from}`
        : period;
    const periodQS =
      period === "custom" && customRange
        ? `period=custom&from=${customRange.from}`
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
        ? `custom:${customRange.from}`
        : period;
    const periodQS =
      period === "custom" && customRange
        ? `period=custom&from=${customRange.from}`
        : `period=${period}`;
    const periodChanged = attribPeriodRef.current !== periodKey;
    attribPeriodRef.current = periodKey;
    const gateGen = refreshNonce;
    let ok = true;
    if (periodChanged) {
      setCallsBySource(null);
      setLeadsBySource(null);
      setChannelMix(null);
      setLeadFunnel(null);
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
      adminFetch(`/admin/dashboard/lead-funnel?${periodQS}`, {
        signal: ctrl.signal,
      }),
    ])
      .then(([calls, leads, channels, funnelBySrc]) => {
        setCallsBySource(calls);
        setLeadsBySource(leads);
        setChannelMix(channels);
        setLeadFunnel(funnelBySrc);
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
    kpiHistory: period === "mtd" ? kpiHistory : null,
  };

  return (
    <div className="dashboard-blackout font-sans bg-surface-page min-h-full p-3 sm:p-6 pb-[calc(6rem+env(safe-area-inset-bottom))] md:pb-6 text-zinc-900">
      <header className="mb-3 max-md:mb-4">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <div className="u-label text-ink-secondary max-md:text-13 max-md:tracking-normal max-md:normal-case max-md:font-medium max-md:text-zinc-500">
              {todayLabel} · {timeLabel}
            </div>
            <h1 className="text-28 font-normal tracking-h1 mt-1 max-md:mt-2">
              <span
                className="md:hidden"
                style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.1 }}
              >
                {greeting()}, {firstName}
              </span>{" "}
              <span className="hidden md:inline">
                {greeting()}, {firstName}
              </span>
            </h1>
          </div>
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
          </div>
        </div>
      </header>

      {/* Sticky jump-nav + period selector. The period drives the KPI tiles
          (distributed across sections) and the Marketing Attribution panels;
          everything else keeps its fixed window (labeled per card). */}
      <DashboardJumpNav
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

      {/* Alerts stay the first dashboard content, even with AI charts pinned. */}
      {sectionVisible("today") && (
        <TodaySection alerts={alerts} alertsStale={alertsStale} today={today} {...kpiStripProps} />
      )}

      {/* AI chart builder — describe a metric, the AI builds + pins it. Gated off
          by default; the model only proposes SQL, the server sandboxes it. */}
      {aiChartsEnabled && sectionVisible("today") && (
        <div className="mb-5">
          <AiChartsPanel />
        </div>
      )}


      {sectionVisible("growth") && (
        <GrowthSection
          data={data}
          compare={compare}
          salesCapture={salesCapture}
          funnel={funnel}
          revenueByCity={revenueByCity}
          capAlloc={capAlloc}
          callsBySource={callsBySource}
          leadsBySource={leadsBySource}
          channelMix={channelMix}
          leadFunnel={leadFunnel}
          attributionLoading={attributionLoading}
          attributionError={attributionError}
          onDrillSource={drillToSource}
          isMobile={isMobile}
          {...kpiStripProps}
        />
      )}

      {sectionVisible("profit") && (
        <ProfitSection
          mix={mix}
          ebitda={ebitda}
          revenueOverview={revenueOverview}
          isMobile={isMobile}
          {...kpiStripProps}
        />
      )}

      {sectionVisible("retention") && (
        <RetentionSection
          mrrTrend={mrrTrend}
          mrrBridge={mrrBridge}
          cohort={cohort}
          reviewTrend={reviewTrend}
          isMobile={isMobile}
          {...kpiStripProps}
        />
      )}

      {sectionVisible("cash") && (
        <CashSection
          aging={aging}
          billing={billing}
          isMobile={isMobile}
          {...kpiStripProps}
        />
      )}
    </div>
  );
}
