import { useState, useEffect, useCallback } from "react";
import useIsMobile from "../../../hooks/useIsMobile";
import { addStaffCalendarDays as addDays } from "../../../lib/staffTimeDate";
import {
  D, MONO, DAYS, TYPE_COLORS,
  adminFetch, sCard, sBtn, sBadge, fmt, fmtHrs, fmtPct, errMessage,
  effectivePayRate, paidMinutesOf, unpaidMinutesOf, MiniStat, StatCard, LoadFailedNotice, UtilRing,
} from "./staffShared";

// =============================================================================
// DASHBOARD TAB
// =============================================================================
export function DashboardTab({ showToast }) {
  const isMobile = useIsMobile(640);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await adminFetch("/admin/timetracking");
      setData(res);
    } catch (e) {
      showToast("Failed to load dashboard");
    }
    setLoading(false);
  }, [showToast]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, [load]);

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading...
      </div>
    );
  if (!data)
    return (
      <LoadFailedNotice onRetry={load}>
        Failed to load dashboard.
      </LoadFailedNotice>
    );

  const { activeShifts, todaySummaries, weekDailies, allTechs } = data;
  // codex round-1 P2: a technician response's summaries have no job_count/
  // total_job_minutes/revenue_generated/utilization_pct at all (server-side
  // projection, admin-timetracking.js GET /) — the reduces below still
  // default a missing field to 0, so without this flag a technician would
  // see "$0 revenue" / "0% utilization" for a coworker rendered as a real
  // number instead of hidden.
  const isRestrictedViewer = data.viewerRole === "technician";

  const nowMs = Date.now();
  const activeMinutesFor = (shift) =>
    shift && shift.clock_in ? Math.max(0, (nowMs - new Date(shift.clock_in).getTime()) / 60000) : 0;

  // Today totals: include currently active shifts that have not yet been
  // rolled into time_entry_daily_summary.
  const activeShiftMinTotal = activeShifts.reduce((s, sh) => s + activeMinutesFor(sh), 0);
  const todayShiftMin =
    todaySummaries.reduce((s, d) => s + parseFloat(d.total_shift_minutes || 0), 0) +
    activeShiftMinTotal;
  const todayPaidMin =
    todaySummaries.reduce((s, d) => s + paidMinutesOf(d), 0) +
    activeShiftMinTotal;
  const todayJobMin = todaySummaries.reduce(
    (s, d) => s + parseFloat(d.total_job_minutes || 0),
    0,
  );
  const todayRevenue = todaySummaries.reduce(
    (s, d) => s + parseFloat(d.revenue_generated || 0),
    0,
  );
  const todayJobs = todaySummaries.reduce((s, d) => s + (d.job_count || 0), 0);
  // Labor cost is per-tech: regular hours at pay_rate, overtime hours at 1.5x,
  // plus active-shift elapsed hours (falling back to LABOR_RATE = $35 only when
  // pay_rate is unset, preserving an explicit $0 rate).
  const todayLaborCost =
    todaySummaries.reduce((s, d) => {
      const tech = allTechs.find((t) => t.id === d.technician_id);
      const rate = effectivePayRate(tech);
      const paidMin = paidMinutesOf(d);
      const otMin = Math.min(paidMin, Math.max(0, parseFloat(d.overtime_minutes || 0)));
      const regMin = Math.max(0, paidMin - otMin);
      return s + ((regMin + otMin * 1.5) / 60) * rate;
    }, 0) +
    activeShifts.reduce((s, sh) => {
      const tech = allTechs.find((t) => t.id === sh.technician_id);
      return s + (activeMinutesFor(sh) / 60) * effectivePayRate(tech);
    }, 0);
  const todayUtil = todayShiftMin > 0 ? (todayJobMin / todayShiftMin) * 100 : 0;

  // This week totals
  const weekPaidMin = weekDailies.reduce(
    (s, d) => s + paidMinutesOf(d),
    0,
  );
  const weekRevenue = weekDailies.reduce(
    (s, d) => s + parseFloat(d.revenue_generated || 0),
    0,
  );
  // Overtime is per technician per week: the server allocates each tech's
  // minutes past 40 h to that tech's days (overtime_minutes, the same field
  // the bar chart stacks). One 40 h threshold on the whole team's hours
  // reported overtime when nobody had worked 40 h.
  const weekOT = weekDailies.reduce(
    (s, d) => s + parseFloat(d.overtime_minutes || 0),
    0,
  );
  // Only show techs with activity — hide inactive techs with 0 hours/jobs
  const liveTechs = allTechs.filter((tech) => {
    const active = activeShifts.find((s) => s.technician_id === tech.id);
    const summary = todaySummaries.find((s) => s.technician_id === tech.id);
    const hasWeekActivity = weekDailies.some((d) => d.technician_id === tech.id);
    return active || summary || hasWeekActivity;
  });

  return (
    <div>
      {/* Live Tech Status Cards */}
      <div
        style={{
          fontSize: 15,
          fontWeight: 500,
          color: D.heading,
          marginBottom: 12,
        }}
      >
        Live Status
      </div>{" "}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile
            ? "1fr"
            : "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 12,
          marginBottom: 24,
        }}
      >
        {liveTechs.length === 0 && (
          <div style={{ fontSize: 14, color: D.muted, padding: "4px 0" }}>
            No one clocked in
          </div>
        )}
        {liveTechs.map((tech) => {
            const active = activeShifts.find(
              (s) => s.technician_id === tech.id,
            );
            const summary = todaySummaries.find(
              (s) => s.technician_id === tech.id,
            ) || {};
            const shiftDur = activeMinutesFor(active);
            const dayHrs = (paidMinutesOf(summary) + shiftDur) / 60;
            const dayJobs = summary.job_count || 0;
            const dayRev = parseFloat(summary.revenue_generated) || 0;
            const dayUtil = parseFloat(summary.utilization_pct) || 0;

            return (
              <div
                key={tech.id}
                style={{
                  ...sCard,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                {" "}
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {" "}
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: active ? D.green : D.muted,
                      boxShadow: active ? `0 0 8px ${D.green}` : "none",
                    }}
                  />{" "}
                  <div style={{ fontWeight: 500, color: D.heading, flex: 1 }}>
                    {tech.name}
                  </div>{" "}
                  <span
                    style={sBadge(
                      active ? D.green + "22" : D.muted + "22",
                      active ? D.green : D.muted,
                    )}
                  >
                    {active ? "CLOCKED IN" : "OFF"}
                  </span>{" "}
                </div>
                {active && (
                  <div style={{ fontSize: 14, color: D.muted }}>
                    Shift: {fmtHrs(shiftDur)} |{" "}
                    {active.onBreak
                      ? "On Break"
                      : active.currentJob
                        ? isRestrictedViewer
                          // codex round-3 P2: the server never sends a
                          // restricted (technician) viewer a coworker's
                          // customer name (techSafeActiveShift projects
                          // currentJob down to service_type only) — render
                          // that instead of the now-always-empty "Job: ".
                          ? `Job: ${active.currentJob.service_type || "on a job"}`
                          : `Job: ${active.currentJob.first_name || ""} ${active.currentJob.last_name || ""}`.trim()
                        : "Between jobs"}
                  </div>
                )}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: isRestrictedViewer ? "1fr" : "1fr 1fr 1fr",
                    gap: 8,
                  }}
                >
                  {" "}
                  <MiniStat label="Hours" value={dayHrs.toFixed(1)} />{" "}
                  {!isRestrictedViewer && (
                    <>
                      <MiniStat label="Jobs" value={dayJobs} />{" "}
                      <MiniStat label="Revenue" value={fmt(dayRev)} />{" "}
                    </>
                  )}
                </div>
                {/* Utilization ring — hidden for a restricted (technician) viewer: utilization_pct is never sent */}
                {!isRestrictedViewer && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {" "}
                    <UtilRing pct={dayUtil} size={32} />{" "}
                    <span style={{ fontSize: 14, color: D.muted }}>
                      Utilization: {dayUtil.toFixed(0)}%
                    </span>{" "}
                  </div>
                )}{" "}
              </div>
            );
          })}
      </div>
      {/* Today's Labor Summary */}
      <div
        style={{
          fontSize: 15,
          fontWeight: 500,
          color: D.heading,
          marginBottom: 12,
        }}
      >
        Today's Labor
      </div>{" "}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile
            ? "repeat(2, 1fr)"
            : `repeat(${isRestrictedViewer ? 1 : 5}, 1fr)`,
          gap: 12,
          marginBottom: 24,
        }}
      >
        {" "}
        <StatCard
          label="Total Hours"
          value={fmtHrs(todayPaidMin)}
          color={D.teal}
        />{" "}
        {/* Labor cost implies a coworker wage: office-only. */}
        {!isRestrictedViewer && (
          <StatCard
            label="Labor Cost"
            value={fmt(todayLaborCost)}
            color={D.amber}
          />
        )}{" "}
        {/* Revenue / Jobs Done / Utilization all derive from fields the
            server never sends a restricted (technician) viewer — hide
            rather than render the 0-default as a real metric. */}
        {!isRestrictedViewer && (
          <>
            <StatCard label="Revenue" value={fmt(todayRevenue)} color={D.green} />{" "}
            <StatCard label="Jobs Done" value={todayJobs} color={D.purple} />{" "}
            <StatCard
              label="Utilization"
              value={fmtPct(todayUtil)}
              color={todayUtil >= 70 ? D.green : todayUtil >= 50 ? D.amber : D.red}
            />{" "}
          </>
        )}
      </div>
      {/* This Week Bar Chart */}
      <div
        style={{
          fontSize: 15,
          fontWeight: 500,
          color: D.heading,
          marginBottom: 12,
        }}
      >
        This Week
      </div>{" "}
      <div style={sCard}>
        {" "}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 8,
          }}
        >
          {" "}
          <span style={{ fontSize: 14, color: D.muted }}>
            Week total: {fmtHrs(weekPaidMin)}
            {!isRestrictedViewer && <> | Revenue: {fmt(weekRevenue)}</>}
            {/* overtime_minutes is a per-tech field the server never sends a
                restricted viewer (techSafeDailySummary); the weekly OT
                figure is hidden for that viewer. */}
            {!isRestrictedViewer && <> | OT: {fmtHrs(weekOT)}</>}
          </span>{" "}
          {/* The bar chart's key, as text beside the chart instead of 9px
              text inside it. A restricted viewer's bars have no OT split. */}
          {!isRestrictedViewer && (
            <span style={{ fontSize: 14, color: D.muted, display: "flex", gap: 12 }}>
              <span>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: D.teal, marginRight: 4 }} />
                Reg
              </span>
              <span>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: D.red, marginRight: 4 }} />
                OT
              </span>
            </span>
          )}
        </div>{" "}
        <WeekBarChart
          weekDailies={weekDailies}
          weekStart={data.weekStart}
          isRestrictedViewer={isRestrictedViewer}
        />{" "}
      </div>{" "}
    </div>
  );
}

