import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import useIsMobile from "../../../hooks/useIsMobile";
import useModalFocus from "../../../hooks/useModalFocus";
import {
  etDateString, etDatetimeLocalValue, etDatetimeLocalToISO, formatETTime, formatETDate, formatETDateTime,
} from "../../../lib/timezone";
import { staffMondayET as getMonday } from "../../../lib/staffTimeDate";
import {
  D, MONO, STATUS_COLORS, TYPE_COLORS,
  adminFetch, sCard, sBtn, sBadge, sInput, fmtHrs, thStyle, tdStyle,
} from "./staffShared";

// =============================================================================
// ENTRIES TAB
// =============================================================================
export function EntriesTab({ showToast, onOpenApprovals }) {
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState({
    technicianId: "",
    startDate: "",
    endDate: "",
    entryType: "",
    status: "",
  });
  const [loading, setLoading] = useState(true);
  const [editModal, setEditModal] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [techs, setTechs] = useState([]);
  const LIMIT = 30;
  // Only the newest request may write rows or clear "Loading...", so a slow
  // response for an earlier filter cannot replace the current results.
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", LIMIT);
      params.set("offset", page * LIMIT);
      if (filters.technicianId)
        params.set("technicianId", filters.technicianId);
      if (filters.startDate) params.set("startDate", filters.startDate);
      if (filters.endDate) params.set("endDate", filters.endDate);
      if (filters.entryType) params.set("entryType", filters.entryType);
      if (filters.status) params.set("status", filters.status);
      const res = await adminFetch(
        `/admin/timetracking/entries?${params.toString()}`,
      );
      if (sequence !== loadSequence.current) return;
      setEntries(res.entries || []);
      setTotal(res.total || 0);
    } catch (e) {
      if (sequence !== loadSequence.current) return;
      showToast("Failed to load entries");
    }
    setLoading(false);
  }, [page, filters]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    adminFetch("/admin/timetracking")
      .then((r) => setTechs(r.allTechs || []))
      .catch(() => {});
  }, []);

  const handleVoid = useCallback(
    async (id) => {
      if (!window.confirm("Void this entry?")) return;
      try {
        await adminFetch(`/admin/timetracking/entries/${id}`, {
          method: "DELETE",
          body: { reason: "Admin voided from UI" },
        });
        showToast("Entry voided");
        load();
      } catch (e) {
        // The server's own refusal (an approved or paid week, ...) says what
        // to do next; a bare "failed" does not.
        showToast(`Void failed: ${e.data?.error || e.message}`);
      }
    },
    [load],
  );

  // Returns the server's refusal (an approved or paid week, an entry changed
  // meanwhile, ...) so the form shows it and keeps the draft open.
  const handleEdit = useCallback(
    async (formData) => {
      try {
        await adminFetch(`/admin/timetracking/entries/${formData.id}`, {
          method: "PUT",
          body: formData,
        });
        showToast("Entry updated");
        setEditModal(null);
        load();
        return null;
      } catch (e) {
        return e.data?.error || "Could not save the entry";
      }
    },
    [load],
  );

  // Add a shift the technician never clocked. Returns the server's reason when
  // it refuses (overlap, approved or paid week, ...) so the form can show it.
  const handleAdd = useCallback(
    async (payload) => {
      try {
        await adminFetch("/admin/timetracking/entries", {
          method: "POST",
          body: payload,
        });
        showToast("Shift added");
        setAddOpen(false);
        load();
        return null;
      } catch (e) {
        return e.data?.error || "Could not add the shift";
      }
    },
    [load],
  );

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <button onClick={() => setAddOpen(true)} style={sBtn(D.teal, D.white)}>
          Add missed shift
        </button>
      </div>
      {/* Filters */}
      <div
        style={{
          ...sCard,
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "flex-end",
        }}
      >
        {" "}
        <div style={{ minWidth: 120 }}>
          {" "}
          <label
            style={{
              fontSize: 14,
              color: D.muted,
              display: "block",
              marginBottom: 2,
            }}
          >
            Tech
          </label>{" "}
          <select
            value={filters.technicianId}
            onChange={(e) => {
              setFilters((f) => ({ ...f, technicianId: e.target.value }));
              setPage(0);
            }}
            style={sInput}
          >
            {" "}
            <option value="">All</option>
            {techs.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>{" "}
        </div>{" "}
        <div style={{ minWidth: 120 }}>
          {" "}
          <label
            style={{
              fontSize: 14,
              color: D.muted,
              display: "block",
              marginBottom: 2,
            }}
          >
            Start Date
          </label>{" "}
          <input
            type="date"
            value={filters.startDate}
            onChange={(e) => {
              setFilters((f) => ({ ...f, startDate: e.target.value }));
              setPage(0);
            }}
            style={sInput}
          />{" "}
        </div>{" "}
        <div style={{ minWidth: 120 }}>
          {" "}
          <label
            style={{
              fontSize: 14,
              color: D.muted,
              display: "block",
              marginBottom: 2,
            }}
          >
            End Date
          </label>{" "}
          <input
            type="date"
            value={filters.endDate}
            onChange={(e) => {
              setFilters((f) => ({ ...f, endDate: e.target.value }));
              setPage(0);
            }}
            style={sInput}
          />{" "}
        </div>{" "}
        <div style={{ minWidth: 100 }}>
          {" "}
          <label
            style={{
              fontSize: 14,
              color: D.muted,
              display: "block",
              marginBottom: 2,
            }}
          >
            Type
          </label>{" "}
          <select
            value={filters.entryType}
            onChange={(e) => {
              setFilters((f) => ({ ...f, entryType: e.target.value }));
              setPage(0);
            }}
            style={sInput}
          >
            {" "}
            <option value="">All</option>
            {["shift", "job", "break", "drive", "admin_time"].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>{" "}
        </div>{" "}
        <div style={{ minWidth: 100 }}>
          {" "}
          <label
            style={{
              fontSize: 14,
              color: D.muted,
              display: "block",
              marginBottom: 2,
            }}
          >
            Status
          </label>{" "}
          <select
            value={filters.status}
            onChange={(e) => {
              setFilters((f) => ({ ...f, status: e.target.value }));
              setPage(0);
            }}
            style={sInput}
          >
            {" "}
            <option value="">All</option>
            {["active", "completed", "edited", "voided"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>{" "}
        </div>{" "}
      </div>
      {/* Entries table */}
      <div style={{ overflowX: "auto" }}>
        {" "}
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}
        >
          {" "}
          <thead>
            {" "}
            <tr style={{ background: D.card }}>
              {[
                "Date",
                "Tech",
                "Type",
                "Clock In",
                "Clock Out",
                "Duration",
                "Customer",
                "Service",
                "Notes",
                "Status",
                "Actions",
              ].map((h) => (
                <th key={h} style={thStyle}>
                  {h}
                </th>
              ))}
            </tr>{" "}
          </thead>{" "}
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={11}
                  style={{ ...tdStyle, textAlign: "center", color: D.muted }}
                >
                  Loading...
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td
                  colSpan={11}
                  style={{ ...tdStyle, textAlign: "center", color: D.muted }}
                >
                  No entries found
                </td>
              </tr>
            ) : (
              entries.map((e) => (
                <tr
                  key={e.id}
                  style={{
                    borderBottom: `1px solid ${D.border}`,
                    opacity: e.status === "voided" ? 0.5 : 1,
                  }}
                >
                  {" "}
                  <td style={tdStyle}>
                    {e.clock_in ? formatETDate(e.clock_in) : "--"}
                  </td>{" "}
                  <td style={tdStyle}>{e.tech_name || "--"}</td>{" "}
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
                    {e.service_type || e.job_service_type || "--"}
                  </td>{" "}
                  <td
                    style={{
                      ...tdStyle,
                      maxWidth: 120,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {e.notes || "--"}
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
                    {e.approval_status === "approved" && (
                      <span
                        title="This entry's week is approved. Unlock the week in Approvals before you edit or void it."
                        style={{ ...sBadge(D.green + "22", D.green), marginLeft: 4 }}
                      >
                        approved
                      </span>
                    )}
                  </td>{" "}
                  <td style={tdStyle}>
                    {e.status !== "voided" && (
                      <div style={{ display: "flex", gap: 4 }}>
                        {" "}
                        <button
                          onClick={() => setEditModal(e)}
                          style={sBtn(D.amber + "33", D.amber)}
                          title="Edit"
                        >
                          Edit
                        </button>{" "}
                        <button
                          onClick={() => handleVoid(e.id)}
                          style={sBtn(D.red + "33", D.red)}
                          title="Void"
                        >
                          Void
                        </button>{" "}
                      </div>
                    )}
                  </td>{" "}
                </tr>
              ))
            )}
          </tbody>{" "}
        </table>{" "}
      </div>
      {/* Pagination */}
      {totalPages > 1 && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 8,
            marginTop: 12,
          }}
        >
          {" "}
          <button
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
            style={sBtn(D.card, D.text)}
          >
            Prev
          </button>{" "}
          <span style={{ color: D.muted, fontSize: 14, padding: "8px 0" }}>
            Page {page + 1} of {totalPages} ({total} entries)
          </span>{" "}
          <button
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
            style={sBtn(D.card, D.text)}
          >
            Next
          </button>{" "}
        </div>
      )}

      {/* Edit Modal */}
      {editModal && (
        <EditEntryModal
          entry={editModal}
          onClose={() => setEditModal(null)}
          onSave={handleEdit}
          onOpenApprovals={onOpenApprovals}
        />
      )}
      {addOpen && (
        <AddShiftModal
          techs={techs}
          defaultTechId={filters.technicianId}
          onClose={() => setAddOpen(false)}
          onSave={handleAdd}
        />
      )}
    </div>
  );
}

