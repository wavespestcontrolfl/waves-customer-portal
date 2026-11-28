import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import useIsMobile from "../../../hooks/useIsMobile";
import useModalFocus from "../../../hooks/useModalFocus";
import ServiceLinesCard from "../ServiceLinesCard";
import TerritoryReadoutCard from "../TerritoryReadoutCard";
import AddressAutocomplete from "../../../components/AddressAutocomplete";
import { TECH_LINE_NUMBERS } from "../../../constants/techLines";
import { etDateString, formatETDate } from "../../../lib/timezone";
import { addStaffCalendarDays as addDays } from "../../../lib/staffTimeDate";
import {
  API_BASE, D, MONO,
  adminFetch, sCard, sBtn, sBadge, sInput, fmt, errMessage, ymdOnly,
  readStaffProfile, LoadFailedNotice,
} from "./staffShared";

// ═══════════════════════════════════════════════════════════════════
// TEAM TAB — Manage technicians
// ═══════════════════════════════════════════════════════════════════
// Default form shape for the Add/Edit Tech form. Centralized so the
// "+ Add Technician" button, the cancel-after-save reset, and the
// edit-time prefill all stay in lockstep — adding a new payroll
// field below means changing exactly one place.
const EMPTY_TECH_FORM = {
  name: "",
  phone: "",
  email: "",
  // Employment: "active" = on staff and can sign in; "prospective" = a
  // hire who has not started (placeholder — no sign-in, no slots).
  employmentStatus: "active",
  // Per-tech Twilio line ('' = none). Options come from the shared number
  // list; the server rejects anything outside the registry.
  twilioNumber: "",
  // Field eligibility is separate from employment: an office admin stays
  // active without ever appearing as a dispatch target.
  fieldDispatchable: false,
  // A technician added now cannot move visits until the
  // owner ticks this (owner 2026-10-25).
  canMoveVisits: false,
  // GATE_STAFF_GOOGLE_SIGNIN: the company Google account this person signs
  // in with. Saved through its own route after the profile save.
  googleEmail: "",
  autoFlipEnabled: true,
  // Payroll profile
  payRate: "",
  hireDate: "",
  jobTitle: "",
  employmentType: "",
  // Personal / emergency
  address: "",
  dob: "",
  emergencyContactName: "",
  emergencyContactPhone: "",
  ssnLast4: "",
  // Where the day starts and ends. "office" = no saved point (the server clears
  // all three columns); "home" needs a picked suggestion with coordinates.
  // startText is the visible input; startPoint is the last picked suggestion.
  startMode: "office",
  startText: "",
  startPoint: null,
  // The supplier branch this person buys from (free text; the weekly buy list
  // prints it). Edit only, like the start point.
  supplyStore: "",
  // GATE_TECH_WORK_DAYS: weekdays this person works, stored 0 = Sunday. All
  // seven = every day (sent as null). Only sent while the server says the
  // gate is on (workDaysEnabled).
  workDays: [0, 1, 2, 3, 4, 5, 6],
  // GATE_TECH_SHIFT_HOURS: the hours of each work day, "HH:MM" Eastern. Both
  // empty = no set hours (sent as null). Only sent while the server says the
  // gate is on (shiftHoursEnabled).
  shiftStart: "",
  shiftEnd: "",
};

// Work-days toggles in display order (Mon to Sun); values are stored 0 = Sunday.
const WORK_DAY_OPTIONS = [
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
  { day: 0, label: "Sun" },
];

// "Mon–Thu" for a run of days, "Mon, Wed, Fri" for a gap. Empty when the
// list is missing or covers all seven days (works every day: nothing to say).
function describeWorkDays(workDays) {
  if (!Array.isArray(workDays) || !workDays.length) return "";
  const set = new Set(workDays.map(Number));
  const picked = WORK_DAY_OPTIONS.map((o, i) => (set.has(o.day) ? i : -1)).filter((i) => i >= 0);
  if (!picked.length || picked.length === 7) return "";
  const runs = [];
  for (const i of picked) {
    const last = runs[runs.length - 1];
    if (last && i === last[1] + 1) last[1] = i;
    else runs.push([i, i]);
  }
  return runs
    .map(([from, to]) => (from === to
      ? WORK_DAY_OPTIONS[from].label
      : `${WORK_DAY_OPTIONS[from].label}–${WORK_DAY_OPTIONS[to].label}`))
    .join(", ");
}

// Wire shape for `startPoint` on PUT: null (office) or { address, lat, lng }.
// A typed-but-unpicked address has no coordinates and is never sent.
function buildStartPointPayload(form) {
  if (form.startMode !== "home") return null;
  const p = form.startPoint;
  return p ? { address: p.address, lat: p.lat, lng: p.lng } : null;
}

// `workDays` on the wire: nothing while the gate is off; null when all seven
// days are on (works every day); otherwise the picked days, stored 0 = Sunday.
function buildWorkDaysPayload(enabled, workDays) {
  if (!enabled) return {};
  const days = [...new Set(workDays || [])].sort((a, b) => a - b);
  return { workDays: days.length === 7 ? null : days };
}

// `shiftHours` on the wire: nothing while the gate is off; null when both times
// are empty (no set hours); otherwise { start, end } as "HH:MM".
function buildShiftHoursPayload(enabled, shiftStart, shiftEnd) {
  if (!enabled) return {};
  if (!shiftStart && !shiftEnd) return { shiftHours: null };
  return { shiftHours: { start: shiftStart, end: shiftEnd } };
}

// Why the shift hours cannot be saved yet, or "" when they can: both times or
// neither, and the end after the start (the server refuses the same cases).
function shiftHoursProblem(form) {
  if (!form.shiftStart && !form.shiftEnd) return "";
  if (!form.shiftStart || !form.shiftEnd) return "Enter both shift times, or clear both";
  if (form.shiftEnd <= form.shiftStart) return "The shift must end after it starts";
  return "";
}

// "8:00 AM–6:00 PM" from stored "HH:MM" times; empty when either is missing.
function describeShiftHours(start, end) {
  const label = (value) => {
    const m = /^(\d{2}):(\d{2})/.exec(value || "");
    if (!m) return "";
    const hour = Number(m[1]);
    return `${hour % 12 || 12}:${m[2]} ${hour < 12 ? "AM" : "PM"}`;
  };
  const from = label(start);
  const to = label(end);
  return from && to ? `${from}–${to}` : "";
}

function startPointNeedsPick(form) {
  return form.startMode === "home" && !form.startPoint;
}

// "Starts: home, 100 Example Way, Bradenton" from the saved formatted address.
function describeStartPoint(tech) {
  if (!tech.start_address || tech.start_lat == null || tech.start_lng == null) {
    return "Starts: office";
  }
  const [street, city] = String(tech.start_address).split(",").map((x) => x.trim());
  return `Starts: home, ${[street, city].filter(Boolean).join(", ")}`;
}

// Team tab "Google sign-in" field (GATE_STAFF_GOOGLE_SIGNIN): the company
// Google account this person signs in with, and whether its first sign-in
// happened.
function GoogleSigninField({ enabled, tech, value, onChange }) {
  if (!enabled) return null;
  const hint = tech && tech.google_linked
    ? "In use. A change or a clear signs this person out."
    : tech && tech.google_email
      ? "Not used yet. The first Google sign-in links it."
      : "Optional. A company Google account for Sign in with Google.";
  return (
    <div>
      <label htmlFor="tech-form-google" style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}>
        Google sign-in
      </label>
      <input
        id="tech-form-google"
        type="email"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="john@wavespestcontrol.com"
        style={sInput}
      />
      <div style={{ fontSize: 14, color: D.muted, marginTop: 4 }}>{hint}</div>
    </div>
  );
}

// The supply store goes in the save only when the admin changed it (absent = unchanged on the server).
const supplyStorePatch = (value, loaded) => ((value ?? "") === (loaded ?? "") ? {} : { supplyStore: value });

const visitWarningText = (list, tail) =>
  list?.length
    ? `${list.length} upcoming visit${list.length === 1 ? "" : "s"} ${tail}`
    : "";

