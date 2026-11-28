import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { formatETTime } from "../../../lib/timezone";
import { addStaffCalendarDays as addDays, staffMondayET as getMonday } from "../../../lib/staffTimeDate";
import {
  API_BASE, D, MONO, DAYS, STATUS_COLORS, TYPE_COLORS,
  adminFetch, sCard, sBtn, sBadge, fmtHrs,
  paidMinutesOf, unpaidMinutesOf, thStyle, tdStyle, dayCellButton, LoadFailedNotice,
} from "./staffShared";

// =============================================================================
// TIMESHEET TAB
// =============================================================================
export function TimesheetTab({ showToast, onOpenApprovals }) {
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()));
  const [dailies, setDailies] = useState([]);
  const [techs, setTechs] = useState([]);
  const [expanded, setExpanded] = useState(null); // { techId, date }
  // null while the open day's entries load or after a failed read; only the
  // latest request may fill it, so a slow answer for another day never shows
  // under this day's heading.
  const [cellEntries, setCellEntries] = useState(null);
  const [cellLoadFailed, setCellLoadFailed] = useState(false);
  const cellRequestRef = useRef(0);
  const [loading, setLoading] = useState(true);
  // A failed week read shows a notice instead of a grid of "--" days.
  const [loadFailed, setLoadFailed] = useState(false);
  const loadRequestRef = useRef(0);

  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);

  const load = useCallback(async () => {
    const request = ++loadRequestRef.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const [dailyRes, dashRes] = await Promise.all([
        adminFetch(
          `/admin/timetracking/daily?startDate=${weekStart}&endDate=${weekEnd}`,
        ),
        adminFetch("/admin/timetracking"),
      ]);
      if (request !== loadRequestRef.current) return;
      setDailies(dailyRes);
      setTechs(dashRes.allTechs || []);
    } catch (e) {
      if (request !== loadRequestRef.current) return;
      // The rows on hand may belong to another week; drop them, and the
      // open day with them, so nothing shows under this week but the notice.
      setDailies([]);
      setTechs([]);
      cellRequestRef.current += 1;
      setExpanded(null);
      setLoadFailed(true);
      showToast("Failed to load timesheet");
    }
    setLoading(false);
  }, [weekStart, weekEnd]);

  useEffect(() => {
    load();
  }, [load]);

  // Another week closes the open day, including a read still on its way.
  useEffect(() => {
    cellRequestRef.current += 1;
    setExpanded(null);
  }, [weekStart]);

  const loadCellEntries = useCallback(async (techId, date) => {
    const request = ++cellRequestRef.current;
    setCellEntries(null);
    setCellLoadFailed(false);
    try {
      const res = await adminFetch(
        `/admin/timetracking/entries?technicianId=${techId}&startDate=${date}&endDate=${date}`,
      );
      if (request === cellRequestRef.current) setCellEntries(res.entries || []);
    } catch (e) {
      if (request === cellRequestRef.current) setCellLoadFailed(true);
    }
  }, []);

  const expandCell = useCallback(
    (techId, date) => {
      if (expanded && expanded.techId === techId && expanded.date === date) {
        cellRequestRef.current += 1;
        setExpanded(null);
        return;
      }
      setExpanded({ techId, date });
      loadCellEntries(techId, date);
    },
    [expanded, loadCellEntries],
  );

  const exportCSV = useCallback(() => {
    const token = localStorage.getItem("waves_admin_token");
    fetch(`${API_BASE}/admin/timesheets/export?weekStart=${weekStart}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (response) => {
        if (!response.ok) {
          let detail = `HTTP ${response.status}`;
          try {
            const body = await response.json();
            if (body?.error) detail = body.error;
          } catch { /* non-JSON error */ }
          throw new Error(detail);
        }
        return response.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `approved_payroll_week_${weekStart}.csv`;
        anchor.click();
        URL.revokeObjectURL(url);
      })
      .catch((e) => showToast(`Approved payroll export failed: ${e.message}`));
  }, [weekStart, showToast]);

  // Group dailies by tech
  const byTech = useMemo(() => {
    const map = {};
    techs.forEach((t) => {
      map[t.id] = { tech: t, days: {} };
    });
    dailies.forEach((d) => {
      const tid = d.technician_id;
      if (!map[tid])
        map[tid] = {
          tech: { id: tid, name: d.tech_name || "Unknown" },
          days: {},
        };
      const dateKey =
        typeof d.work_date === "string"
          ? d.work_date.split("T")[0]
          : d.work_date;
      map[tid].days[dateKey] = d;
    });
    return Object.values(map);
  }, [dailies, techs]);

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading...
      </div>
    );

  return (
    <div>
      {/* Week nav */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        {" "}
        <button
          onClick={() => setWeekStart(addDays(weekStart, -7))}
          style={sBtn(D.card, D.text)}
        >
          &#9664; Prev
        </button>{" "}
        <span
          style={{
            fontWeight: 500,
            color: D.heading,
            fontFamily: MONO,
            fontSize: 14,
          }}
        >
          {weekStart} to {weekEnd}
        </span>{" "}
        <button
          onClick={() => setWeekStart(addDays(weekStart, 7))}
          style={sBtn(D.card, D.text)}
        >
          Next &#9654;
        </button>{" "}
        <div style={{ flex: 1 }} />{" "}
        <button onClick={() => onOpenApprovals(weekStart)} style={sBtn(D.green, D.white)}>
          Review &amp; Approve Weeks
        </button>{" "}
        <button onClick={exportCSV} style={sBtn(D.teal, D.white)}>
          Export Approved CSV
        </button>{" "}
      </div>
      {loadFailed && (
        <LoadFailedNotice onRetry={load}>
          Could not load the timesheet for {weekStart} to {weekEnd}.
        </LoadFailedNotice>
      )}
      {/* Timesheet grid */}
      <div style={{ overflowX: "auto" }}>
        {" "}
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}
        >
          {" "}
          <thead>
            {" "}
            <tr style={{ background: D.card }}>
              {" "}
              <th style={thStyle}>Tech</th>
              {DAYS.map((d, i) => (
                <th key={d} style={thStyle}>
                  {d}
                  <br />
                  <span style={{ fontSize: 14, color: D.muted }}>
                    {addDays(weekStart, i).slice(5)}
                  </span>
                </th>
              ))}
              <th style={thStyle}>Total</th>{" "}
              <th style={thStyle}>OT</th>{" "}
              <th style={thStyle}>Status</th>{" "}
            </tr>{" "}
          </thead>{" "}
          <tbody>
            {byTech.map(({ tech, days }) => {
              let totalMin = 0,
                totalOT = 0;
              const allStatuses = [];
              DAYS.forEach((_, i) => {
                const dt = addDays(weekStart, i);
                const d = days[dt];
                if (d) {
                  totalMin += paidMinutesOf(d);
                  totalOT += parseFloat(d.overtime_minutes || 0);
                  allStatuses.push(d.status);
                }
              });
              const weekStatus = allStatuses.includes("disputed")
                ? "disputed"
                : allStatuses.includes("rejected")
                  ? "rejected"
                  : allStatuses.includes("pending") || allStatuses.includes("edited")
                    ? "pending"
                    : allStatuses.length > 0 &&
                        allStatuses.every((s) => s === "approved" || s === "exported")
                      ? "approved"
                      : "pending";

              return (
                <tr
                  key={tech.id}
                  style={{ borderBottom: `1px solid ${D.border}` }}
                >
                  {" "}
                  <td style={{ ...tdStyle, fontWeight: 500, color: D.heading }}>
                    {tech.name}
                  </td>
                  {DAYS.map((_, i) => {
                    const dt = addDays(weekStart, i);
                    const d = days[dt];
                    const hrs = d
                      ? (paidMinutesOf(d) / 60).toFixed(1)
                      : "--";
                    const lunchMin = d ? unpaidMinutesOf(d) : 0;
                    const color = !d
                      ? D.muted
                      : d.status === "approved"
                        ? D.green
                        : d.status === "edited" || d.status === "pending"
                          ? D.amber
                          : D.red;
                    const lunchNote = !d
                      ? ""
                      : lunchMin > 0
                        ? `lunch -${(lunchMin / 60).toFixed(1)}`
                        : d.no_lunch
                          ? "no lunch"
                          : "";
                    const isExp =
                      !!expanded &&
                      expanded.techId === tech.id &&
                      expanded.date === dt;
                    return (
                      <td
                        key={dt}
                        style={{
                          ...tdStyle,
                          background: isExp ? D.input : "transparent",
                        }}
                      >
                        {/* A button, so the day opens from the keyboard too. */}
                        <button
                          type="button"
                          aria-expanded={isExp}
                          aria-label={`${tech.name}, ${DAYS[i]} ${dt}: ${d ? `${hrs} hours` : "no time"}${lunchNote ? `, ${lunchNote}` : ""}`}
                          onClick={() => expandCell(tech.id, dt)}
                          style={dayCellButton}
                        >
                          <span
                            style={{ color, fontFamily: MONO, fontWeight: 500 }}
                          >
                            {hrs}
                          </span>
                          {lunchNote && (
                            <span
                              style={{
                                display: "block",
                                fontSize: 14,
                                color: D.muted,
                              }}
                            >
                              {lunchNote}
                            </span>
                          )}
                        </button>
                      </td>
                    );
                  })}
                  <td
                    style={{
                      ...tdStyle,
                      fontFamily: MONO,
                      fontWeight: 700,
                      color: D.heading,
                    }}
                  >
                    {(totalMin / 60).toFixed(1)}
                  </td>{" "}
                  <td
                    style={{
                      ...tdStyle,
                      fontFamily: MONO,
                      fontWeight: 700,
                      color: totalOT > 0 ? D.red : D.muted,
                    }}
                  >
                    {(totalOT / 60).toFixed(1)}
                  </td>{" "}
                  <td style={tdStyle}>
                    {" "}
                    <span
                      style={sBadge(
                        (STATUS_COLORS[weekStatus] || D.muted) + "22",
                        STATUS_COLORS[weekStatus] || D.muted,
                      )}
                    >
                      {weekStatus.toUpperCase()}
                    </span>{" "}
                  </td>{" "}
                </tr>
              );
            })}
          </tbody>{" "}
        </table>{" "}
      </div>
      {/* Expanded cell entries */}
      {expanded && (
        <div style={{ ...sCard, marginTop: 12 }}>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: D.heading,
              marginBottom: 8,
            }}
          >
            Entries for {expanded.date}
          </div>
          {cellLoadFailed ? (
            <div role="alert" style={{ color: D.red, fontSize: 14 }}>
              Could not load this day's entries.{" "}
              <button
                type="button"
                onClick={() => loadCellEntries(expanded.techId, expanded.date)}
                style={sBtn(D.card, D.text)}
              >
                Retry
              </button>
            </div>
          ) : cellEntries === null ? (
            <div role="status" style={{ color: D.muted, fontSize: 14 }}>
              Loading entries…
            </div>
          ) : cellEntries.length === 0 ? (
            <div style={{ color: D.muted, fontSize: 14 }}>No entries</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 14,
              }}
            >
              {" "}
              <thead>
                {" "}
                <tr>
                  {[
                    "Type",
                    "Clock In",
                    "Clock Out",
                    "Duration",
                    "Customer",
                    "Status",
                  ].map((h) => (
                    <th key={h} style={{ ...thStyle, fontSize: 14 }}>
                      {h}
                    </th>
                  ))}
                </tr>{" "}
              </thead>{" "}
              <tbody>
                {cellEntries.map((e) => (
                  <tr
                    key={e.id}
                    style={{ borderBottom: `1px solid ${D.border}` }}
                  >
                    {" "}
                    <td style={tdStyle}>
                      <span
                        style={sBadge(
                          (TYPE_COLORS[e.entry_type] || D.muted) + "22",
                          TYPE_COLORS[e.entry_type] || D.muted,
                        )}
                      >
                        {e.entry_type}
                      </span>
                      {e.source === "geofence_auto" && (
                        <span
                          title="Clocked in automatically on arrival at the first stop"
                          data-testid="auto-clock-in-badge"
                          style={{ ...sBadge(D.muted + "22", D.muted), marginLeft: 4 }}
                        >
                          auto
                        </span>
                      )}
                    </td>{" "}
                    <td style={{ ...tdStyle, fontFamily: MONO, fontSize: 14 }}>
                      {e.clock_in ? formatETTime(e.clock_in) : "--"}
                    </td>{" "}
                    <td style={{ ...tdStyle, fontFamily: MONO, fontSize: 14 }}>
                      {e.clock_out ? formatETTime(e.clock_out) : "--"}
                    </td>{" "}
                    <td style={{ ...tdStyle, fontFamily: MONO }}>
                      {e.duration_minutes ? fmtHrs(e.duration_minutes) : "--"}
                    </td>{" "}
                    <td style={tdStyle}>
                      {e.customer_first_name
                        ? `${e.customer_first_name} ${e.customer_last_name || ""}`.trim()
                        : "--"}
                    </td>{" "}
                    <td style={tdStyle}>
                      <span
                        style={sBadge(
                          (STATUS_COLORS[e.status] || D.muted) + "22",
                          STATUS_COLORS[e.status] || D.muted,
                        )}
                      >
                        {e.status}
                      </span>
                    </td>{" "}
                  </tr>
                ))}
              </tbody>{" "}
            </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