function WeekBarChart({ weekDailies, weekStart, isRestrictedViewer }) {
  const isMobile = useIsMobile(640);
  const barH = 120;
  const barW = isMobile ? 28 : 50;
  // Room above the bars for a 14px hours label, so a full day is not cut off.
  const top = 18;

  const dayRows = DAYS.map((day, i) => {
    const dateStr = addDays(weekStart, i);
    const dayData = weekDailies.filter(
      (d) =>
        d.work_date === dateStr ||
        (d.work_date && String(d.work_date).split("T")[0] === dateStr),
    );
    const shiftMin = dayData.reduce((s, d) => s + paidMinutesOf(d), 0);
    // codex round-3 P2: overtime_minutes is never sent to a restricted
    // (technician) viewer (techSafeDailySummary) — reading it as 0
    // wouldn't fabricate a number, but the OT/regular split it drives
    // is still coworker performance framing, so skip the split (whole
    // bar renders as regular time) for that viewer.
    const otMin = isRestrictedViewer
      ? 0
      : Math.min(shiftMin, dayData.reduce((s, d) => s + parseFloat(d.overtime_minutes || 0), 0));
    const regMin = Math.max(0, shiftMin - otMin);
    return { day, shiftMin, regMin, otMin };
  });
  const maxMin = Math.max(480, ...dayRows.map((d) => d.shiftMin));

  return (
    <svg
      width="100%"
      height={top + barH + 30}
      viewBox={`0 0 ${7 * (barW + 12) + 20} ${top + barH + 30}`}
    >
      {dayRows.map(({ day, shiftMin, regMin, otMin }, i) => {
        const regH = Math.min((regMin / maxMin) * barH, barH);
        const otH = Math.min((otMin / maxMin) * barH, barH - regH);
        const x = i * (barW + 12) + 10;

        return (
          <g key={day}>
            {/* Regular time */}
            <rect
              x={x}
              y={top + barH - regH}
              width={barW}
              height={regH}
              fill={D.teal}
              rx={3}
              opacity={0.85}
            />
            {/* Overtime stacked */}
            {otH > 0 && (
              <rect
                x={x}
                y={top + barH - regH - otH}
                width={barW}
                height={otH}
                fill={D.red}
                rx={3}
                opacity={0.85}
              />
            )}
            {/* Hours label */}
            {shiftMin > 0 && (
              <text
                x={x + barW / 2}
                y={top + barH - regH - otH - 4}
                textAnchor="middle"
                fontSize={14}
                fill={D.muted}
                fontFamily={MONO}
              >
                {(shiftMin / 60).toFixed(1)}
              </text>
            )}
            {/* Day label */}
            <text
              x={x + barW / 2}
              y={top + barH + 20}
              textAnchor="middle"
              fontSize={14}
              fill={D.muted}
            >
              {day}
            </text>{" "}
          </g>
        );
      })}
    </svg>
  );
}