export function TeamTab({ showToast, staffProfile, payrollAvailable = false, onOpenPayroll = null }) {
  const [techs, setTechs] = useState([]);
  const [loading, setLoading] = useState(true);
  // A failed roster read is not an empty team: the empty-state invitation to
  // add a first technician shows only after a read that succeeded.
  const [loadFailed, setLoadFailed] = useState(false);
  const loadRequestRef = useRef(0);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_TECH_FORM);
  // GATE_TECH_WORK_DAYS: the server marks the roster response when the gate is
  // on; off, the Work days row and summary never render and nothing is sent.
  const [workDaysEnabled, setWorkDaysEnabled] = useState(false);
  // GATE_TECH_SHIFT_HOURS: the server marks the roster response when the gate is
  // on; off, the Shift hours row and summary never render and nothing is sent.
  const [shiftHoursEnabled, setShiftHoursEnabled] = useState(false);
  // The shift hours as the editor opened them: an edit that leaves both times as
  // loaded sends no shiftHours, so saving another field never overwrites hours
  // another admin set meanwhile (the API keeps omitted hours).
  const [shiftLoaded, setShiftLoaded] = useState(null);
  // The supply store as loaded: sent on save only when the admin changed it, so a stale form never overwrites another admin's edit.
  const [storeLoaded, setStoreLoaded] = useState(null);
  // GATE_SERVICE_LINE_MAP=shadow: the server marks the roster response; off, the
  // Service lines card never renders and nothing is fetched.
  const [serviceLinesEnabled, setServiceLinesEnabled] = useState(false);
  // GATE_TERRITORY_READOUT: the server marks the roster response; off, the Territories
  // card never renders and nothing is fetched.
  const [territoryReadoutEnabled, setTerritoryReadoutEnabled] = useState(false);
  const [googleSigninEnabled, setGoogleSigninEnabled] = useState(false);
  const [showPayrollSection, setShowPayrollSection] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveInFlightRef = useRef(false);
  const [earningsTech, setEarningsTech] = useState(null);
  const [capabilitiesTech, setCapabilitiesTech] = useState(null);
  const [deactivateTech, setDeactivateTech] = useState(null);
  const [deactivateError, setDeactivateError] = useState("");
  const [deactivating, setDeactivating] = useState(false);
  const deactivateInFlightRef = useRef(false);
  // The server sets t.hire_action ("hire") on a prospective row only for an
  // admin whose linked Google address can sign in; no hire_action = no Hired UI.
  const [hireTech, setHireTech] = useState(null);
  const [hireError, setHireError] = useState("");
  const [hiring, setHiring] = useState(false);
  const hireInFlightRef = useRef(false);
  // The add, edit, earnings, capabilities and activate routes are admin-only;
  // the roster itself is readable by technicians, so those actions are hidden
  // for them rather than 403ing. A technician changes only its own photo.
  const viewer = useMemo(() => staffProfile || readStaffProfile(), [staffProfile]);
  const isAdmin = viewer.role === "admin";
  const ownStaffId = viewer.id || null;
  // Photo upload state. fileInputRef is shared across rows because
  // mounting one <input type=file>per tech is needless DOM. Uploads
  // are serialized: while uploadingId is non-null, every row's Photo
  // button is disabled so photoTargetId can't be clobbered mid-flight.
  const fileInputRef = useRef(null);
  const [photoTargetId, setPhotoTargetId] = useState(null);
  const [uploadingId, setUploadingId] = useState(null);

  const handlePhotoClick = (techId) => {
    if (uploadingId !== null) return;
    setPhotoTargetId(techId);
    if (fileInputRef.current) {
      fileInputRef.current.value = ""; // re-pick same file would be silent otherwise
      fileInputRef.current.click();
    }
  };

  const handlePhotoSelected = async (e) => {
    const file = e.target.files?.[0];
    const techId = photoTargetId;
    if (!file || !techId || uploadingId !== null) return;
    setUploadingId(techId);
    try {
      // adminFetch (file-local) hardcodes JSON content-type, so use
      // a direct fetch with the same Authorization header for the
      // multipart upload. Same shape as the curl example.
      const fd = new FormData();
      fd.append("photo", file);
      const res = await fetch(
        `${API_BASE}/admin/timetracking/technicians/${techId}/photo`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
          },
          body: fd,
        },
      );
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body?.error) detail = body.error;
        } catch { /* non-JSON error */ }
        throw new Error(detail);
      }
      showToast("Photo uploaded");
      load();
    } catch (err) {
      showToast("Photo upload failed: " + errMessage(err));
    }
    setUploadingId(null);
    setPhotoTargetId(null);
  };

  const load = useCallback(async () => {
    // Saves, hires and Retry each reload the roster; only the latest read
    // may set it or the failure notice.
    const request = ++loadRequestRef.current;
    try {
      const res = await adminFetch("/admin/timetracking/technicians");
      if (request !== loadRequestRef.current) return;
      setTechs(res.technicians || []);
      setWorkDaysEnabled(res.workDaysEnabled === true);
      setShiftHoursEnabled(res.shiftHoursEnabled === true);
      setServiceLinesEnabled(res.serviceLinesEnabled === true);
      setTerritoryReadoutEnabled(res.territoryReadoutEnabled === true);
      setGoogleSigninEnabled(res.googleSigninEnabled === true);
      setLoadFailed(false);
    } catch {
      if (request !== loadRequestRef.current) return;
      // A roster already on screen stays; the notice says it may be stale.
      setLoadFailed(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const editingTech = techs.find((t) => t.id === editingId);

  // A refused link (another domain, already linked) is reported; the profile
  // save above it stands.
  const saveGoogleSignin = async (techId, existingWarning = "") => {
    const next = form.googleEmail.trim();
    if (!googleSigninEnabled || next.toLowerCase() === (editingTech?.google_email || "").toLowerCase()) {
      return { ok: true };
    }
    try {
      await adminFetch(`/admin/timetracking/technicians/${techId}/google-signin`, {
        method: "PUT",
        body: JSON.stringify({ googleEmail: next || null }),
      });
      return { ok: true };
    } catch (e) {
      const reason = errMessage(e, "Unknown error");
      showToast(
        existingWarning
          ? `Saved (${existingWarning}), but not the Google sign-in: ${reason}`
          : "Saved, but not the Google sign-in: " + reason,
        { error: true },
      );
      return { ok: false };
    }
  };

  const handleSave = async () => {
    if (saveInFlightRef.current || !form.name.trim()) return;
    if (workDaysEnabled && !form.workDays.length) {
      showToast("Pick at least one work day", { error: true });
      return;
    }
    const shiftProblem = shiftHoursEnabled ? shiftHoursProblem(form) : "";
    if (shiftProblem) {
      showToast(shiftProblem, { error: true });
      return;
    }
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const {
        startMode: _startMode, startText: _startText, startPoint: _startPoint,
        supplyStore, workDays, shiftStart, shiftEnd, googleEmail: _googleEmail, ...rest
      } = form;
      const basePayload = { ...rest, ...buildWorkDaysPayload(workDaysEnabled, workDays) };
      let targetId = editingId;
      let warningNote = "";
      let savedLabel = "Technician updated";
      if (editingId) {
        const shiftPayload = shiftLoaded && shiftLoaded.start === shiftStart && shiftLoaded.end === shiftEnd
          ? {}
          : buildShiftHoursPayload(shiftHoursEnabled, shiftStart, shiftEnd);
        const res = await adminFetch(`/admin/timetracking/technicians/${editingId}`, {
          method: "PUT",
          body: JSON.stringify({
            ...basePayload,
            ...shiftPayload,
            startPoint: buildStartPointPayload(form),
            ...supplyStorePatch(supplyStore, storeLoaded),
          }),
        });
        // Leaving the dispatch pool through Edit or changing shift hours keeps
        // future visits on the schedule for manual reassignment.
        warningNote =
          visitWarningText(res.futureAssignedVisits, "still assigned; reassign on the Schedule") ||
          visitWarningText(res.outsideShiftVisits, "outside the new shift hours; move or reassign on the Schedule");
      } else {
        const created = await adminFetch("/admin/timetracking/technicians", {
          method: "POST",
          body: JSON.stringify({
            ...basePayload,
            ...buildShiftHoursPayload(shiftHoursEnabled, shiftStart, shiftEnd),
          }),
        });
        targetId = created.technician.id;
        savedLabel = "Technician added";
      }
      if (!(await saveGoogleSignin(targetId, warningNote)).ok) {
        setEditingId(targetId);
        load();
        return;
      }
      showToast([savedLabel, warningNote].filter(Boolean).join(" — "));
      setShowAdd(false);
      setEditingId(null);
      setForm(EMPTY_TECH_FORM);
      setShowPayrollSection(false);
      load();
    } catch (e) {
      showToast("Failed: " + errMessage(e));
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  };

  const handleActivate = async (tech) => {
    try {
      await adminFetch(`/admin/timetracking/technicians/${tech.id}`, {
        method: "PUT",
        body: JSON.stringify({ active: true }),
      });
      showToast(`${tech.name} activated`);
      load();
    } catch (e) {
      showToast("Failed: " + errMessage(e));
    }
  };

  const handleDeactivate = async (tech) => {
    if (deactivateInFlightRef.current) return;
    deactivateInFlightRef.current = true;
    setDeactivating(true);
    setDeactivateError("");
    try {
      const res = await adminFetch(`/admin/timetracking/technicians/${tech.id}`, {
        method: "DELETE",
      });
      // Future work is left on the schedule for manual reassignment — the
      // server never cancels or rewrites visits on deactivation.
      const warning = visitWarningText(
        res?.futureAssignedVisits,
        "still assigned; reassign on the Schedule",
      );
      showToast(warning ? `${tech.name} deactivated — ${warning}` : `${tech.name} deactivated`);
      setDeactivateTech(null);
      load();
    } catch (e) {
      const message = "Failed to deactivate: " + errMessage(e, "Unknown error");
      setDeactivateError(message);
      showToast(message);
    } finally {
      deactivateInFlightRef.current = false;
      setDeactivating(false);
    }
  };

  const handleHire = async (tech, fields) => {
    if (hireInFlightRef.current) return;
    hireInFlightRef.current = true;
    setHiring(true);
    setHireError("");
    try {
      await adminFetch(`/admin/timetracking/technicians/${tech.id}/hire/google`, {
        method: "POST",
        body: JSON.stringify(fields),
      });
      showToast(`Hired. ${fields.name} signs in with Google. No email was sent.`);
      setHireTech(null);
      load();
    } catch (e) {
      setHireError(
        (e && e.data && e.data.error) || "Could not hire: " + String((e && e.message) || "Unknown error"),
      );
    } finally {
      hireInFlightRef.current = false;
      setHiring(false);
    }
  };

  const startEdit = (tech) => {
    setEditingId(tech.id);
    setShiftLoaded({ start: tech.shift_start || "", end: tech.shift_end || "" });
    setStoreLoaded(tech.supply_store);
    setForm({
      name: tech.name,
      phone: tech.phone || "",
      email: tech.email || "",
      employmentStatus: tech.employment_status || (tech.active ? "active" : "inactive"),
      twilioNumber: tech.twilio_number || "",
      fieldDispatchable: tech.field_dispatchable === true,
      // Unknown (an older response without the column) stays unsent, so an
      // ordinary edit can never switch moves off by accident.
      canMoveVisits: typeof tech.can_move_visits === "boolean" ? tech.can_move_visits : undefined,
      // The estimate tool's switch (2026-11-09): same rule, an unknown value stays unsent.
      canCreateEstimates: typeof tech.can_create_estimates === "boolean" ? tech.can_create_estimates : undefined,
      googleEmail: tech.google_email || "",
      autoFlipEnabled: tech.auto_flip_enabled !== false, // default true if undefined
      payRate: tech.pay_rate != null ? String(tech.pay_rate) : "",
      hireDate: tech.hire_date ? String(tech.hire_date).split("T")[0] : "",
      jobTitle: tech.job_title || "",
      employmentType: tech.employment_type || "",
      address: tech.address || "",
      dob: tech.dob ? String(tech.dob).split("T")[0] : "",
      emergencyContactName: tech.emergency_contact_name || "",
      emergencyContactPhone: tech.emergency_contact_phone || "",
      ssnLast4: tech.ssn_last4 || "",
      workDays: Array.isArray(tech.work_days) && tech.work_days.length
        ? tech.work_days.map(Number)
        : [0, 1, 2, 3, 4, 5, 6],
      shiftStart: tech.shift_start || "",
      shiftEnd: tech.shift_end || "",
      supplyStore: tech.supply_store,
      ...(tech.start_address && tech.start_lat != null && tech.start_lng != null
        ? {
            startMode: "home",
            startText: tech.start_address,
            startPoint: {
              address: tech.start_address,
              lat: Number(tech.start_lat),
              lng: Number(tech.start_lng),
            },
          }
        : { startMode: "office", startText: "", startPoint: null }),
    });
    // Auto-expand payroll section if this tech already has any payroll
    // fields filled in — saves a click for the "edit existing wage"
    // path which is the most common reason to reopen this form.
    setShowPayrollSection(
      !!(
        tech.pay_rate ||
        tech.hire_date ||
        tech.job_title ||
        tech.dob ||
        tech.emergency_contact_name
      ),
    );
    setShowAdd(true);
  };

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading team...
      </div>
    );

  return (
    <div>
      {" "}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        {" "}
        <div style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>
          Technicians
        </div>{" "}
        {isAdmin && (
          <button
            onClick={() => {
              setShowAdd(true);
              setEditingId(null);
              setForm(EMPTY_TECH_FORM);
              setShowPayrollSection(false);
            }}
            style={sBtn(D.teal, D.white)}
          >
            + Add Technician
          </button>
        )}{" "}
      </div>
      {loadFailed && (
        <LoadFailedNotice onRetry={load}>
          {techs.length === 0
            ? "Could not load the team."
            : "Could not refresh the team. This list may be out of date."}
        </LoadFailedNotice>
      )}
      {/* Add / Edit form */}
      {showAdd && (
        <div style={{ ...sCard, marginBottom: 16 }}>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            {editingId ? "Edit Technician" : "New Technician"}
          </div>{" "}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
              marginBottom: 12,
            }}
          >
            {" "}
            <div>
              {" "}
              <label htmlFor="tech-form-name" style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}>
                Name *
              </label>{" "}
              <input
                id="tech-form-name"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="e.g. John D."
                style={sInput}
              />{" "}
            </div>{" "}
            <div>
              {" "}
              <label htmlFor="tech-form-phone" style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}>
                Phone
              </label>{" "}
              <input
                id="tech-form-phone"
                value={form.phone}
                onChange={(e) =>
                  setForm((f) => ({ ...f, phone: e.target.value }))
                }
                placeholder="+19415551234"
                style={sInput}
              />{" "}
            </div>{" "}
            <div>
              {" "}
              <label htmlFor="tech-form-email" style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}>
                Email
              </label>{" "}
              <input
                id="tech-form-email"
                value={form.email}
                onChange={(e) =>
                  setForm((f) => ({ ...f, email: e.target.value }))
                }
                placeholder="john@wavespestcontrol.com"
                style={sInput}
              />{" "}
            </div>{" "}
            <GoogleSigninField
              enabled={googleSigninEnabled}
              tech={editingTech}
              value={form.googleEmail}
              onChange={(googleEmail) => setForm((f) => ({ ...f, googleEmail }))}
            />
            <div>
              {" "}
              <label htmlFor="tech-form-employment" style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}>
                Employment
              </label>{" "}
              <select
                id="tech-form-employment"
                value={form.employmentStatus}
                onChange={(e) =>
                  setForm((f) => ({ ...f, employmentStatus: e.target.value }))
                }
                style={sInput}
              >
                <option value="active">Active — on staff</option>
                <option value="prospective">Prospective — not started</option>
                {editingId && <option value="inactive">Inactive — offboarded</option>}
              </select>{" "}
            </div>{" "}
            <div>
              {" "}
              <label htmlFor="tech-form-tech-line" style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}>
                Tech line
              </label>{" "}
              {/* Which Waves Twilio line this tech answers on (Field Team
                  Program, Phase 0). One line per tech — the server refuses a
                  line another tech already holds. Texts to it reach the tech
                  and the office; calls ring the tech's cell first. */}
              <select
                id="tech-form-tech-line"
                value={form.twilioNumber}
                onChange={(e) =>
                  setForm((f) => ({ ...f, twilioNumber: e.target.value }))
                }
                style={sInput}
              >
                <option value="">None — office lines only</option>
                {TECH_LINE_NUMBERS.map((n) => (
                  <option key={n.number} value={n.number}>
                    {n.formatted} · {n.label}
                  </option>
                ))}
              </select>{" "}
            </div>{" "}
            {/* Keyed by technician: switching to another tech's Edit remounts it
                empty, so a PIN typed for one person never goes to another. */}
            <TechVoicePinField key={editingId} technicianId={editingId} />
            {/* Start-of-day point. Edit only: the add form does not send it.
                Empty = the office (today's routing). Home needs an address
                picked from the list so it carries coordinates. */}
            {editingId && (
              <div style={{ gridColumn: "1 / -1" }}>
                {/* Where this person buys supplies (e.g. a SiteOne branch); the Monday
                    buy list prints it as the store. Blank clears it. */}
                <label
                  htmlFor="tech-form-supply-store"
                  style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}
                >
                  Supply store
                </label>{" "}
                <input
                  id="tech-form-supply-store"
                  key={editingId}
                  defaultValue={form.supplyStore}
                  maxLength={120}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, supplyStore: e.target.value }))
                  }
                  placeholder="Supplier branch"
                  style={{ ...sInput, marginBottom: 12 }}
                />{" "}
                <div style={{ fontSize: 14, color: D.muted, marginBottom: 4 }}>
                  Starts the day from
                </div>{" "}
                <select
                  aria-label="Starts the day from"
                  value={form.startMode}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, startMode: e.target.value }))
                  }
                  style={sInput}
                >
                  <option value="office">Office</option>
                  <option value="home">Home address</option>
                </select>{" "}
                {form.startMode === "home" && (
                  <div style={{ marginTop: 8 }}>
                    <AddressAutocomplete
                      aria-label="Home address"
                      value={form.startText}
                      onChange={(val) =>
                        setForm((f) => ({
                          ...f,
                          startText: val,
                          startPoint:
                            f.startPoint && f.startPoint.address === val
                              ? f.startPoint
                              : null,
                        }))
                      }
                      onSelect={(parts) => {
                        const address = parts.formatted || parts.line1 || "";
                        const lat = Number(parts.lat);
                        const lng = Number(parts.lng);
                        const ok =
                          address &&
                          parts.lat != null &&
                          parts.lng != null &&
                          Number.isFinite(lat) &&
                          Number.isFinite(lng);
                        setForm((f) => ({
                          ...f,
                          startText: address || f.startText,
                          startPoint: ok
                            ? { address: address.slice(0, 300), lat, lng }
                            : null,
                        }));
                      }}
                      geocodeOnBlur={false}
                      appearance="admin"
                      placeholder="Start typing the home address"
                      style={sInput}
                    />
                    {startPointNeedsPick(form) && (
                      <div style={{ fontSize: 14, color: D.amber, marginTop: 4 }}>
                        Pick the address from the list
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {/* Work days (GATE_TECH_WORK_DAYS): the weekdays this person works.
                All seven on = every day. Off days are skipped by slot offers
                and automatic booking; the office can still place work there
                and gets a warning. */}
            {workDaysEnabled && (
              <div style={{ gridColumn: "1 / -1" }}>
                {" "}
                <div style={{ fontSize: 14, color: D.muted, marginBottom: 4 }}>
                  Work days
                </div>{" "}
                <div role="group" aria-label="Work days" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {WORK_DAY_OPTIONS.map(({ day, label }) => {
                    const on = form.workDays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setForm((f) => ({
                            ...f,
                            workDays: on ? f.workDays.filter((d) => d !== day) : [...f.workDays, day],
                          }))
                        }
                        style={{
                          ...sBtn(on ? D.green : "transparent", on ? D.white : D.muted),
                          border: `1px solid ${on ? D.green : D.border}`,
                          minWidth: 44,
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>{" "}
                {form.workDays.length === 0 && (
                  <div role="alert" style={{ fontSize: 14, color: D.amber, marginTop: 4 }}>
                    Pick at least one work day
                  </div>
                )}
              </div>
            )}
            {/* Shift hours (GATE_TECH_SHIFT_HOURS): the hours of each work day,
                Eastern time. Both empty = no set hours. */}
            {shiftHoursEnabled && (
              <div style={{ gridColumn: "1 / -1" }}>
                {" "}
                <div style={{ fontSize: 14, color: D.muted, marginBottom: 4 }}>
                  Shift hours
                </div>{" "}
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                  <input
                    id="tech-shift-start"
                    type="time"
                    aria-label="Shift start"
                    value={form.shiftStart}
                    onChange={(e) => setForm((f) => ({ ...f, shiftStart: e.target.value }))}
                    style={{ ...sInput, width: 140 }}
                  />
                  <span style={{ fontSize: 14, color: D.muted }}>to</span>
                  <input
                    id="tech-shift-end"
                    type="time"
                    aria-label="Shift end"
                    value={form.shiftEnd}
                    onChange={(e) => setForm((f) => ({ ...f, shiftEnd: e.target.value }))}
                    style={{ ...sInput, width: 140 }}
                  />
                  {(form.shiftStart || form.shiftEnd) && (
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, shiftStart: "", shiftEnd: "" }))}
                      style={sBtn("transparent", D.muted)}
                    >
                      Clear
                    </button>
                  )}
                </div>{" "}
                {shiftHoursProblem(form) && (
                  <div role="alert" style={{ fontSize: 14, color: D.amber, marginTop: 4 }}>
                    {shiftHoursProblem(form)}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Field eligibility (Field Team Program, Phase 0). Employment
              says whether someone is on staff; this says whether they may
              take field work. Prospective placeholders and office-only
              admins stay OFF, so no booking path can put a customer on
              them. */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
              cursor: "pointer",
            }}
          >
            {" "}
            <input
              type="checkbox"
              checked={form.fieldDispatchable === true}
              onChange={(e) =>
                setForm((f) => ({ ...f, fieldDispatchable: e.target.checked }))
              }
              style={{ width: 14, height: 14, cursor: "pointer" }}
            />{" "}
            <span style={{ fontSize: 14, color: D.heading }}>
              Can be assigned field work
            </span>{" "}
            <span style={{ fontSize: 14, color: D.muted }}>
              (off: never offered as a booking slot or a dispatch target)
            </span>{" "}
          </label>
          {/* (Owner 2026-10-25): may this person move
              their visits (Quick Move, Reschedule)? Admins always can. */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
              cursor: "pointer",
            }}
          >
            {" "}
            <input
              type="checkbox"
              checked={form.canMoveVisits === true}
              onChange={(e) =>
                setForm((f) => ({ ...f, canMoveVisits: e.target.checked }))
              }
              style={{ width: 14, height: 14, cursor: "pointer" }}
            />{" "}
            <span style={{ fontSize: 14, color: D.heading }}>
              Can move visits
            </span>{" "}
            <span style={{ fontSize: 14, color: D.muted }}>
              (off: Quick Move and Reschedule say to ask the office)
            </span>{" "}
          </label>
          {/* The estimate tool (GATE_TECH_ESTIMATES, 2026-11-09): may this person price and save an estimate from the
              phone? Edit only: a new technician starts off, and the create route does not take it. */}
          {editingId && (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 12,
                cursor: "pointer",
              }}
            >
              {" "}
              <input
                type="checkbox"
                checked={form.canCreateEstimates === true}
                onChange={(e) =>
                  setForm((f) => ({ ...f, canCreateEstimates: e.target.checked }))
                }
                style={{ width: 14, height: 14, cursor: "pointer" }}
              />{" "}
              <span style={{ fontSize: 14, color: D.heading }}>
                Can create estimates
              </span>{" "}
              <span style={{ fontSize: 14, color: D.muted }}>
                (off: the Estimate screen does not show for this person)
              </span>{" "}
            </label>
          )}
          {/* Auto-flip opt-out (Phase 2E). Default ON. When OFF, the
              vehicle-exit pipeline skips this tech entirely — useful
              for a tech generating false-positive auto-flip SMS while
              ops fine-tunes thresholds. Customer-side opt-out lives on
              Customer 360. Master toggle lives in system_settings. */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
              cursor: "pointer",
            }}
          >
            {" "}
            <input
              type="checkbox"
              checked={form.autoFlipEnabled !== false}
              onChange={(e) =>
                setForm((f) => ({ ...f, autoFlipEnabled: e.target.checked }))
              }
              style={{ width: 14, height: 14, cursor: "pointer" }}
            />{" "}
            <span style={{ fontSize: 14, color: D.heading }}>
              Auto-flip on EXIT enabled
            </span>{" "}
            <span style={{ fontSize: 14, color: D.muted }}>
              (when off, EXIT events for this tech skip the en-route auto-flip
              pipeline)
            </span>{" "}
          </label>
          {/* Collapsible payroll + personal info. Hidden by default
              for the "+ Add" path so the most common case (just a
              name+phone+email) stays a 3-field form. Auto-expanded
              from startEdit() when a tech already has payroll data. */}
          <button
            type="button"
            onClick={() => setShowPayrollSection((s) => !s)}
            style={{
              padding: "6px 0",
              background: "transparent",
              border: "none",
              color: D.teal,
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
              marginBottom: 8,
              textAlign: "left",
            }}
          >
            {showPayrollSection ? "Hide" : "Show"} Payroll & personal info{" "}
            {showPayrollSection ? "" : "(optional)"}
          </button>
          {showPayrollSection && (
            <div
              style={{
                borderTop: `1px solid ${D.border}`,
                paddingTop: 12,
                marginBottom: 12,
              }}
            >
              {" "}
              <div
                style={{
                  fontSize: 14,
                  color: D.muted,
                  marginBottom: 8,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                Compensation
              </div>{" "}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                  gap: 12,
                  marginBottom: 12,
                }}
              >
                {" "}
                <div>
                  {" "}
                  <label
                    htmlFor="tech-form-pay-rate"
                    style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}
                  >
                    Pay rate ($/hr)
                  </label>{" "}
                  <input
                    id="tech-form-pay-rate"
                    type="number"
                    step="0.25"
                    min="0"
                    value={form.payRate}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, payRate: e.target.value }))
                    }
                    placeholder="35.00"
                    style={sInput}
                  />{" "}
                </div>{" "}
                <div>
                  {" "}
                  <label
                    htmlFor="tech-form-job-title"
                    style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}
                  >
                    Job title
                  </label>{" "}
                  <input
                    id="tech-form-job-title"
                    value={form.jobTitle}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, jobTitle: e.target.value }))
                    }
                    placeholder="Lead Tech"
                    style={sInput}
                  />{" "}
                </div>{" "}
                <div>
                  {" "}
                  <label
                    htmlFor="tech-form-employment-type"
                    style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}
                  >
                    Employment type
                  </label>{" "}
                  <select
                    id="tech-form-employment-type"
                    value={form.employmentType}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, employmentType: e.target.value }))
                    }
                    style={sInput}
                  >
                    {" "}
                    <option value="">--</option> <option value="w2">W-2</option>{" "}
                    <option value="1099">1099</option>{" "}
                  </select>{" "}
                </div>{" "}
                <div>
                  {" "}
                  <label
                    htmlFor="tech-form-hire-date"
                    style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}
                  >
                    Hire date
                  </label>{" "}
                  <input
                    id="tech-form-hire-date"
                    type="date"
                    value={form.hireDate}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, hireDate: e.target.value }))
                    }
                    style={sInput}
                  />{" "}
                </div>{" "}
              </div>{" "}
              <div
                style={{
                  fontSize: 14,
                  color: D.muted,
                  marginBottom: 8,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                Personal
              </div>{" "}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                  gap: 12,
                  marginBottom: 12,
                }}
              >
                {" "}
                <div style={{ gridColumn: "1 / -1" }}>
                  {" "}
                  <label
                    htmlFor="tech-form-address"
                    style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}
                  >
                    Address
                  </label>{" "}
                  <input
                    id="tech-form-address"
                    value={form.address}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, address: e.target.value }))
                    }
                    placeholder="Street, City, FL ZIP"
                    style={sInput}
                  />{" "}
                </div>{" "}
                <div>
                  {" "}
                  <label
                    htmlFor="tech-form-dob"
                    style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}
                  >
                    Date of birth
                  </label>{" "}
                  <input
                    id="tech-form-dob"
                    type="date"
                    value={form.dob}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, dob: e.target.value }))
                    }
                    style={sInput}
                  />{" "}
                </div>{" "}
                <div>
                  {" "}
                  <label
                    htmlFor="tech-form-ssn-last4"
                    style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}
                  >
                    SSN (last 4)
                  </label>{" "}
                  <input
                    id="tech-form-ssn-last4"
                    inputMode="numeric"
                    maxLength={4}
                    value={form.ssnLast4}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        ssnLast4: e.target.value.replace(/\D/g, "").slice(0, 4),
                      }))
                    }
                    placeholder="1234"
                    style={sInput}
                  />{" "}
                </div>{" "}
              </div>{" "}
              <div
                style={{
                  fontSize: 14,
                  color: D.muted,
                  marginBottom: 8,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                Emergency contact
              </div>{" "}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                  gap: 12,
                  marginBottom: 4,
                }}
              >
                {" "}
                <div>
                  {" "}
                  <label
                    htmlFor="tech-form-emergency-name"
                    style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}
                  >
                    Name
                  </label>{" "}
                  <input
                    id="tech-form-emergency-name"
                    aria-label="Emergency contact name"
                    value={form.emergencyContactName}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        emergencyContactName: e.target.value,
                      }))
                    }
                    placeholder="Jane Doe"
                    style={sInput}
                  />{" "}
                </div>{" "}
                <div>
                  {" "}
                  <label
                    htmlFor="tech-form-emergency-phone"
                    style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}
                  >
                    Phone
                  </label>{" "}
                  <input
                    id="tech-form-emergency-phone"
                    aria-label="Emergency contact phone"
                    value={form.emergencyContactPhone}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        emergencyContactPhone: e.target.value,
                      }))
                    }
                    placeholder="+19415551234"
                    style={sInput}
                  />{" "}
                </div>{" "}
              </div>{" "}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            {" "}
            <button
              onClick={handleSave}
              disabled={saving || !form.name.trim() || (!!editingId && startPointNeedsPick(form)) || (workDaysEnabled && form.workDays.length === 0) || (shiftHoursEnabled && !!shiftHoursProblem(form))}
              style={{
                ...sBtn(D.green, D.white),
                opacity: saving || !form.name.trim() || (!!editingId && startPointNeedsPick(form)) || (workDaysEnabled && form.workDays.length === 0) || (shiftHoursEnabled && !!shiftHoursProblem(form)) ? 0.5 : 1,
              }}
            >
              {saving ? "Saving..." : editingId ? "Update" : "Add"}
            </button>{" "}
            <button
              onClick={() => {
                setShowAdd(false);
                setEditingId(null);
                setShowPayrollSection(false);
              }}
              style={sBtn("transparent", D.muted)}
            >
              Cancel
            </button>{" "}
          </div>{" "}
        </div>
      )}
      {/* Hidden file input shared across all photo-upload buttons.
          Triggered via fileInputRef + photoTargetId state. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={handlePhotoSelected}
      />
      {/* Tech list */}
      <div style={sCard}>
        {" "}
        <div style={{ overflowX: "auto" }}>
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}
        >
          {" "}
          <thead>
            {" "}
            <tr>
              {["Photo", "Name", "Phone", "Email", "Status", "Actions"].map(
                (h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: "left",
                      padding: "8px 12px",
                      borderBottom: `1px solid ${D.border}`,
                      fontSize: 14,
                      color: D.muted,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                    }}
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>{" "}
          </thead>{" "}
          <tbody>
            {techs.map((t) => (
              <TeamTechRow
                key={t.id}
                tech={t}
                isAdmin={isAdmin}
                ownStaffId={ownStaffId}
                workDaysEnabled={workDaysEnabled}
                shiftHoursEnabled={shiftHoursEnabled}
                payrollAvailable={payrollAvailable}
                onOpenPayroll={onOpenPayroll}
                uploadingId={uploadingId}
                onEdit={startEdit}
                onEarnings={setEarningsTech}
                onCapabilities={setCapabilitiesTech}
                onPhoto={handlePhotoClick}
                onHire={(row, event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  setHireError("");
                  setHireTech(row);
                }}
                onDeactivate={(row, event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  setDeactivateError("");
                  setDeactivateTech(row);
                }}
                onActivate={handleActivate}
              />
            ))}
            {techs.length === 0 && !loadFailed && (
              <tr>
                <td
                  colSpan={6}
                  style={{ padding: 20, textAlign: "center", color: D.muted }}
                >
                  No technicians found. Add your first one above.
                </td>
              </tr>
            )}
          </tbody>{" "}
        </table></div>{" "}
      </div>
      {isAdmin && serviceLinesEnabled && (
        <ServiceLinesCard techs={techs} showToast={showToast} />
      )}
      {isAdmin && territoryReadoutEnabled && <TerritoryReadoutCard />}
      {earningsTech && (
        <EarningsModal
          tech={earningsTech}
          onClose={() => setEarningsTech(null)}
          showToast={showToast}
        />
      )}
      {capabilitiesTech && (
        <CapabilitiesModal
          tech={capabilitiesTech}
          onClose={() => setCapabilitiesTech(null)}
          onSaved={load}
          showToast={showToast}
        />
      )}
      {hireTech && (
        <HireStaffDialog
          tech={hireTech}
          error={hireError}
          submitting={hiring}
          onCancel={() => {
            if (!hiring) setHireTech(null);
          }}
          onConfirm={(fields) => handleHire(hireTech, fields)}
        />
      )}
      {deactivateTech && (
        <DeactivateStaffDialog
          tech={deactivateTech}
          error={deactivateError}
          submitting={deactivating}
          onCancel={() => {
            if (!deactivating) setDeactivateTech(null);
          }}
          onConfirm={() => handleDeactivate(deactivateTech)}
        />
      )}
    </div>
  );
}

