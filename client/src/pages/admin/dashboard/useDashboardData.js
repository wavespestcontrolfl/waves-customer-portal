import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useVisiblePageRefresh from "../../../hooks/useVisiblePageRefresh";
import { adminFetch } from "../../../utils/admin-fetch";

// Operations go first. Four workers publish results individually, so a slow
// analytics endpoint cannot hold today's actions behind a Promise.all wave.
// The section column also keeps unopened mobile analytics off the network.
const REQUESTS = [
  ["alerts", "/admin/dashboard/alerts", "today"],
  ["today", "/admin/dashboard/today-completion", "today"],
  ["staleVisits", "/admin/command-center/stale-visits", "today"],
  ["kpis", "/admin/dashboard/core-kpis", "shared", true],
  ["kpiTargets", "/admin/kpi-targets", "shared"],
  ["kpiHistory", "/admin/dashboard/kpi-history?days=90", "shared"],
  ["data", "/admin/dashboard", "growth"],
  ["compare", "/admin/dashboard/compare?period=this_month&against=last_month", "growth"],
  ["salesCapture", "/admin/dashboard/sales-capture", "growth"],
  ["funnel", "/admin/dashboard/funnel", "growth"],
  ["revenueByCity", "/admin/dashboard/revenue-by-city", "growth"],
  ["capAlloc", "/admin/ads/capital-allocation?period=quarter", "growth"],
  ["callsBySource", "/admin/dashboard/calls-by-source", "growth", true],
  ["leadsBySource", "/admin/dashboard/leads-by-source", "growth", true],
  ["channelMix", "/admin/dashboard/channel-mix", "growth", true],
  ["leadFunnel", "/admin/dashboard/lead-funnel", "growth", true],
  ["channelRoi", "/admin/dashboard/channel-roi", "growth", true],
  ["mix", "/admin/dashboard/service-mix", "profit"],
  ["ebitda", "/admin/dashboard/ebitda-bridge", "profit"],
  ["revenueOverview", "/admin/revenue/overview?period=month", "profit"],
  ["mrrTrend", "/admin/dashboard/mrr-trend?months=12", "retention"],
  ["mrrBridge", "/admin/dashboard/mrr-bridge?months=6", "retention"],
  ["churnReasons", "/admin/dashboard/churn-reasons?months=12", "retention"],
  ["cohort", "/admin/dashboard/retention-cohort?months=12", "retention"],
  ["reviewTrend", "/admin/dashboard/review-trend", "retention"],
  ["aging", "/admin/dashboard/aging", "cash"],
  ["billing", "/admin/billing-health", "cash"],
];
const OPERATIONAL_KEYS = new Set(["alerts", "today", "staleVisits"]);
const DASHBOARD_REFRESH_MS = 60000;

async function fetchDashboard(path, signal) {
  const controller = new AbortController();
  let timeout;
  let cancel;
  const deadline = new Promise((_, reject) => {
    cancel = () => {
      controller.abort();
      reject(new DOMException("Dashboard request cancelled", "AbortError"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("This dashboard request timed out. Please try again."));
    }, 15000);
  });
  try {
    return await Promise.race([adminFetch(path, { signal: controller.signal }), deadline]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
  }
}

export default function useDashboardData(section, periodQS) {
  const [records, setRecords] = useState({});
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const running = useRef(false);
  const recordsRef = useRef(records);
  const previousCycle = useRef(null);
  recordsRef.current = records;
  const requests = useMemo(() => REQUESTS
    .filter(([, , group]) => section === "all" || group === "shared" || group === section)
    .map(([key, path, , periodDriven]) => [key, periodDriven ? `${path}?${periodQS}` : path, !!periodDriven]),
  [section, periodQS]);

  useEffect(() => {
    const prior = previousCycle.current;
    const periodOnly = prior && prior.section === section && prior.revision === revision
      && prior.periodQS !== periodQS;
    const sectionOnly = prior && prior.section !== section && prior.revision === revision
      && prior.periodQS === periodQS;
    previousCycle.current = { section, periodQS, revision };
    const sectionCacheCutoff = Date.now() - DASHBOARD_REFRESH_MS;
    const unfinishedFixed = periodOnly ? requests.filter(([key, path, periodDriven]) => !periodDriven
      && (recordsRef.current[key]?.path !== path || recordsRef.current[key]?.pending)) : [];
    const cycleRequests = periodOnly ? [
      ...unfinishedFixed.filter(([key]) => OPERATIONAL_KEYS.has(key)),
      ...requests.filter(([, , periodDriven]) => periodDriven),
      ...unfinishedFixed.filter(([key]) => !OPERATIONAL_KEYS.has(key)),
    ] : sectionOnly ? requests.filter(([key, path]) => {
      const record = recordsRef.current[key];
      return record?.path !== path || record.pending || record.error || record.updatedAt == null
        || record.updatedAt <= sectionCacheCutoff;
    }) : requests;
    const controller = new AbortController();
    const { signal } = controller;
    running.current = true;
    setRecords((previous) => {
      const next = { ...previous };
      for (const [key, path] of cycleRequests) {
        const retained = previous[key]?.path === path ? previous[key] : {};
        next[key] = { ...retained, path, pending: true };
      }
      return next;
    });
    let nextIndex = 0;
    async function worker() {
      while (!signal.aborted && nextIndex < cycleRequests.length) {
        const [key, path] = cycleRequests[nextIndex++];
        try {
          const value = await fetchDashboard(path, signal);
          // These operational feeds may only claim an empty backlog after a
          // valid response. An error-shaped/malformed payload is unavailable.
          if (!value || value.error
            || (key === "alerts" && !Array.isArray(value.alerts))
            || (key === "kpiTargets" && !Array.isArray(value.targets))
            || (key === "staleVisits" && !Array.isArray(value.visits))
            || (key === "today" && typeof value.total !== "number")
            || (key === "data" && (!value.kpis || typeof value.kpis !== "object" || Array.isArray(value.kpis)))) {
            throw new Error("Dashboard data is unavailable.");
          }
          if (signal.aborted) return;
          setRecords((previous) => ({ ...previous,
            [key]: { path, value, pending: false, error: null, updatedAt: Date.now() },
          }));
        } catch (error) {
          if (signal.aborted) return;
          setRecords((previous) => ({ ...previous,
            [key]: { ...previous[key], pending: false, error },
          }));
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, cycleRequests.length) }, worker))
      .finally(() => { if (!signal.aborted) running.current = false; });
    return () => { controller.abort(); running.current = false; };
  }, [requests, revision, section, periodQS]);

  useVisiblePageRefresh(() => {
    if (!running.current) refresh();
  }, { intervalMs: DASHBOARD_REFRESH_MS });

  const values = {};
  const errors = {};
  const pending = {};
  const updated = [];
  for (const [key, path] of requests) {
    const record = records[key]?.path === path ? records[key] : null;
    values[key] = record?.value ?? null;
    errors[key] = record?.error ?? null;
    pending[key] = record?.pending ?? true;
    updated.push(record?.updatedAt ?? null);
  }
  return { values, errors, pending, refresh,
    refreshing: Object.values(pending).some(Boolean),
    lastUpdated: updated.every((time) => time !== null) ? Math.min(...updated) : null,
  };
}
