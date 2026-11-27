import { useState, useEffect, useCallback, useRef } from "react";
import useIsMobile from "../../../hooks/useIsMobile";
import { etDateString } from "../../../lib/timezone";
import { addStaffCalendarDays as addDays } from "../../../lib/staffTimeDate";
import {
  D, MONO, LABOR_RATE,
  adminFetch, sCard, sBadge, sInput, fmt, errMessage, ymdOnly, thStyle, tdStyle, LoadFailedNotice,
} from "./staffShared";

// =============================================================================
// ANALYTICS TAB
// =============================================================================
export function AnalyticsTab() {
  const [data, setData] = useState(null);
  const [comparison, setComparison] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const reqSeqRef = useRef(0);
  const [range, setRange] = useState({
    start: addDays(etDateString(), -30),
    end: etDateString(),
  });

  const load = useCallback(() => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setLoadError("");
    Promise.all([
      adminFetch(
        `/admin/timetracking/analytics?startDate=${range.start}&endDate=${range.end}`,
      ),
      adminFetch(
        `/admin/timetracking/analytics/comparison?startDate=${range.start}&endDate=${range.end}`,
      ),
    ])
      .then(([ana, cmp]) => {
        if (seq !== reqSeqRef.current) return;
        setData(ana);
        setComparison(cmp);
      })
      .catch((e) => {
        if (seq !== reqSeqRef.current) return;
        setLoadError(errMessage(e, "Failed to load analytics"));
      })
      .finally(() => {
        if (seq === reqSeqRef.current) setLoading(false);
      });
  }, [range]);

  useEffect(() => {
    load();
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
        {loadError || "Failed to load analytics"}
      </LoadFailedNotice>
    );

  const { serviceTypeStats, rpmhByTech, overtimeTrend } = data;
  // Older server responses carry neither field.
  const efficiencyByTech = data.efficiencyByTech || [];
  const loadAheadWeeks = (data.loadAhead && data.loadAhead.weeks) || [];
  const loadAheadTrailing = (data.loadAhead && data.loadAhead.trailing) || null;
  const effColor = (pct) =>
    pct >= 70 ? D.green : pct >= 50 ? D.amber : D.red;
  const hrs = (min) => (parseFloat(min || 0) / 60).toFixed(1);

  // Compute RPMH aggregates per tech
  const rpmhMap = {};
  (rpmhByTech || []).forEach((r) => {
    if (!rpmhMap[r.technician_id])
      rpmhMap[r.technician_id] = { name: r.tech_name, weeks: [] };
    rpmhMap[r.technician_id].weeks.push(r);
  });

  // Build utilization trend data (12 weeks)
  const utilTrend = {};
  (overtimeTrend || []).forEach((o) => {
    const wk = ymdOnly(o.week_start);
    if (!utilTrend[wk])
      utilTrend[wk] = { week: wk, util: [], ot: 0 };
    utilTrend[wk].util.push(parseFloat(o.utilization_pct || 0));
    utilTrend[wk].ot += parseFloat(o.overtime_minutes || 0);
  });
  const utilWeeks = Object.values(utilTrend).sort((a, b) =>
    a.week < b.week ? -1 : 1,
  );

  return (
    <div>
      {loadError && (
        <LoadFailedNotice onRetry={load}>
          Could not refresh analytics: {loadError}
        </LoadFailedNotice>
      )}
      {/* Date range */}
      <div
        style={{
          ...sCard,
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "flex-end",
        }}
      >
        {" "}
        <div>
          {" "}
          <label
            style={{
              fontSize: 14,
              color: D.muted,
              display: "block",
              marginBottom: 2,
            }}
          >
            Start
          </label>{" "}
          <input
            type="date"
            value={range.start}
            onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
            style={sInput}
          />{" "}
        </div>{" "}
        <div>
          {" "}
          <label
            style={{
              fontSize: 14,
              color: D.muted,
              display: "block",
              marginBottom: 2,
            }}
          >
            End
          </label>{" "}
          <input
            type="date"
            value={range.end}
            onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))}
            style={sInput}
          />{" "}
        </div>{" "}
      </div>
      {/* Actual vs Estimated */}
      <div
        style={{
          fontSize: 15,
          fontWeight: 500,
          color: D.heading,
          marginBottom: 12,
        }}
      >
        Actual vs Estimated by Service Type
      </div>{" "}
      <div style={sCard}>
        {serviceTypeStats.length === 0 ? (
          <div style={{ color: D.muted, fontSize: 14 }}>
            No job data in this period
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}
          >
            {" "}
            <thead>
              {" "}
              <tr>
                {[
                  "Service Type",
                  "Jobs",
                  "Avg Est (min)",
                  "Avg Actual (min)",
                  "Variance",
                  "Accuracy",
                ].map((h) => (
                  <th key={h} style={thStyle}>
                    {h}
                  </th>
                ))}
              </tr>{" "}
            </thead>{" "}
            <tbody>
              {serviceTypeStats.map((s) => {
                const hasEst = s.avg_estimated != null && Number.isFinite(parseFloat(s.avg_estimated));
                const est = hasEst ? parseFloat(s.avg_estimated) : null;
                const act = parseFloat(s.avg_actual || 0);
                const variance = hasEst ? act - est : null;
                const accuracy =
                  hasEst && est > 0
                    ? Math.max(0, Math.min(100, (1 - Math.abs(variance) / est) * 100))
                    : null;
                return (
                  <tr
                    key={s.svc_type}
                    style={{ borderBottom: `1px solid ${D.border}` }}
                  >
                    {" "}
                    <td style={{ ...tdStyle, fontWeight: 500 }}>
                      {s.svc_type}
                    </td>{" "}
                    <td style={{ ...tdStyle, fontFamily: MONO }}>
                      {s.job_count}
                    </td>{" "}
                    <td style={{ ...tdStyle, fontFamily: MONO }}>
                      {hasEst ? est.toFixed(0) : "—"}
                    </td>{" "}
                    <td style={{ ...tdStyle, fontFamily: MONO }}>
                      {act.toFixed(0)}
                    </td>{" "}
                    <td
                      style={{
                        ...tdStyle,
                        fontFamily: MONO,
                        color: variance == null ? D.muted : variance > 0 ? D.red : D.green,
                      }}
                    >
                      {variance == null ? "—" : `${variance > 0 ? "+" : ""}${variance.toFixed(0)}`}
                    </td>{" "}
                    <td
                      style={{
                        ...tdStyle,
                        fontFamily: MONO,
                        color:
                          accuracy == null
                            ? D.muted
                            : accuracy >= 80
                              ? D.green
                              : accuracy >= 60
                                ? D.amber
                                : D.red,
                      }}
                    >
                      {accuracy == null ? "—" : `${accuracy.toFixed(0)}%`}
                    </td>{" "}
                  </tr>
                );
              })}
            </tbody>{" "}
          </table>
          </div>
        )}
      </div>
      {/* Per-tech comparison */}
      <div
        style={{
          fontSize: 15,
          fontWeight: 500,
          color: D.heading,
          marginBottom: 12,
        }}
      >
        Per-Tech Service Time Comparison
      </div>{" "}
      <div style={sCard}>
        {comparison.length === 0 ? (
          <div style={{ color: D.muted, fontSize: 14 }}>No comparison data</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}
          >
            {" "}
            <thead>
              {" "}
              <tr>
                {[
                  "Tech",
                  "Service Type",
                  "Jobs",
                  "Avg Est",
                  "Avg Actual",
                  "Variance",
                ].map((h) => (
                  <th key={h} style={thStyle}>
                    {h}
                  </th>
                ))}
              </tr>{" "}
            </thead>{" "}
            <tbody>
              {comparison.map((c, i) => {
                const hasEst = c.avg_estimated != null && Number.isFinite(parseFloat(c.avg_estimated));
                const est = hasEst ? parseFloat(c.avg_estimated) : null;
                const act = parseFloat(c.avg_actual || 0);
                const v = hasEst ? act - est : null;
                return (
                  <tr key={i} style={{ borderBottom: `1px solid ${D.border}` }}>
                    {" "}
                    <td style={tdStyle}>{c.tech_name}</td>{" "}
                    <td style={tdStyle}>{c.svc_type}</td>{" "}
                    <td style={{ ...tdStyle, fontFamily: MONO }}>
                      {c.job_count}
                    </td>{" "}
                    <td style={{ ...tdStyle, fontFamily: MONO }}>
                      {hasEst ? `${est.toFixed(0)} min` : "—"}
                    </td>{" "}
                    <td style={{ ...tdStyle, fontFamily: MONO }}>
                      {act.toFixed(0)} min
                    </td>{" "}
                    <td
                      style={{
                        ...tdStyle,
                        fontFamily: MONO,
                        color: v == null ? D.muted : v > 0 ? D.red : D.green,
                      }}
                    >
                      {v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(0)} min`}
                    </td>{" "}
                  </tr>
                );
              })}
            </tbody>{" "}
          </table>
          </div>
        )}
      </div>
      {/* Efficiency (budget / clocked) */}
      <div
        style={{
          fontSize: 15,
          fontWeight: 500,
          color: D.heading,
          marginBottom: 12,
        }}
      >
        Efficiency (budget ÷ clocked)
      </div>{" "}
      <div style={sCard}>
        {efficiencyByTech.length === 0 ? (
          <div style={{ color: D.muted, fontSize: 14 }}>
            No efficiency data yet
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}
          >
            {" "}
            <thead>
              {" "}
              <tr>
                {[
                  "Tech",
                  "Budget hrs",
                  "Clocked hrs",
                  "Efficiency %",
                  "Jobs with a budget",
                ].map((h) => (
                  <th key={h} style={thStyle}>
                    {h}
                  </th>
                ))}
              </tr>{" "}
            </thead>{" "}
            <tbody>
              {efficiencyByTech.map((e) => (
                <tr
                  key={e.technician_id}
                  style={{ borderBottom: `1px solid ${D.border}` }}
                >
                  {" "}
                  <td style={{ ...tdStyle, fontWeight: 500 }}>{e.tech_name}</td>{" "}
                  <td style={{ ...tdStyle, fontFamily: MONO }}>
                    {hrs(e.budget_minutes)}
                  </td>{" "}
                  <td style={{ ...tdStyle, fontFamily: MONO }}>
                    {hrs(e.shift_minutes)}
                  </td>{" "}
                  <td
                    style={{
                      ...tdStyle,
                      fontFamily: MONO,
                      color:
                        e.efficiency_pct == null
                          ? D.muted
                          : effColor(e.efficiency_pct),
                    }}
                  >
                    {e.efficiency_pct == null ? "—" : `${e.efficiency_pct}%`}
                  </td>{" "}
                  <td style={{ ...tdStyle, fontFamily: MONO }}>
                    {e.jobs_with_budget || 0} of {e.jobs || 0}
                  </td>{" "}
                </tr>
              ))}
            </tbody>{" "}
          </table>
          </div>
        )}
        <div style={{ color: D.muted, fontSize: 14, marginTop: 8 }}>
          Budget = planned minutes for the stops done. Clocked = whole shift.
          70–90% is normal, 90%+ is elite, under 50% means half the day is
          drive, load or waiting.
        </div>
      </div>
      {/* Booked ahead */}
      <div
        style={{
          fontSize: 15,
          fontWeight: 500,
          color: D.heading,
          marginBottom: 12,
        }}
      >
        Booked Ahead
      </div>{" "}
      <div style={sCard}>
        {loadAheadWeeks.length === 0 ? (
          <div style={{ color: D.muted, fontSize: 14 }}>
            No booked-ahead data
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}
          >
            {" "}
            <thead>
              {" "}
              <tr>
                {["Week of", "Stops", "Planned hours"].map((h) => (
                  <th key={h} style={thStyle}>
                    {h}
                  </th>
                ))}
              </tr>{" "}
            </thead>{" "}
            <tbody>
              {loadAheadWeeks.map((w) => (
                <tr
                  key={w.week_start}
                  style={{ borderBottom: `1px solid ${D.border}` }}
                >
                  {" "}
                  <td style={tdStyle}>{w.week_start}</td>{" "}
                  <td style={{ ...tdStyle, fontFamily: MONO }}>
                    {w.stops || 0}
                  </td>{" "}
                  <td style={{ ...tdStyle, fontFamily: MONO }}>
                    {hrs(w.planned_minutes)}
                  </td>{" "}
                </tr>
              ))}
            </tbody>{" "}
          </table>
          </div>
        )}
        {loadAheadTrailing &&
          loadAheadTrailing.avg_job_minutes_per_week != null && (
            <div style={{ color: D.muted, fontSize: 14, marginTop: 8 }}>
              Last {loadAheadTrailing.weeks || 4} weeks averaged{" "}
              {hrs(loadAheadTrailing.avg_job_minutes_per_week)} job hours and{" "}
              {hrs(loadAheadTrailing.avg_shift_minutes_per_week)} shift hours
              per week.
            </div>
          )}
      </div>
      {/* RPMH by Tech */}
      <div
        style={{
          fontSize: 15,
          fontWeight: 500,
          color: D.heading,
          marginBottom: 12,
        }}
      >
        Revenue Per Man-Hour (RPMH)
      </div>{" "}
      <div style={sCard}>
        {Object.keys(rpmhMap).length === 0 ? (
          <div style={{ color: D.muted, fontSize: 14 }}>No RPMH data yet</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}
          >
            {" "}
            <thead>
              {" "}
              <tr>
                {[
                  "Tech",
                  "Latest Week",
                  "4-Week Avg",
                  "vs $35 Benchmark",
                  "Status",
                ].map((h) => (
                  <th key={h} style={thStyle}>
                    {h}
                  </th>
                ))}
              </tr>{" "}
            </thead>{" "}
            <tbody>
              {Object.values(rpmhMap).map(({ name, weeks }) => {
                const sortedWeeks = [...weeks].sort((a, b) =>
                  ymdOnly(a.week_start).localeCompare(ymdOnly(b.week_start)),
                );
                const latest = sortedWeeks[sortedWeeks.length - 1];
                const totalRev = sortedWeeks.reduce((s, w) => s + parseFloat(w.total_revenue || 0), 0);
                const totalShiftMin = sortedWeeks.reduce((s, w) => s + parseFloat(w.total_shift_minutes || 0), 0);
                const avg4 =
                  totalShiftMin > 0
                    ? totalRev / (totalShiftMin / 60)
                    : sortedWeeks.length > 0
                      ? sortedWeeks.reduce((s, w) => s + parseFloat(w.avg_rpmh || 0), 0) / sortedWeeks.length
                      : 0;
                const vsTarget = avg4 - LABOR_RATE;
                const color =
                  vsTarget >= 0 ? D.green : vsTarget >= -10 ? D.amber : D.red;
                return (
                  <tr
                    key={name}
                    style={{ borderBottom: `1px solid ${D.border}` }}
                  >
                    {" "}
                    <td style={{ ...tdStyle, fontWeight: 500 }}>{name}</td>{" "}
                    <td style={{ ...tdStyle, fontFamily: MONO }}>
                      {fmt(latest?.avg_rpmh)}
                    </td>{" "}
                    <td style={{ ...tdStyle, fontFamily: MONO }}>
                      {fmt(avg4)}
                    </td>{" "}
                    <td style={{ ...tdStyle, fontFamily: MONO, color }}>
                      {vsTarget >= 0 ? "+" : ""}
                      {fmt(vsTarget)}
                    </td>{" "}
                    <td style={tdStyle}>
                      <span style={sBadge(color + "22", color)}>
                        {vsTarget >= 0 ? "ABOVE BENCHMARK" : "BELOW BENCHMARK"}
                      </span>
                    </td>{" "}
                  </tr>
                );
              })}
            </tbody>{" "}
          </table>
          </div>
        )}
      </div>
      {/* Utilization Trend - SVG Line Chart */}
      <div
        style={{
          fontSize: 15,
          fontWeight: 500,
          color: D.heading,
          marginBottom: 12,
        }}
      >
        Utilization Trend (12 Weeks)
      </div>{" "}
      <div style={sCard}>
        {utilWeeks.length === 0 ? (
          <div style={{ color: D.muted, fontSize: 14 }}>No trend data yet</div>
        ) : (
          <UtilizationLineChart weeks={utilWeeks} />
        )}
      </div>
      {/* Overtime by Tech */}
      <div
        style={{
          fontSize: 15,
          fontWeight: 500,
          color: D.heading,
          marginBottom: 12,
        }}
      >
        Weekly Overtime
      </div>{" "}
      <div style={sCard}>
        {(overtimeTrend || []).length === 0 ? (
          <div style={{ color: D.muted, fontSize: 14 }}>No overtime data</div>
        ) : (
          <OvertimeTable data={overtimeTrend || []} />
        )}
      </div>{" "}
    </div>
  );
}

function UtilizationLineChart({ weeks }) {
  const isMobile = useIsMobile(640);
  const w = isMobile ? 300 : 600;
  const h = 150;
  const pad = { t: 20, r: 20, b: 30, l: 44 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;

  const maxUtil = 100;
  const points = weeks.map((wk, i) => {
    const rawUtil =
      wk.util.length > 0
        ? wk.util.reduce((a, b) => a + b, 0) / wk.util.length
        : 0;
    const avgUtil = Math.max(0, Math.min(maxUtil, rawUtil));
    const x = pad.l + (i / Math.max(weeks.length - 1, 1)) * innerW;
    const y = pad.t + innerH - (avgUtil / maxUtil) * innerH;
    return { x, y, util: avgUtil, week: ymdOnly(wk.week) };
  });

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
    .join(" ");

  return (
    <svg
      width="100%"
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ overflow: "visible" }}
    >
      {/* Grid lines */}
      {[0, 25, 50, 75, 100].map((v) => {
        const y = pad.t + innerH - (v / maxUtil) * innerH;
        return (
          <g key={v}>
            {" "}
            <line
              x1={pad.l}
              y1={y}
              x2={w - pad.r}
              y2={y}
              stroke={D.border}
              strokeWidth={0.5}
            />{" "}
            <text
              x={pad.l - 4}
              y={y + 5}
              textAnchor="end"
              fontSize={14}
              fill={D.muted}
            >
              {v}%
            </text>{" "}
          </g>
        );
      })}
      {/* Target line at 70% */}
      <line
        x1={pad.l}
        y1={pad.t + innerH - (70 / maxUtil) * innerH}
        x2={w - pad.r}
        y2={pad.t + innerH - (70 / maxUtil) * innerH}
        stroke={D.green}
        strokeWidth={1}
        strokeDasharray="4 3"
        opacity={0.5}
      />{" "}
      {/* Inside the plot, above the line: a 14px label past the right
          edge would widen the page on a phone. */}
      <text
        x={pad.l + 4}
        y={pad.t + innerH - (70 / maxUtil) * innerH - 4}
        fontSize={14}
        fill={D.green}
      >
        70% target
      </text>
      {/* Line */}
      <path d={pathD} fill="none" stroke={D.teal} strokeWidth={2} />
      {/* Dots + labels */}
      {points.map((p, i) => (
        <g key={i}>
          {" "}
          <circle cx={p.x} cy={p.y} r={3} fill={D.teal} />
          {i % (isMobile ? 3 : 2) === 0 && (
            <text
              x={p.x}
              y={h - 5}
              textAnchor="middle"
              fontSize={14}
              fill={D.muted}
            >
              {p.week.slice(5)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

function OvertimeTable({ data }) {
  // Group by tech
  const byTech = {};
  data.forEach((o) => {
    const key = o.tech_name || "Unknown";
    if (!byTech[key]) byTech[key] = [];
    byTech[key].push(o);
  });

  return (
    <div style={{ overflowX: "auto" }}>
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
      {" "}
      <thead>
        {" "}
        <tr>
          {["Tech", "Week", "OT Hours", "Flag"].map((h) => (
            <th key={h} style={thStyle}>
              {h}
            </th>
          ))}
        </tr>{" "}
      </thead>{" "}
      <tbody>
        {Object.entries(byTech).map(([name, rows]) =>
          rows
            .filter((r) => parseFloat(r.overtime_minutes || 0) > 0)
            .map((r, i) => {
              const otHrs = parseFloat(r.overtime_minutes || 0) / 60;
              return (
                <tr
                  key={`${name}-${i}`}
                  style={{ borderBottom: `1px solid ${D.border}` }}
                >
                  {" "}
                  <td style={tdStyle}>{name}</td>{" "}
                  <td style={tdStyle}>{r.week_start}</td>{" "}
                  <td
                    style={{
                      ...tdStyle,
                      fontFamily: MONO,
                      color: otHrs > 5 ? D.red : D.amber,
                    }}
                  >
                    {otHrs.toFixed(1)}
                  </td>{" "}
                  <td style={tdStyle}>
                    {otHrs > 5 ? (
                      <span style={sBadge(D.red + "22", D.red)}>HIGH OT</span>
                    ) : (
                      <span style={sBadge(D.amber + "22", D.amber)}>OT</span>
                    )}
                  </td>{" "}
                </tr>
              );
            }),
        )}
        {Object.values(byTech).every((rows) =>
          rows.every((r) => parseFloat(r.overtime_minutes || 0) === 0),
        ) && (
          <tr>
            <td
              colSpan={4}
              style={{ ...tdStyle, textAlign: "center", color: D.muted }}
            >
              No overtime recorded
            </td>
          </tr>
        )}
      </tbody>{" "}
    </table>
    </div>
  );
}
