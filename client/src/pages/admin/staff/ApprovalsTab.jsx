import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { formatETTime, formatETDate, formatETDateTime } from "../../../lib/timezone";
import { addStaffCalendarDays as addDays, staffMondayET as getMonday } from "../../../lib/staffTimeDate";
import {
  API_BASE, D, MONO,
  adminFetch, sCard, sBtn, sBadge, fmt, fmtHrs, fmtPct, errMessage, ymdOnly,
  unpaidMinutesOf, LoadFailedNotice,
} from "./staffShared";

// ===========================================================================
// ApprovalsTab — weekly timesheet approval workflow
// ===========================================================================
// The weekStart a bell link carries: used only when it is a real YYYY-MM-DD Monday.
function mondayFromParam(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCDay() === 1 && addDays(value, 0) === value ? value : null;
}

export function ApprovalsTab({ showToast, weekStartParam = null }) {
  const lastMonday = useMemo(() => {
    return addDays(getMonday(new Date()), -7);
  }, []);
  const linkedWeek = mondayFromParam(weekStartParam);
  const [weekStart, setWeekStart] = useState(linkedWeek || lastMonday);
  // A bell clicked while this page is open changes the parameter: follow it.
  useEffect(() => {
    if (linkedWeek) setWeekStart(linkedWeek);
  }, [linkedWeek]);
  const [techs, setTechs] = useState([]);
  // The week the cards in `techs` were read for. Cards and their actions show
  // only while it is the week on screen and the last read did not fail, so a
  // failed week switch never leaves the previous week's cards under the new
  // heading.
  const [loadedWeek, setLoadedWeek] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const loadRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [expanded, setExpanded] = useState(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const weekStartRef = useRef(weekStart);
  weekStartRef.current = weekStart;
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [busyTechId, setBusyTechId] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    const request = ++loadRequestRef.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const data = await adminFetch(
        `/admin/timesheets/pending?weekStart=${weekStart}`,
      );
      if (request !== loadRequestRef.current) return;
      setTechs(data.techs || []);
      setLoadedWeek(weekStart);
      setSelected(new Set());
    } catch (e) {
      if (request !== loadRequestRef.current) return;
      setLoadFailed(true);
      showToast(`Load failed: ${errMessage(e)}`);
    } finally {
      if (request === loadRequestRef.current) setLoading(false);
    }
  }, [weekStart, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  // Another week drops the old week's selection and open detail at once,
  // including a detail read still on its way.
  useEffect(() => {
    detailRequestRef.current += 1;
    setSelected(new Set());
    setExpanded(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailError("");
  }, [weekStart]);

  const refreshDetail = useCallback(async (techId) => {
    const request = ++detailRequestRef.current;
    setExpanded(techId);
    setDetailLoading(true);
    setDetailError("");
    try {
      const d = await adminFetch(
        `/admin/timesheets/week-detail?technicianId=${techId}&weekStart=${weekStart}`,
      );
      if (request === detailRequestRef.current) {
        setDetail(d);
        setDetailError("");
      }
    } catch (e) {
      if (request === detailRequestRef.current) {
        const msg = errMessage(e);
        setDetailError(msg);
        showToast(`Detail load failed: ${msg}`);
      }
    } finally {
      if (request === detailRequestRef.current) setDetailLoading(false);
    }
  }, [weekStart, showToast]);

  const loadDetail = async (techId) => {
    if (expanded === techId) {
      detailRequestRef.current += 1;
      setExpanded(null);
      setDetail(null);
      setDetailLoading(false);
      setDetailError("");
      return;
    }
    setDetail(null);
    await refreshDetail(techId);
  };

  const toggleSelect = (id) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const current = loadedWeek === weekStart && !loadFailed;
  const rows = current ? techs : [];

  const selectAllPending = () => {
    setSelected(
      new Set(
        rows
          .filter((t) => t.status !== "approved")
          .map((t) => t.technician_id),
      ),
    );
  };

  const refreshAfterMutation = (actionWeek, techId = null) => {
    if (weekStartRef.current !== actionWeek) return undefined;
    load();
    if (techId && expandedRef.current === techId) {
      return refreshDetail(techId);
    }
    return undefined;
  };

  const approveOne = async (techId) => {
    if (busyTechId || bulkBusy) return;
    setBusyTechId(techId);
    try {
      const reviewToken = techs.find(
        (candidate) => candidate.technician_id === techId,
      )?.review_token;
      await adminFetch("/admin/timesheets/approve", {
        method: "POST",
        body: { technicianId: techId, weekStart, reviewToken },
      });
      showToast("Week approved");
      refreshAfterMutation(weekStart, techId);
    } catch (e) {
      showToast(`Approve failed: ${errMessage(e)}`);
    } finally {
      setBusyTechId(null);
    }
  };

  const bulkApprove = async () => {
    if (!selected.size || bulkBusy) return;
    if (
      !confirm(
        `Approve ${selected.size} tech week${selected.size === 1 ? "" : "s"}?`,
      )
    )
      return;
    setBulkBusy(true);
    try {
      const r = await adminFetch("/admin/timesheets/bulk-approve", {
        method: "POST",
        body: {
          technicianIds: [...selected],
          weekStart,
          reviewTokens: Object.fromEntries(
            techs
              .filter((candidate) => selected.has(candidate.technician_id))
              .map((candidate) => [candidate.technician_id, candidate.review_token]),
          ),
        },
      });
      const failedSummary = r.failed?.length
        ? `, ${r.failed.length} failed (${r.failed.map((f) => f.error).filter(Boolean).slice(0, 2).join("; ")})`
        : "";
      showToast(`Approved ${r.approved}${failedSummary}`, { error: r.approved === 0 && (r.failed?.length || 0) > 0 });
      refreshAfterMutation(weekStart);
    } catch (e) {
      showToast(`Bulk approve failed: ${errMessage(e)}`);
    } finally {
      setBulkBusy(false);
    }
  };

  const unlock = async (techId) => {
    if (busyTechId || bulkBusy) return;
    const reason = prompt("Reason for unlocking this week?");
    if (!reason || !reason.trim()) return;
    setBusyTechId(techId);
    try {
      const reviewToken = techs.find(
        (candidate) => candidate.technician_id === techId,
      )?.review_token;
      await adminFetch("/admin/timesheets/unlock", {
        method: "POST",
        body: { technicianId: techId, weekStart, reason: reason.trim(), reviewToken },
      });
      showToast("Week unlocked");
      refreshAfterMutation(weekStart, techId);
    } catch (e) {
      showToast(`Unlock failed: ${errMessage(e)}`);
    } finally {
      setBusyTechId(null);
    }
  };

  const disputeEntry = async (entryId) => {
    const reason = prompt("Reason for disputing this entry?");
    if (!reason || !reason.trim()) return;
    const targetTechId = expandedRef.current;
    try {
      await adminFetch("/admin/timesheets/dispute", {
        method: "POST",
        body: { entryId, reason: reason.trim() },
      });
      showToast("Entry disputed");
      await refreshAfterMutation(weekStart, targetTechId);
    } catch (e) {
      showToast(`Dispute failed: ${errMessage(e)}`);
    }
  };

  // Confirm an automatic clock-out as it stands (GATE_SHIFT_CLOSE_REVIEW).
  const confirmAutoClose = async (entryId) => {
    const targetTechId = expandedRef.current;
    try {
      await adminFetch(`/admin/timetracking/entries/${entryId}/confirm-auto-close`, {
        method: "POST",
      });
      showToast("Clock-out confirmed");
      await refreshAfterMutation(weekStart, targetTechId);
    } catch (e) {
      showToast(`Confirm failed: ${errMessage(e)}`);
    }
  };

  const exportCsv = () => {
    const token = localStorage.getItem("waves_admin_token");
    fetch(`${API_BASE}/admin/timesheets/export?weekStart=${weekStart}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (!r.ok) {
          let msg = `HTTP ${r.status}`;
          try {
            const body = await r.json();
            if (body?.error) msg = body.error;
          } catch { /* non-JSON error */ }
          throw new Error(msg);
        }
        return r.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `payroll_week_${weekStart}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch((e) => showToast(`Export failed: ${e.message}`));
  };

  const totalOT =
    rows.reduce((s, t) => s + parseFloat(t.overtime_minutes || 0), 0) / 60;
  const pendingCount = rows.filter((t) => t.status !== "approved").length;

  return (
    <div>
      {/* Week nav + actions */}
      <div
        style={{
          ...sCard,
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        {" "}
        <button
          onClick={() => setWeekStart(addDays(weekStart, -7))}
          style={sBtn(D.card, D.text)}
        >
          ← Prev
        </button>{" "}
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: D.heading,
            fontFamily: MONO,
          }}
        >
          Week of {weekStart}
        </div>{" "}
        <button
          onClick={() => setWeekStart(addDays(weekStart, 7))}
          style={sBtn(D.card, D.text)}
        >
          Next →
        </button>{" "}
        <button
          onClick={() => setWeekStart(lastMonday)}
          style={sBtn(D.card, D.muted)}
        >
          Last Week
        </button>{" "}
        <div style={{ flex: 1 }} />{" "}
        <button onClick={exportCsv} style={sBtn(D.purple, D.white)}>
          Export Payroll CSV
        </button>{" "}
      </div>
      {/* Overtime banner */}
      {totalOT > 0 && (
        <div
          style={{
            ...sCard,
            background: "#FEF3C7",
            border: `1px solid ${D.amber}`,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          {" "}
          <span style={{ fontSize: 18 }}>{"\u26A0\uFE0F"}</span>{" "}
          <div style={{ fontSize: 14, color: "#78350F" }}>
            {" "}
            <strong>{totalOT.toFixed(1)}h overtime</strong>across the team this
            week. Review before approving.
          </div>{" "}
        </div>
      )}

      {/* Summary + bulk bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        {" "}
        <div style={{ fontSize: 14, color: D.muted }}>
          {loading
            ? "Loading…"
            : current
              ? `${rows.length} tech${rows.length === 1 ? "" : "s"} · ${pendingCount} pending`
              : ""}
        </div>{" "}
        <div style={{ flex: 1 }} />
        {pendingCount > 0 && (
          <button onClick={selectAllPending} style={sBtn(D.card, D.teal)}>
            Select all pending
          </button>
        )}
        {current && selected.size > 0 && (
          <button
            onClick={bulkApprove}
            disabled={bulkBusy}
            style={{ ...sBtn(D.green, D.white), opacity: bulkBusy ? 0.6 : 1 }}
          >
            {bulkBusy ? "Approving…" : `Approve ${selected.size} selected`}
          </button>
        )}
      </div>
      {loadFailed && !loading && (
        <LoadFailedNotice onRetry={load}>
          Could not load timesheets for week of {weekStart}.
        </LoadFailedNotice>
      )}
      {current && rows.length === 0 && !loading && (
        <div
          style={{ ...sCard, textAlign: "center", padding: 40, color: D.muted }}
        >
          No timesheets for week of {weekStart}.
        </div>
      )}

      {rows.map((t) => {
        const approved = t.status === "approved";
        const otHrs = parseFloat(t.overtime_minutes || 0) / 60;
        // Paid hours when an unpaid lunch is on the week (regular + overtime
        // from the server); otherwise the shift hours, as before.
        const lunchHrs = parseFloat(t.unpaid_meal_minutes || 0) / 60;
        const totalHrs =
          lunchHrs > 0
            ? (parseFloat(t.regular_minutes || 0) +
                parseFloat(t.overtime_minutes || 0)) /
              60
            : parseFloat(t.total_shift_minutes || 0) / 60;
        const isExpanded = expanded === t.technician_id;
        // The Lunch column appears only when a day in this week has one.
        const showLunchCol =
          isExpanded &&
          !!detail &&
          (detail.dailies || []).some(
            (d) => d.no_lunch || unpaidMinutesOf(d) > 0,
          );
        return (
          <div key={t.technician_id} style={sCard}>
            {" "}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              {!approved && (
                <input
                  type="checkbox"
                  aria-label={`Select ${t.tech_name || "this technician"} for bulk approval`}
                  checked={selected.has(t.technician_id)}
                  onChange={() => toggleSelect(t.technician_id)}
                  style={{ width: 18, height: 18, cursor: "pointer" }}
                />
              )}
              <div style={{ flex: 1, minWidth: 180 }}>
                {" "}
                <div
                  style={{ fontSize: 15, fontWeight: 700, color: D.heading }}
                >
                  {t.tech_name}
                </div>{" "}
                <div
                  style={{
                    fontSize: 14,
                    color: D.muted,
                    marginTop: 2,
                    display: "flex",
                    gap: 6,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  {" "}
                  <span
                    style={sBadge(
                      approved ? "#DCFCE7" : "#FEF3C7",
                      approved ? D.green : D.amber,
                    )}
                  >
                    {t.status || "pending"}
                  </span>
                  {/* Tech sign-off badge: green when signed, muted when
                      awaiting. Hidden after admin approval since the
                      sign-off is moot once the week is locked. */}
                  {!approved &&
                    (t.tech_signed_at ? (
                      <span
                        style={sBadge("#DCFCE7", D.green)}
                        title={
                          t.tech_signature
                            ? `Signed by ${t.tech_signature}`
                            : ""
                        }
                      >
                        Tech signed
                      </span>
                    ) : (
                      <span style={sBadge(D.border, D.muted)}>
                        Awaiting tech sign-off
                      </span>
                    ))}
                  {t.auto_close_pending > 0 && (
                    <span style={sBadge("#FEF3C7", D.amber)}>
                      {t.auto_close_pending} automatic clock-out
                      {t.auto_close_pending === 1 ? "" : "s"} to review
                    </span>
                  )}
                </div>{" "}
              </div>{" "}
              <Stat
                label={lunchHrs > 0 ? "Paid hours" : "Hours"}
                value={`${totalHrs.toFixed(1)}h`}
              />{" "}
              {lunchHrs > 0 && (
                <Stat label="Unpaid lunch" value={`${lunchHrs.toFixed(1)}h`} />
              )}{" "}
              <Stat
                label="OT"
                value={`${otHrs.toFixed(1)}h`}
                warn={otHrs > 0}
              />{" "}
              <Stat label="Jobs" value={t.job_count || 0} />{" "}
              <Stat label="Revenue" value={fmt(t.total_revenue)} />{" "}
              <Stat label="RPMH" value={fmt(t.avg_rpmh)} />{" "}
              <Stat label="Util %" value={fmtPct(t.utilization_pct)} />{" "}
              <button
                onClick={() => loadDetail(t.technician_id)}
                style={sBtn(D.card, D.teal)}
              >
                {isExpanded ? "Hide" : "Details"}
              </button>
              {approved ? (
                <button
                  onClick={() => unlock(t.technician_id)}
                  disabled={busyTechId === t.technician_id || bulkBusy}
                  style={{ ...sBtn(D.card, D.red), opacity: busyTechId === t.technician_id || bulkBusy ? 0.6 : 1 }}
                >
                  {busyTechId === t.technician_id ? "Working…" : "Unlock"}
                </button>
              ) : (
                <button
                  onClick={() => approveOne(t.technician_id)}
                  disabled={busyTechId === t.technician_id || bulkBusy}
                  style={{ ...sBtn(D.green, D.white), opacity: busyTechId === t.technician_id || bulkBusy ? 0.6 : 1 }}
                >
                  {busyTechId === t.technician_id ? "Approving…" : "Approve"}
                </button>
              )}
            </div>
            {isExpanded && (
              <div
                style={{
                  marginTop: 16,
                  paddingTop: 16,
                  borderTop: `1px solid ${D.border}`,
                }}
              >
                {detailError ? (
                  <div role="alert" style={{ color: D.red, fontSize: 14, display: "flex", alignItems: "center", gap: 10 }}>
                    <span>Could not load week detail: {detailError}</span>
                    <button
                      type="button"
                      onClick={() => refreshDetail(t.technician_id)}
                      style={sBtn(D.card, D.text)}
                    >
                      Retry
                    </button>
                  </div>
                ) : detailLoading || !detail ? (
                  <div style={{ color: D.muted, fontSize: 14 }}>
                    Loading detail…
                  </div>
                ) : null}
                {!detailError && detail && detail.dailies && (
                  <>
                    {" "}
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: D.heading,
                        marginBottom: 8,
                      }}
                    >
                      Daily breakdown
                    </div>{" "}
                    <div style={{ overflowX: "auto" }}>
                      {" "}
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
                          <tr
                            style={{ background: "#F1F5F9", textAlign: "left" }}
                          >
                            {" "}
                            <th style={{ padding: 8 }}>Date</th>{" "}
                            <th style={{ padding: 8 }}>Shift</th>{" "}
                            {showLunchCol && (
                              <th style={{ padding: 8 }}>Lunch</th>
                            )}{" "}
                            <th style={{ padding: 8 }}>Jobs</th>{" "}
                            <th style={{ padding: 8 }}>OT</th>{" "}
                            <th style={{ padding: 8 }}>Revenue</th>{" "}
                            <th style={{ padding: 8 }}>Status</th>{" "}
                          </tr>{" "}
                        </thead>{" "}
                        <tbody>
                          {detail.dailies.map((d) => (
                            <tr
                              key={d.id}
                              style={{ borderTop: `1px solid ${D.border}` }}
                            >
                              {" "}
                              <td style={{ padding: 8, fontFamily: MONO }}>
                                {ymdOnly(d.work_date)}
                              </td>{" "}
                              <td style={{ padding: 8 }}>
                                {fmtHrs(d.total_shift_minutes)}
                              </td>{" "}
                              {showLunchCol && (
                                <td style={{ padding: 8 }}>
                                  {unpaidMinutesOf(d) > 0
                                    ? `-${fmtHrs(unpaidMinutesOf(d))}`
                                    : d.no_lunch
                                      ? ""
                                      : "--"}
                                  {d.no_lunch && (
                                    <span
                                      style={{
                                        ...sBadge("#F1F5F9", D.text),
                                        marginLeft: unpaidMinutesOf(d) > 0 ? 6 : 0,
                                      }}
                                    >
                                      No lunch
                                    </span>
                                  )}
                                </td>
                              )}{" "}
                              <td style={{ padding: 8 }}>{d.job_count || 0}</td>{" "}
                              <td
                                style={{
                                  padding: 8,
                                  color:
                                    parseFloat(d.overtime_minutes) > 0
                                      ? D.amber
                                      : D.muted,
                                }}
                              >
                                {fmtHrs(d.overtime_minutes)}
                              </td>{" "}
                              <td style={{ padding: 8 }}>
                                {fmt(d.revenue_generated)}
                              </td>{" "}
                              <td style={{ padding: 8 }}>
                                {" "}
                                <span style={sBadge("#F1F5F9", D.text)}>
                                  {d.status || "pending"}
                                </span>{" "}
                              </td>{" "}
                            </tr>
                          ))}
                        </tbody>{" "}
                      </table>{" "}
                    </div>
                    {detail.entries &&
                      detail.entries.some(
                        (e) => e.auto_closed_at && !e.auto_close_reviewed_at,
                      ) && (
                        <div style={{ marginTop: 16 }}>
                          <div
                            style={{
                              fontSize: 14,
                              fontWeight: 500,
                              color: D.amber,
                              marginBottom: 4,
                            }}
                          >
                            Automatic clock-outs to review
                          </div>
                          <div
                            style={{
                              fontSize: 14,
                              color: D.muted,
                              marginBottom: 8,
                            }}
                          >
                            The technician did not clock out, so the shift was
                            closed for them. Pay for this week is held until
                            you edit the clock-out or confirm it as it stands.
                          </div>
                          {detail.entries
                            .filter(
                              (e) => e.auto_closed_at && !e.auto_close_reviewed_at,
                            )
                            .map((e) => (
                              <div
                                key={e.id}
                                style={{
                                  fontSize: 14,
                                  padding: 8,
                                  background: "#FEF3C7",
                                  borderRadius: 6,
                                  marginBottom: 4,
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                  flexWrap: "wrap",
                                }}
                              >
                                <div style={{ flex: 1, minWidth: 200 }}>
                                  <strong>Shift</strong>·{" "}
                                  {formatETDateTime(e.clock_in)} to{" "}
                                  {formatETDateTime(e.clock_out)}
                                </div>
                                <button
                                  onClick={() => confirmAutoClose(e.id)}
                                  style={{
                                    ...sBtn(D.card, D.teal),
                                    fontSize: 14,
                                    padding: "4px 8px",
                                  }}
                                >
                                  Confirm clock-out
                                </button>
                              </div>
                            ))}
                        </div>
                      )}
                    {detail.entries &&
                      detail.entries.some(
                        (e) => e.approval_status === "disputed",
                      ) && (
                        <div style={{ marginTop: 16 }}>
                          {" "}
                          <div
                            style={{
                              fontSize: 14,
                              fontWeight: 500,
                              color: D.red,
                              marginBottom: 8,
                            }}
                          >
                            Disputed entries
                          </div>
                          {detail.entries
                            .filter((e) => e.approval_status === "disputed")
                            .map((e) => (
                              <div
                                key={e.id}
                                style={{
                                  fontSize: 14,
                                  padding: 8,
                                  background: "#FEF2F2",
                                  borderRadius: 6,
                                  marginBottom: 4,
                                }}
                              >
                                {" "}
                                <div>
                                  <strong>{e.entry_type}</strong> ·{" "}
                                  {formatETDateTime(e.clock_in)}
                                  {e.clock_out ? ` – ${formatETTime(e.clock_out)}` : ""}
                                </div>
                                {e.approval_notes && (
                                  <div style={{ color: D.muted, marginTop: 2 }}>
                                    {e.approval_notes}
                                  </div>
                                )}
                              </div>
                            ))}
                        </div>
                      )}
                    {detail.entries && !approved && (
                      <div style={{ marginTop: 12 }}>
                        {" "}
                        <div
                          style={{
                            fontSize: 14,
                            color: D.muted,
                            marginBottom: 6,
                          }}
                        >
                          Flag a specific entry:
                        </div>{" "}
                        <div
                          style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
                        >
                          {detail.entries
                            .filter((e) => e.approval_status !== "disputed")
                            .map((e) => {
                              const dateLabel = formatETDate(e.clock_in, { month: "short", day: "numeric" });
                              const timeRange = `${formatETTime(e.clock_in)}${e.clock_out ? `–${formatETTime(e.clock_out)}` : ""}`;
                              const durLabel = e.duration_minutes ? ` (${fmtHrs(e.duration_minutes)})` : "";
                              return (
                                <button
                                  key={e.id}
                                  onClick={() => disputeEntry(e.id)}
                                  style={{
                                    ...sBtn(D.card, D.red),
                                    fontSize: 14,
                                    padding: "4px 8px",
                                  }}
                                >
                                  Dispute {e.entry_type} {dateLabel} {timeRange}
                                  {durLabel}
                                </button>
                              );
                            })}
                        </div>{" "}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Stat({ label, value, warn }) {
  return (
    <div style={{ minWidth: 64 }}>
      {" "}
      <div
        style={{
          fontSize: 14,
          color: "#64748B",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>{" "}
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          fontFamily: "'JetBrains Mono', monospace",
          color: warn ? "#F0A500" : "#0F172A",
        }}
      >
        {value}
      </div>{" "}
    </div>
  );
}