// How a Google-only account stands today (t.hire_google_only, derived on the
// server from the stored link and the sign-in setup). Each line names its own
// way out; an unknown state reads as no sign-in.
const GOOGLE_ONLY_LABELS = {
  ready: "Signs in with Google",
  unlinked: "No sign-in. Link a Google address.",
  bad_address: "No sign-in. Link a company Google address.",
  off: "No sign-in. Staff Google sign-in is off or not set up.",
  returning: "Google-only account. Turn it on from the edit form, or clear its Google sign-in first.",
};

function licenseBadgeInfo(tech) {
  if (!tech.fl_applicator_license && !tech.license_expiry) return null;
  const expiry = tech.license_expiry ? ymdOnly(tech.license_expiry) : "";
  const today = etDateString();
  const soon = addDays(today, 60);
  const expired = expiry && expiry < today;
  const expiringSoon = expiry && !expired && expiry <= soon;
  const tone = expired ? D.red : expiringSoon ? D.amber : D.muted;
  const parts = [];
  if (tech.fl_applicator_license) parts.push(`FL Lic ${tech.fl_applicator_license}`);
  if (expiry) parts.push(expired ? `expired ${expiry}` : `exp ${expiry}`);
  return { text: parts.join(" · "), tone };
}

const ROW_CELL_STYLE = { padding: "10px 12px", borderBottom: `1px solid ${D.border}` };
const ROW_SUB_LINE = { fontSize: 14, fontWeight: 400, color: D.muted, marginTop: 2 };