// A shift the technician never clocked: the admin enters the Eastern date and
// start / end times; they are converted to instants here (the server takes
// instants only) and the server refuses overlaps and approved or paid weeks.
function AddShiftModal({ techs, defaultTechId, onClose, onSave }) {
  const isMobile = useIsMobile(640);
  const dialogRef = useModalFocus(true, onClose);
  const [form, setForm] = useState({
    technician_id: defaultTechId || "",
    date: etDateString(),
    start: "08:00",
    end: "17:00",
    notes: "",
    edit_reason: "",
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const labelStyle = { fontSize: 14, color: D.muted, display: "block", marginBottom: 4 };
  const complete =
    form.technician_id && form.date && form.start && form.end && form.edit_reason.trim();

  const submit = async () => {
    const clockIn = etDatetimeLocalToISO(`${form.date}T${form.start}`);
    const clockOut = etDatetimeLocalToISO(`${form.date}T${form.end}`);
    if (!clockIn || !clockOut) {
      setError("Enter a valid date, start time and end time.");
      return;
    }
    setSaving(true);
    setError("");
    const failure = await onSave({
      technician_id: form.technician_id,
      clock_in: clockIn,
      clock_out: clockOut,
      notes: form.notes.trim() || undefined,
      edit_reason: form.edit_reason.trim(),
    });
    if (failure) {
      setError(failure);
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="staff-foundation staff-legacy"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0,0,0,.7)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: isMobile ? 0 : 20,
      }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add missed shift"
        style={{
          ...sCard,
          maxWidth: 500,
          width: "100%",
          ...(isMobile
            ? { maxWidth: "none", height: "100%", borderRadius: 0, overflowY: "auto" }
            : {}),
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 16, fontWeight: 700, color: D.heading, marginBottom: 16 }}>
          Add missed shift
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label htmlFor="add-shift-tech" style={labelStyle}>Tech</label>
            <select id="add-shift-tech" value={form.technician_id} onChange={set("technician_id")} style={sInput}>
              <option value="">Choose a tech</option>
              {techs.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="add-shift-date" style={labelStyle}>Date</label>
            <input id="add-shift-date" type="date" value={form.date} onChange={set("date")} style={sInput} />
          </div>
          <div>
            <label htmlFor="add-shift-start" style={labelStyle}>Start time</label>
            <input id="add-shift-start" type="time" value={form.start} onChange={set("start")} style={sInput} />
          </div>
          <div>
            <label htmlFor="add-shift-end" style={labelStyle}>End time</label>
            <input id="add-shift-end" type="time" value={form.end} onChange={set("end")} style={sInput} />
          </div>
          <div>
            <label htmlFor="add-shift-notes" style={labelStyle}>Notes</label>
            <textarea
              id="add-shift-notes"
              value={form.notes}
              onChange={set("notes")}
              style={{ ...sInput, minHeight: 60, resize: "vertical" }}
            />
          </div>
          <div>
            <label htmlFor="add-shift-reason" style={{ ...labelStyle, color: D.red }}>
              Reason (required)
            </label>
            <input
              id="add-shift-reason"
              type="text"
              value={form.edit_reason}
              onChange={set("edit_reason")}
              style={sInput}
              placeholder="Why is this shift being added?"
            />
          </div>
          {error && (
            <div role="alert" style={{ fontSize: 14, color: D.red }}>
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
            <button onClick={onClose} style={sBtn(D.card, D.muted)}>
              Cancel
            </button>
            <button
              disabled={!complete || saving}
              onClick={submit}
              style={{ ...sBtn(D.teal, D.white), opacity: complete && !saving ? 1 : 0.5 }}
            >
              {saving ? "Adding..." : "Add shift"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function EditEntryModal({ entry, onClose, onSave, onOpenApprovals }) {
  // Reactive (rotation-safe) — the module-level snapshot never recomputes.
  const isMobile = useIsMobile(640);
  const dialogRef = useModalFocus(true, onClose);
  const [form, setForm] = useState({
    id: entry.id,
    clock_in: etDatetimeLocalValue(entry.clock_in),
    clock_out: etDatetimeLocalValue(entry.clock_out),
    entry_type: entry.entry_type,
    notes: entry.notes || "",
    edit_reason: "",
  });
  // The server's refusal of the last save. The draft stays as typed.
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const approved = entry.approval_status === "approved";
  // The payroll week the server checks: the Monday of the clock-in's Eastern
  // date (staffWeekStartForWorkDate on the server).
  const weekStart = entry.clock_in ? getMonday(new Date(entry.clock_in)) : null;
  const approvalsLink =
    onOpenApprovals && weekStart ? (
      <button
        type="button"
        onClick={() => onOpenApprovals(weekStart)}
        style={{ ...sBtn(D.card, D.text), marginTop: 8 }}
      >
        Open week of {weekStart} in Approvals
      </button>
    ) : null;

  const save = async () => {
    // If a clock field wasn't touched, send back the exact stored instant
    // rather than re-deriving it from the ET wall clock. A wall-clock string
    // can't distinguish the two 1 AM instants on a DST fall-back day, so
    // re-deriving an untouched value would silently shift a repeated-hour
    // entry by an hour on any unrelated edit. Only convert when the operator
    // changed it.
    const resolve = (field, original) =>
      form[field] === etDatetimeLocalValue(original)
        ? original
          ? new Date(original).toISOString()
          : null
        : etDatetimeLocalToISO(form[field]);
    setSaving(true);
    setError("");
    const failure = await onSave({
      ...form,
      clock_in: resolve("clock_in", entry.clock_in),
      clock_out: resolve("clock_out", entry.clock_out),
    });
    if (failure) {
      setError(failure);
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="staff-foundation staff-legacy"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0,0,0,.7)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: isMobile ? 0 : 20,
      }}
      onClick={onClose}
    >
      {" "}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Edit time entry"
        style={{
          ...sCard,
          maxWidth: 500,
          width: "100%",
          ...(isMobile
            ? {
                width: "100%",
                maxWidth: "none",
                height: "100%",
                maxHeight: "none",
                borderRadius: 0,
                marginBottom: 0,
                boxSizing: "border-box",
                overflowY: "auto",
                paddingTop: "calc(20px + env(safe-area-inset-top, 0px))",
                paddingBottom: "calc(20px + env(safe-area-inset-bottom, 0px))",
                paddingLeft: "calc(20px + env(safe-area-inset-left, 0px))",
                paddingRight: "calc(20px + env(safe-area-inset-right, 0px))",
              }
            : {}),
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {" "}
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: D.heading,
            marginBottom: 16,
          }}
        >
          Edit Time Entry
        </div>
        {approved && (
          <div
            style={{
              fontSize: 14,
              color: D.amber,
              marginBottom: 12,
              padding: 8,
              background: D.amber + "11",
              borderRadius: 6,
            }}
          >
            This entry&apos;s week is approved. Unlock the week in Approvals
            before you change it.
            {approvalsLink && <div>{approvalsLink}</div>}
          </div>
        )}
        {entry.original_clock_in && (
          <div
            style={{
              fontSize: 14,
              color: D.amber,
              marginBottom: 12,
              padding: 8,
              background: D.amber + "11",
              borderRadius: 6,
            }}
          >
            Original: {formatETDateTime(entry.original_clock_in)} -{" "}
            {entry.original_clock_out
              ? formatETDateTime(entry.original_clock_out)
              : "active"}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {" "}
          <div>
            {" "}
            <label
              style={{
                fontSize: 14,
                color: D.muted,
                display: "block",
                marginBottom: 4,
              }}
            >
              Type
            </label>{" "}
            <select
              value={form.entry_type}
              onChange={(e) =>
                setForm((f) => ({ ...f, entry_type: e.target.value }))
              }
              style={sInput}
            >
              {["shift", "job", "break", "drive", "admin_time"].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>{" "}
          </div>{" "}
          <div>
            {" "}
            <label
              style={{
                fontSize: 14,
                color: D.muted,
                display: "block",
                marginBottom: 4,
              }}
            >
              Clock In
            </label>{" "}
            <input
              type="datetime-local"
              value={form.clock_in}
              onChange={(e) =>
                setForm((f) => ({ ...f, clock_in: e.target.value }))
              }
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
                marginBottom: 4,
              }}
            >
              Clock Out
            </label>{" "}
            <input
              type="datetime-local"
              value={form.clock_out}
              onChange={(e) =>
                setForm((f) => ({ ...f, clock_out: e.target.value }))
              }
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
                marginBottom: 4,
              }}
            >
              Notes
            </label>{" "}
            <textarea
              value={form.notes}
              onChange={(e) =>
                setForm((f) => ({ ...f, notes: e.target.value }))
              }
              style={{ ...sInput, minHeight: 60, resize: "vertical" }}
            />{" "}
          </div>{" "}
          <div>
            {" "}
            <label
              style={{
                fontSize: 14,
                color: D.red,
                display: "block",
                marginBottom: 4,
              }}
            >
              Edit Reason (required)
            </label>{" "}
            <input
              type="text"
              value={form.edit_reason}
              onChange={(e) =>
                setForm((f) => ({ ...f, edit_reason: e.target.value }))
              }
              style={sInput}
              placeholder="Why is this being changed?"
            />{" "}
          </div>{" "}
          {error && (
            <div role="alert" style={{ fontSize: 14, color: D.red }}>
              {error}
              {!approved && approvalsLink && <div>{approvalsLink}</div>}
            </div>
          )}
          <div
            style={{
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
              marginTop: 8,
            }}
          >
            {" "}
            <button onClick={onClose} style={sBtn(D.card, D.muted)}>
              Cancel
            </button>{" "}
            <button
              disabled={!form.edit_reason || saving}
              onClick={save}
              style={{
                ...sBtn(D.teal, D.white),
                opacity: form.edit_reason && !saving ? 1 : 0.5,
              }}
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>{" "}
          </div>{" "}
        </div>{" "}
      </div>{" "}
    </div>,
    document.body,
  );
}