function rowBtnStyle(color) {
  return {
    padding: "4px 10px",
    background: "transparent",
    border: `1px solid ${D.border}`,
    borderRadius: 6,
    color,
    fontSize: 14,
    cursor: "pointer",
  };
}

function TechAvatar({ tech }) {
  if (tech.avatar_url) {
    return (
      <img
        src={tech.avatar_url}
        alt={tech.name}
        style={{ width: 32, height: 32, borderRadius: "50%", objectFit: "cover", display: "block" }}
      />
    );
  }
  const initials = (tech.name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n.charAt(0).toUpperCase())
    .join("");
  return (
    <div
      aria-hidden
      style={{
        width: 32,
        height: 32,
        borderRadius: "50%",
        background: D.border,
        color: D.muted,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 14,
        fontWeight: 500,
      }}
    >
      {initials}
    </div>
  );
}

function isRecentOrProspectiveHire(tech, status) {
  if (status === "prospective") return true;
  if (status !== "active" || !tech.hire_date) return false;
  const hireDay = ymdOnly(tech.hire_date);
  return Boolean(hireDay && hireDay >= addDays(etDateString(), -14));
}

function OnboardingReadinessStrip({ tech, status, payrollAvailable, onOpenPayroll }) {
  if (!isRecentOrProspectiveHire(tech, status)) return null;
  const profileReady = Boolean(tech.email && tech.hire_date && tech.pay_rate != null && tech.pay_rate !== "");
  const loginReady = Boolean(tech.google_email || tech.hire_google_only === "ready" || status === "active");
  const capsReady = Boolean(tech.capability_summary && Number(tech.capability_summary.qualified) > 0);
  const items = [
    { key: "profile", label: "Profile & pay", done: profileReady },
    { key: "login", label: "Google login", done: loginReady },
    { key: "caps", label: "Capabilities", done: capsReady },
  ];
  return (
    <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 12, color: D.muted, fontWeight: 600 }}>Onboarding:</span>
      {items.map((item) => (
        <span
          key={item.key}
          style={{
            fontSize: 12,
            padding: "2px 6px",
            borderRadius: 4,
            background: item.done ? `${D.green}18` : `${D.amber}18`,
            color: item.done ? D.green : D.amber,
            fontWeight: 500,
          }}
        >
          {item.done ? "✓" : "○"} {item.label}
        </span>
      ))}
      {payrollAvailable && onOpenPayroll && (
        <button
          type="button"
          onClick={onOpenPayroll}
          style={{
            padding: "2px 8px",
            minHeight: 28,
            background: "transparent",
            border: `1px solid ${D.border}`,
            borderRadius: 4,
            color: D.teal,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Payroll setup
        </button>
      )}
      {status === "prospective" && (
        <a
          href="/admin/recruiting"
          style={{ fontSize: 12, color: D.teal, textDecoration: "underline", padding: "2px 4px" }}
        >
          Recruiting
        </a>
      )}
    </div>
  );
}

function TechRowActions({
  tech: t,
  isAdmin,
  ownStaffId,
  uploadingId,
  onEdit,
  onEarnings,
  onCapabilities,
  onPhoto,
  onHire,
  onDeactivate,
  onActivate,
}) {
  const canPhoto = isAdmin || t.id === ownStaffId;
  const photoOpacity = uploadingId !== null && uploadingId !== t.id ? 0.4 : uploadingId === t.id ? 0.6 : 1;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {isAdmin && (
        <>
          <button onClick={() => onEdit(t)} style={rowBtnStyle(D.teal)}>Edit</button>
          <button onClick={() => onEarnings(t)} style={rowBtnStyle(D.green)}>Earnings</button>
          <button onClick={() => onCapabilities(t)} style={rowBtnStyle(D.teal)}>Capabilities</button>
        </>
      )}
      {canPhoto && (
        <button
          onClick={() => onPhoto(t.id)}
          disabled={uploadingId !== null}
          style={{
            ...rowBtnStyle(D.teal),
            cursor: uploadingId !== null ? "wait" : "pointer",
            opacity: photoOpacity,
          }}
        >
          {uploadingId === t.id ? "Uploading…" : "Photo"}
        </button>
      )}
      {t.hire_action === "hire" && (
        <button
          onClick={(event) => onHire(t, event)}
          style={{
            padding: "4px 10px",
            background: D.teal,
            border: `1px solid ${D.teal}`,
            borderRadius: 6,
            color: D.white,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Hired
        </button>
      )}
      {isAdmin && t.hire_action !== "hire" && (
        <button
          onClick={(event) => (t.active ? onDeactivate(t, event) : onActivate(t))}
          title={t.employment_status === "prospective" ? "Marks this hire as started. They sign in with their linked Google account or set a password via Forgot password on the admin login." : undefined}
          style={rowBtnStyle(t.active ? D.amber : D.green)}
        >
          {t.active ? "Deactivate" : "Activate"}
        </button>
      )}
    </div>
  );
}

function formatTechPayMeta(tech) {
  return [
    tech.job_title || "",
    tech.pay_rate != null && tech.pay_rate !== "" ? `$${parseFloat(tech.pay_rate).toFixed(2)}/hr` : "",
    tech.employment_type ? (tech.employment_type === "w2" ? "W-2" : "1099") : "",
  ].filter(Boolean).join(" · ");
}

function TechDetailsCell({ tech: t, isAdmin, status, workDaysEnabled, shiftHoursEnabled, payrollAvailable, onOpenPayroll }) {
  const licenseInfo = isAdmin ? licenseBadgeInfo(t) : null;
  const payMeta = formatTechPayMeta(t);
  const workDaysText = workDaysEnabled ? describeWorkDays(t.work_days) : "";
  const shiftHoursText = shiftHoursEnabled ? describeShiftHours(t.shift_start, t.shift_end) : "";
  return (
    <td style={{ ...ROW_CELL_STYLE, color: D.heading, fontWeight: 500 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span>{t.name}</span>
        {t.role === "admin" && <span style={sBadge(D.border, D.text)}>Admin</span>}
      </div>
      {isAdmin && <div style={ROW_SUB_LINE}>{describeStartPoint(t)}</div>}
      {workDaysText && <div style={ROW_SUB_LINE}>{`Works ${workDaysText}`}</div>}
      {shiftHoursText && <div style={ROW_SUB_LINE}>{`Shift ${shiftHoursText}`}</div>}
      {payMeta && <div style={ROW_SUB_LINE}>{payMeta}</div>}
      {licenseInfo && <div style={{ ...ROW_SUB_LINE, color: licenseInfo.tone }}>{licenseInfo.text}</div>}
      {isAdmin && (
        <OnboardingReadinessStrip
          tech={t}
          status={status}
          payrollAvailable={payrollAvailable}
          onOpenPayroll={onOpenPayroll}
        />
      )}
    </td>
  );
}

function TechStatusCell({ tech: t, status }) {
  const statusTone = status === "active" ? D.green : status === "prospective" ? D.amber : D.red;
  const statusLabel = status === "active" ? "Active" : status === "prospective" ? "Prospective" : "Inactive";
  const showCapabilities = Boolean(t.capability_summary && (t.field_dispatchable || t.employment_status === "prospective"));
  return (
    <td style={ROW_CELL_STYLE}>
      <span style={sBadge(statusTone + "22", statusTone)}>{statusLabel}</span>
      {t.employment_status === "active" && (
        <div style={{ fontSize: 14, color: D.muted, marginTop: 4 }}>
          {t.field_dispatchable ? "Field dispatchable" : "Office only"}
        </div>
      )}
      {t.hire_google_only && (
        <div style={{ fontSize: 14, color: D.muted, marginTop: 4 }}>
          {GOOGLE_ONLY_LABELS[t.hire_google_only] || GOOGLE_ONLY_LABELS.off}
        </div>
      )}
      {showCapabilities && (
        <div style={{ fontSize: 14, color: D.muted, marginTop: 4 }}>
          {summarizeCapabilityCounts(t.capability_summary)}
        </div>
      )}
    </td>
  );
}

function TeamTechRow({
  tech: t,
  isAdmin,
  ownStaffId,
  workDaysEnabled,
  shiftHoursEnabled,
  payrollAvailable,
  onOpenPayroll,
  uploadingId,
  onEdit,
  onEarnings,
  onCapabilities,
  onPhoto,
  onHire,
  onDeactivate,
  onActivate,
}) {
  const status = t.employment_status || (t.active ? "active" : "inactive");
  const formattedTwilio = t.twilio_number
    ? TECH_LINE_NUMBERS.find((n) => n.number === t.twilio_number)?.formatted || t.twilio_number
    : null;

  return (
    <tr style={{ opacity: status === "inactive" ? 0.5 : 1 }}>
      <td style={ROW_CELL_STYLE}>
        <TechAvatar tech={t} />
      </td>
      <TechDetailsCell
        tech={t}
        isAdmin={isAdmin}
        status={status}
        workDaysEnabled={workDaysEnabled}
        shiftHoursEnabled={shiftHoursEnabled}
        payrollAvailable={payrollAvailable}
        onOpenPayroll={onOpenPayroll}
      />
      <td style={{ ...ROW_CELL_STYLE, color: D.muted, fontFamily: MONO, fontSize: 14 }}>
        {t.phone || "\u2014"}
        {formattedTwilio && <div style={{ fontSize: 14, color: D.muted, marginTop: 2 }}>Line {formattedTwilio}</div>}
      </td>
      <td style={{ ...ROW_CELL_STYLE, color: D.muted, fontSize: 14 }}>
        {t.email || "\u2014"}
      </td>
      <TechStatusCell tech={t} status={status} />
      <td style={ROW_CELL_STYLE}>
        <TechRowActions
          tech={t}
          isAdmin={isAdmin}
          ownStaffId={ownStaffId}
          uploadingId={uploadingId}
          onEdit={onEdit}
          onEarnings={onEarnings}
          onCapabilities={onCapabilities}
          onPhoto={onPhoto}
          onHire={onHire}
          onDeactivate={onDeactivate}
          onActivate={onActivate}
        />
      </td>
    </tr>
  );
}

// One click turns a prospective placeholder into an active staff account that
// signs in with its linked company Google address and nothing else: no password
// and no email. Email and first day are required; the rest is prefilled from the row.
function HireStaffDialog({ tech, error, submitting, onCancel, onConfirm }) {
  const dialogRef = useModalFocus(true, () => {
    if (!submitting) onCancel();
  });
  const titleId = `hire-staff-title-${tech.id}`;
  const [form, setForm] = useState(() => ({
    name: tech.name || "",
    email: tech.email || "",
    phone: tech.phone || "",
    hireDate: tech.hire_date ? String(tech.hire_date).split("T")[0] : "",
    payRate: tech.pay_rate != null ? String(tech.pay_rate) : "",
    jobTitle: tech.job_title || "",
    employmentType: tech.employment_type || "",
  }));
  const [showRequired, setShowRequired] = useState(false);
  const missing = !form.name.trim() || !form.email.trim() || !form.hireDate;
  const set = (key) => (event) => {
    const value = event.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  };
  const submit = () => {
    if (missing) {
      setShowRequired(true);
      return;
    }
    onConfirm({
      name: form.name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      hireDate: form.hireDate,
      payRate: form.payRate.trim(),
      jobTitle: form.jobTitle.trim(),
      employmentType: form.employmentType,
      // The Google address this form showed as the sign-in. The server refuses the press when the row no
      // longer holds exactly that.
      googleEmail: tech.google_email,
    });
  };
  const field = (id, label, input, required) => (
    <div style={{ marginBottom: 12 }}>
      <label htmlFor={`${titleId}-${id}`} style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}>
        {label}
        {required ? " *" : ""}
      </label>
      {input}
    </div>
  );

  return createPortal(
    <div
      className="staff-foundation staff-legacy"
      onClick={() => {
        if (!submitting) onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "calc(16px + env(safe-area-inset-top, 0px)) calc(16px + env(safe-area-inset-right, 0px)) calc(16px + env(safe-area-inset-bottom, 0px)) calc(16px + env(safe-area-inset-left, 0px))",
        overflowY: "auto",
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        style={{
          background: D.card,
          border: `1px solid ${D.border}`,
          borderRadius: 6,
          width: "100%",
          maxWidth: 480,
          maxHeight: "100%",
          overflowY: "auto",
          padding: 20,
          boxSizing: "border-box",
        }}
      >
        <div id={titleId} style={{ fontSize: 18, fontWeight: 500, color: D.heading }}>
          Hire {tech.name}
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.55, color: D.text, margin: "12px 0 16px" }}>
          {`This makes them an active staff member. They sign in with Google as ${tech.google_email}. They get no password and no email is sent.`}
        </p>
        {field("name", "Name", <input id={`${titleId}-name`} value={form.name} onChange={set("name")} style={sInput} />, true)}
        {field("email", "Email", <input id={`${titleId}-email`} type="email" value={form.email} onChange={set("email")} placeholder="name@example.com" style={sInput} />, true)}
        {field("phone", "Mobile phone", <input id={`${titleId}-phone`} type="tel" value={form.phone} onChange={set("phone")} placeholder="+19415551234" style={sInput} />)}
        {field("hireDate", "First day", <input id={`${titleId}-hireDate`} type="date" value={form.hireDate} onChange={set("hireDate")} style={sInput} />, true)}
        {field("payRate", "Pay rate", <input id={`${titleId}-payRate`} type="number" min="0" step="0.01" value={form.payRate} onChange={set("payRate")} placeholder="Per hour" style={sInput} />)}
        {field("jobTitle", "Job title", <input id={`${titleId}-jobTitle`} value={form.jobTitle} onChange={set("jobTitle")} style={sInput} />)}
        {field(
          "employmentType",
          "Employment type",
          <select id={`${titleId}-employmentType`} value={form.employmentType} onChange={set("employmentType")} style={sInput}>
            <option value="">Not set</option>
            <option value="w2">W-2 employee</option>
            <option value="1099">1099 contractor</option>
          </select>,
        )}
        {showRequired && missing && (
          <div role="alert" style={{ color: D.red, fontSize: 14, lineHeight: 1.55, marginBottom: 8 }}>
            Name, email and first day are required.
          </div>
        )}
        {error && (
          <div role="alert" style={{ color: D.red, fontSize: 14, lineHeight: 1.55, marginBottom: 8 }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          <button type="button" onClick={onCancel} disabled={submitting} style={sBtn("transparent", D.text)}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            aria-busy={submitting || undefined}
            style={{ ...sBtn(D.teal, D.white), cursor: submitting ? "wait" : "pointer", opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? "Hiring…" : "Hire with Google sign-in"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function DeactivateStaffDialog({ tech, error, submitting, onCancel, onConfirm }) {
  const dialogRef = useModalFocus(true, () => {
    if (!submitting) onCancel();
  });
  const titleId = `deactivate-staff-title-${tech.id}`;

  return createPortal(
    <div
      className="staff-foundation staff-legacy"
      onClick={() => {
        if (!submitting) onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "calc(16px + env(safe-area-inset-top, 0px)) calc(16px + env(safe-area-inset-right, 0px)) calc(16px + env(safe-area-inset-bottom, 0px)) calc(16px + env(safe-area-inset-left, 0px))",
        overflowY: "auto",
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        style={{
          background: D.card,
          border: `1px solid ${D.border}`,
          borderRadius: 6,
          width: "100%",
          maxWidth: 480,
          maxHeight: "100%",
          overflowY: "auto",
          padding: 20,
          boxSizing: "border-box",
        }}
      >
        <div id={titleId} style={{ fontSize: 18, fontWeight: 500, color: D.heading }}>
          Deactivate {tech.name}?
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.55, color: D.text, margin: "12px 0 0" }}>
          They will be signed out and can no longer access Staff tools. Historical time, payroll, job, and audit records will be kept.
        </p>
        {error && (
          <div role="alert" style={{ color: D.red, fontSize: 14, lineHeight: 1.55, marginTop: 12 }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 8, marginTop: 20 }}>
          <button type="button" onClick={onCancel} disabled={submitting} style={sBtn("transparent", D.text)}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            aria-busy={submitting || undefined}
            style={{ ...sBtn(D.red, D.white), cursor: submitting ? "wait" : "pointer", opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? "Deactivating…" : "Deactivate"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Roster sublabel for the Team table: "5 qualified", "2 need review · 1 off",
// or "Capabilities not set" when the row predates the editor.
function summarizeCapabilityCounts(summary) {
  const parts = [];
  if (summary.qualified) parts.push(`${summary.qualified} qualified`);
  if (summary.review_required) parts.push(`${summary.review_required} need${summary.review_required === 1 ? "s" : ""} review`);
  if (summary.off) parts.push(`${summary.off} off`);
  if (!parts.length) return "Capabilities not set";
  if (summary.unset) parts.push(`${summary.unset} not set`);
  return parts.join(" \u00b7 ");
}

const CAPABILITY_STATE_OPTIONS = [
  { value: "qualified", label: "Qualified", hint: "Auto-dispatch offers this work freely." },
  { value: "review_required", label: "Needs review", hint: "Offered, but scored lower until verified." },
  { value: "off", label: "Off", hint: "Never auto-dispatched; existing visits stay put." },
];

// The "Waves Tech" voice line PIN (hands-free field voice). Set or reset only:
// the server keeps a salted hash, so a PIN is never read back, shown again or
// kept here after the request. 4 to 6 digits; a reset also clears a lockout.
export function TechVoicePinField({ technicianId }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const valid = /^\d{4,6}$/.test(pin);
  const handleSetPin = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setMessage("");
    try {
      await adminFetch(`/admin/timetracking/technicians/${technicianId}/voice-pin`, { method: "PUT", body: JSON.stringify({ pin }) });
      setMessage("PIN set. Give it to the technician in person.");
    } catch (err) {
      setMessage(err?.data?.error || "The PIN was not set. Try again.");
    } finally {
      setPin("");
      setBusy(false);
    }
  };
  // A technician being added has no id yet: the PIN is set after the save.
  if (!technicianId) return null;
  return (
    <div>
      <label htmlFor="tech-form-voice-pin" style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}>
        Voice line PIN
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          id="tech-form-voice-pin"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          placeholder="4 to 6 digits"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          style={sInput}
        />
        <button type="button" onClick={handleSetPin} disabled={!valid || busy} style={{ ...sBtn(D.teal, D.white), opacity: valid && !busy ? 1 : 0.5 }}>
          {busy ? "Setting…" : "Set PIN"}
        </button>
      </div>
      {pin.length > 0 && !message && (
        <div style={{ fontSize: 13, color: D.amber, marginTop: 4 }}>
          Click Set PIN to save — Update does not save the PIN.
        </div>
      )}
      {message && (
        <div role="status" style={{ fontSize: 14, color: D.muted, marginTop: 4 }}>
          {message}
        </div>
      )}
    </div>
  );
}

// Capabilities editor (Field Team Program, Phase 0 item 4) — the five dispatch
// categories auto-dispatch reads from technician_capabilities. Saving stamps
// the signed-in admin as verifier. A category turned Off never moves a visit;
// anything already assigned in that category is named in the toast for
// manual reassignment on the Schedule.
function CapabilitiesModal({ tech, onClose, onSaved, showToast }) {
  const isMobile = useIsMobile(640);
  const [rows, setRows] = useState(null);
  // What the server returned — dirty rows and the optimistic baseline are
  // computed against it at save time.
  const [initialRows, setInitialRows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  // `attempt` re-runs the fetch for the Retry button (and after a stale save).
  const [attempt, setAttempt] = useState(0);
  const dialogRef = useRef(null);
  const titleId = `capabilities-title-${tech.id}`;

  // Dialog semantics: focus moves into the dialog on open, stays inside it
  // (Tab cycles), Escape closes, and focus returns to the opener on close.
  useEffect(() => {
    const opener = document.activeElement;
    const node = dialogRef.current;
    const focusable = () => Array.from(node?.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])') || []).filter((el) => !el.disabled);
    focusable()[0]?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "Tab") return;
      const els = focusable();
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener && typeof opener.focus === "function") opener.focus();
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await adminFetch(
          `/admin/timetracking/technicians/${tech.id}/capabilities`,
        );
        if (!cancelled) {
          const loaded = res.capabilities || [];
          setInitialRows(loaded);
          setRows(
            loaded.map((c) => ({
              ...c,
              // Editing starts every unset category at "Needs review" so a
              // save without touching a row still gives auto-dispatch a
              // real answer instead of the 'unset' half-credit.
              state: c.state === "unset" ? "review_required" : c.state,
              notes: c.notes || "",
            })),
          );
        }
      } catch (e) {
        // Rendered in the modal (not just a transient toast) so the admin can
        // see the failure and retry without closing.
        if (!cancelled) setLoadError(e.message || "Request failed");
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tech.id, attempt]);

  const setRow = (category, patch) =>
    setRows((prev) =>
      prev.map((r) => (r.service_category === category ? { ...r, ...patch } : r)),
    );

  const handleSave = async () => {
    if (!rows || !initialRows) return;
    // Only rows this admin changed (plus categories that had no row yet) are
    // sent, each pinned to the updated_at it was edited from — a concurrent
    // save by someone else on another category is never reverted, and a
    // concurrent change to the SAME category is refused (409) and reloaded.
    const byCat = new Map(initialRows.map((c) => [c.service_category, c]));
    const dirty = rows.filter((r) => {
      const was = byCat.get(r.service_category);
      if (!was || was.state === "unset") return true;
      return was.state !== r.state || (was.notes || "") !== r.notes.trim();
    });
    if (!dirty.length) {
      showToast("No capability changes to save");
      onClose();
      return;
    }
    setSaving(true);
    try {
      const res = await adminFetch(
        `/admin/timetracking/technicians/${tech.id}/capabilities`,
        {
          method: "PUT",
          body: JSON.stringify({
            capabilities: dirty.map((r) => {
              const was = byCat.get(r.service_category);
              return {
                service_category: r.service_category,
                state: r.state,
                notes: r.notes.trim() || null,
                expected_updated_at: was && was.updated_at ? new Date(was.updated_at).toISOString() : null,
              };
            }),
          }),
        },
      );
      const pending = (res && res.futureAssignedVisits) || [];
      showToast(
        pending.length
          ? `Capabilities saved — ${pending.length} upcoming visit${pending.length === 1 ? "" : "s"} in a category now off; reassign on the Schedule`
          : "Capabilities saved",
      );
      onSaved();
      onClose();
    } catch (e) {
      if (e?.status === 409 || /HTTP 409/.test(e.message)) {
        showToast("Someone else changed this technician's capabilities — reloaded, please review and save again", { error: true });
        setAttempt((n) => n + 1);
      } else {
        showToast("Failed: " + errMessage(e));
      }
    }
    setSaving(false);
  };

  const fmtVerified = (r) => {
    if (!r.verified_at) return r.source === "system_default" ? "Default — not yet verified" : "Not verified";
    // Eastern wall clock, like every other date on the portal — a verification
    // near midnight must not shift a day on an admin's phone set elsewhere.
    const when = formatETDate(r.verified_at, { month: "short", day: "numeric", year: "numeric" });
    return `Verified ${when}${r.verified_by_name ? ` by ${r.verified_by_name}` : ""}`;
  };

  return createPortal(
    <div
      className="staff-foundation staff-legacy"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
        // Standalone iOS PWA: viewport-fit=cover puts this overlay under the
        // status bar / home indicator without the safe-area insets.
        padding:
          "calc(16px + env(safe-area-inset-top, 0px)) 16px calc(16px + env(safe-area-inset-bottom, 0px))",
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: D.card,
          border: `1px solid ${D.border}`,
          borderRadius: 12,
          width: "100%",
          maxWidth: 640,
          maxHeight: "90vh",
          overflowY: "auto",
          padding: isMobile ? 16 : 24,
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
          <div id={titleId} style={{ fontSize: 16, fontWeight: 600, color: D.heading }}>
            Capabilities — {tech.name}
          </div>
          <button
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: D.muted, fontSize: 14, cursor: "pointer" }}
          >
            Close
          </button>
        </div>
        <div style={{ fontSize: 14, color: D.muted, marginBottom: 16 }}>
          What auto-dispatch may place on this technician's route. Nothing
          here moves a visit that is already scheduled.
        </div>

        {loadError && !loading ? (
          <div
            role="alert"
            style={{ padding: 20, textAlign: "center", color: D.text, fontSize: 14, display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}
          >
            <div>Couldn't load capabilities: {loadError}</div>
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              style={{
                padding: "6px 14px",
                background: "transparent",
                border: `1px solid ${D.border}`,
                borderRadius: 6,
                color: D.teal,
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              Retry
            </button>
          </div>
        ) : loading || !rows ? (
          <div style={{ padding: 24, textAlign: "center", color: D.muted, fontSize: 14 }}>
            Loading…
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {rows.map((r) => (
              <div
                key={r.service_category}
                style={{
                  border: `1px solid ${D.border}`,
                  borderRadius: 8,
                  padding: 12,
                  display: "grid",
                  gridTemplateColumns: isMobile ? "1fr" : "200px 1fr",
                  gap: 10,
                  alignItems: "start",
                }}
              >
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: D.heading }}>
                    {r.label}
                  </div>
                  <div style={{ fontSize: 14, color: D.muted, marginTop: 2 }}>
                    {fmtVerified(r)}
                  </div>
                </div>
                <div>
                  <div
                    role="radiogroup"
                    aria-label={`${r.label} capability`}
                    style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
                  >
                    {CAPABILITY_STATE_OPTIONS.map((opt) => {
                      const selected = r.state === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          title={opt.hint}
                          onClick={() => setRow(r.service_category, { state: opt.value })}
                          style={{
                            padding: "6px 12px",
                            borderRadius: 6,
                            border: `1px solid ${selected ? D.teal : D.border}`,
                            background: selected ? D.teal : "transparent",
                            color: selected ? D.white : D.text,
                            fontSize: 14,
                            fontWeight: 500,
                            cursor: "pointer",
                          }}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                  <input
                    value={r.notes}
                    onChange={(e) => setRow(r.service_category, { notes: e.target.value })}
                    aria-label={`${r.label} note`}
                    placeholder="Note (optional) — e.g. ride-along completed 9/4"
                    maxLength={500}
                    style={{ ...sInput, fontSize: 14, marginTop: 8 }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button
            onClick={onClose}
            style={{
              padding: "8px 14px",
              background: "transparent",
              border: `1px solid ${D.border}`,
              borderRadius: 8,
              color: D.text,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || loading || !rows || !!loadError}
            style={{
              padding: "8px 14px",
              background: D.teal,
              border: `1px solid ${D.teal}`,
              borderRadius: 8,
              color: D.white,
              fontSize: 14,
              fontWeight: 500,
              cursor: saving ? "wait" : "pointer",
              opacity: saving || loading ? 0.6 : 1,
            }}
          >
            {saving ? "Saving…" : "Save capabilities"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Earnings statement modal — pulls /admin/timetracking/technicians/:id/earnings
// for this week and last week. Regular hours pay at the tech's rate
// (or $35 fallback shown explicitly so an admin can spot a missing
// pay_rate config), OT at 1.5×.
function EarningsModal({ tech, onClose, showToast }) {
  // Reactive (rotation-safe) — the module-level snapshot never recomputes.
  const isMobile = useIsMobile(640);
  const dialogRef = useModalFocus(true, onClose);
  const [thisWeek, setThisWeek] = useState(null);
  const [lastWeek, setLastWeek] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // Keep a stable handle on showToast so the fetch effect can stay
  // keyed only on tech.id. The parent recreates showToast on every
  // render; if we depended on it directly, a failed fetch would call
  // it, the parent would re-render with a new identity, the effect
  // would re-fire, and we'd loop the API.
  const showToastRef = useRef(showToast);
  useEffect(() => {
    showToastRef.current = showToast;
  }, [showToast]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError("");
      try {
        // Server anchors the week boundaries on ET so admins outside
        // ET (or hitting this near midnight) can't drift onto the
        // wrong payroll week — we just ask for "this week" / "last
        // week" and let the endpoint compute the dates.
        const [a, b] = await Promise.all([
          adminFetch(
            `/admin/timetracking/technicians/${tech.id}/earnings?period=this-week`,
          ),
          adminFetch(
            `/admin/timetracking/technicians/${tech.id}/earnings?period=last-week`,
          ),
        ]);
        if (!cancelled) {
          setThisWeek(a);
          setLastWeek(b);
        }
      } catch (e) {
        if (!cancelled) {
          const msg = errMessage(e);
          setLoadError(msg);
          showToastRef.current("Earnings failed: " + msg);
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tech.id, attempt]);

  return createPortal(
    <div
      className="staff-foundation staff-legacy"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
        padding: isMobile ? 0 : 16,
      }}
    >
      {" "}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${tech.name} earnings statement`}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: D.card,
          border: `1px solid ${D.border}`,
          borderRadius: 12,
          padding: 24,
          maxWidth: 520,
          width: "100%",
          boxShadow: "0 16px 48px rgba(0,0,0,0.25)",
          ...(isMobile
            ? {
                width: "100%",
                maxWidth: "none",
                height: "100%",
                maxHeight: "none",
                borderRadius: 0,
                boxSizing: "border-box",
                overflowY: "auto",
                paddingTop: "calc(24px + env(safe-area-inset-top, 0px))",
                paddingBottom: "calc(24px + env(safe-area-inset-bottom, 0px))",
                paddingLeft: "calc(24px + env(safe-area-inset-left, 0px))",
                paddingRight: "calc(24px + env(safe-area-inset-right, 0px))",
              }
            : {}),
        }}
      >
        {" "}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          {" "}
          <div>
            {" "}
            <div style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>
              {tech.name}
            </div>{" "}
            <div style={{ fontSize: 14, color: D.muted, marginTop: 2 }}>
              Earnings statement
            </div>{" "}
          </div>{" "}
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: D.muted,
              fontSize: 22,
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            ×
          </button>{" "}
        </div>
        {loading && (
          <div style={{ color: D.muted, padding: 20, textAlign: "center" }}>
            Loading…
          </div>
        )}
        {!loading && loadError && (
          <div role="alert" style={{ padding: 20, textAlign: "center", color: D.red, fontSize: 14 }}>
            <div style={{ marginBottom: 10 }}>Could not load earnings: {loadError}</div>
            <button type="button" onClick={() => setAttempt((n) => n + 1)} style={sBtn(D.card, D.text)}>
              Retry
            </button>
          </div>
        )}
        {!loading && !loadError && thisWeek && (
          <>
            {" "}
            <EarningsBlock label="This week" data={thisWeek} />{" "}
            <div style={{ height: 12 }} />{" "}
            <EarningsBlock label="Last week" data={lastWeek} />{" "}
          </>
        )}
        {!loading && thisWeek && thisWeek.payRateSource === "default" && (
          <div
            style={{
              marginTop: 12,
              padding: "8px 12px",
              background: "#FEF3C7",
              border: `1px solid ${D.amber}`,
              borderRadius: 6,
              fontSize: 14,
              color: "#78350F",
            }}
          >
            No pay rate configured — using fallback $
            {thisWeek.payRate.toFixed(2)}/hr. Set one in this tech's profile for
            accurate numbers.
          </div>
        )}
      </div>{" "}
    </div>,
    document.body,
  );
}

function EarningsBlock({ label, data }) {
  if (!data) return null;
  const regHrs = (data.regularMinutes / 60).toFixed(2);
  const otHrs = (data.overtimeMinutes / 60).toFixed(2);
  return (
    <div
      style={{ border: `1px solid ${D.border}`, borderRadius: 8, padding: 12 }}
    >
      {" "}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 8,
        }}
      >
        {" "}
        <span
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: D.muted,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {label}
        </span>{" "}
        <span style={{ fontSize: 14, color: D.muted, fontFamily: MONO }}>
          {data.from} → {data.to}
        </span>{" "}
      </div>{" "}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 8,
          marginBottom: 8,
        }}
      >
        {" "}
        <Stat label="Regular" value={`${regHrs}h`} />{" "}
        <Stat label="OT" value={`${otHrs}h`} warn={data.overtimeMinutes > 0} />{" "}
        <Stat label="Days" value={data.daysWorked} />{" "}
      </div>{" "}
      <div
        style={{
          borderTop: `1px solid ${D.border}`,
          paddingTop: 8,
          fontSize: 14,
          color: D.muted,
          fontFamily: MONO,
        }}
      >
        {" "}
        <div>
          Reg: {fmt(data.regularPay)} · OT (1.5×): {fmt(data.overtimePay)}
        </div>{" "}
        <div
          style={{
            marginTop: 4,
            fontSize: 14,
            fontWeight: 700,
            color: D.heading,
          }}
        >
          Gross: {fmt(data.grossPay)}
        </div>{" "}
      </div>{" "}
    </div>
  );
}
