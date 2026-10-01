// Pricing hub → Rate review: the admin screen for the annual rate review
// (plan annual-rate-review-2026-09-30; approved mockup "Admin · Pricing →
// Rate review"). Embedded under PricingHubPage like AdminPriceChangePage —
// the hub owns the h1 and the area tabs.
//
// Dark behind GATE_RATE_REVIEW: every /api/admin/rate-review route answers
// 404 while the gate is off, the hub probes once (useRateReviewAvailable)
// and never shows the area. Nothing here sends a customer anything: Approve
// marks green rows 'approved' against a digest of the batch; the notices
// themselves (and the letter preview) arrive with the comms lane.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { adminFetch } from "../../utils/admin-fetch";
import {
  ActionFeedback, Badge, Button, Card, CardBody, Checkbox, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle,
  Field, Input, Select, Sheet, SheetBody, SheetHeader, Table, TBody, TD, TH, THead, TR, Textarea, UiSurface,
} from "../../components/ui";

const NOTICE_DAYS = 30;
const NOTICE_STATUSES = ["green", "approved", "sent", "applied"];
const LOCKED_STATUSES = ["approved", "sent", "applied"];
// Money, dates and short labels never break mid-value; the table scrolls
// sideways instead (ui-table-cell's overflow-wrap would split "$105").
const NOWRAP = "whitespace-nowrap";
// Right-aligned on the desktop grid; on the records layout (≤1100px) every
// cell is "label · value", so the value reads left like its neighbours.
const NUM = `${NOWRAP} max-[1100px]:text-left`;

const LINE_LABELS = {
  pest_control: "Pest", lawn_care: "Lawn", tree_shrub: "Tree & shrub", mosquito: "Mosquito", termite: "Termite", rodent: "Rodent", other: "Other",
};
const CADENCE_LABELS = {
  quarterly: "Quarterly", bimonthly: "Bi-monthly", monthly: "Monthly", every_6_weeks: "Every 6 weeks", semiannual: "Twice a year", seasonal: "Seasonal", other: "Other",
};
const BAND_LABELS = { A: "A · well priced", B: "B · at list", C: "C · under list", D: "D · badly under" };
// Exception flags → the reason chip. Red only for money owed; amber for a
// recent service problem; everything else neutral.
const EXCEPTION_REASONS = {
  past_due: ["Past due", "alert"],
  callback_recent: ["Recent callback", "warn"],
  complaint_open: ["Open complaint", "warn"],
  cancellation_case_recent: ["Recent cancellation case", "warn"],
  tenure_under_lock: ["Under 12 months", "neutral"],
  prepay_mid_term: ["Prepay mid-term", "neutral"],
  prepay_term_missing: ["Prepay term missing", "neutral"],
  prepay_term_ambiguous: ["Prepay term unclear", "neutral"],
  reviewed_within_12mo: ["Reviewed within 12 months", "neutral"],
  manual_rate_edit_recent: ["Rate edited by hand recently", "neutral"],
  retention_offer_active: ["Retention offer active", "neutral"],
  plan_hold_active: ["Plan on hold", "neutral"],
  hand_picked_tier: ["Hand-picked tier", "neutral"],
  commercial: ["Commercial", "neutral"],
  termite_program: ["Termite program", "neutral"],
  multi_property: ["Multi-property", "neutral"],
  lane_cleanup: ["Billing lane needs cleanup", "neutral"],
  cadence_conflict: ["Cadence conflict", "neutral"],
  rate_unattributed: ["Rate unattributed", "neutral"],
  facts_unavailable: ["Account facts unavailable", "neutral"],
  facts_degraded: ["Money facts degraded", "neutral"],
  no_anniversary: ["No anniversary", "neutral"],
  no_current_rate: ["No current rate", "neutral"],
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

// ── formatting ────────────────────────────────────────────────────────────

function dollars(cents) {
  const n = (Number(cents) || 0) / 100;
  const whole = Number.isInteger(n);
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function signedDollars(cents) {
  const n = Number(cents) || 0;
  return `${n < 0 ? "-" : "+"}${dollars(Math.abs(n))}`;
}

function ymdParts(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ""));
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

// 'YYYY-MM-DD' → 'Jan 6, 2027' without a Date round-trip (a DATE column is a
// calendar day, never an instant the browser's zone could shift).
function fmtDay(ymd, { year = true } = {}) {
  const p = ymdParts(ymd);
  if (!p) return "—";
  return `${MONTHS_SHORT[p.m - 1]} ${p.d}${year ? `, ${p.y}` : ""}`;
}

function fmtRange(from, to) {
  const a = ymdParts(from);
  const b = ymdParts(to);
  if (!a || !b) return "—";
  if (a.y === b.y && a.m === b.m) return `${MONTHS_SHORT[a.m - 1]} ${a.d}–${b.d}, ${a.y}`;
  if (a.y === b.y) return `${MONTHS_SHORT[a.m - 1]} ${a.d}–${MONTHS_SHORT[b.m - 1]} ${b.d}, ${a.y}`;
  return `${fmtDay(from)}–${fmtDay(to)}`;
}

function shiftDays(ymd, days) {
  const p = ymdParts(ymd);
  if (!p) return null;
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return d.toISOString().slice(0, 10);
}

function fmtInstant(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
}

function monthLabel(batchKey) {
  const [y, m] = String(batchKey || "").split("-").map(Number);
  return MONTHS[m - 1] ? `${MONTHS[m - 1]} ${y}` : batchKey;
}

function batchOptionLabel(b) {
  return `${monthLabel(b.batch_key)} · anniversaries ${fmtRange(b.window_from, b.window_to).replace(/, \d{4}$/, "")}`;
}

function shortDigest(digest) {
  const d = String(digest || "");
  return d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 8)}` : d || "—";
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

const lineLabel = (key) => LINE_LABELS[key] || LINE_LABELS.other;
const cadenceLabel = (key) => CADENCE_LABELS[key] || CADENCE_LABELS.other;
const isNotice = (row) => NOTICE_STATUSES.includes(row.status);
const isLocked = (row) => LOCKED_STATUSES.includes(row.status);
// A row the ranking itself could not price (no band / no current rate) is
// not an account to review — it is counted, not listed.
const unpriced = (row) => row.status === "skipped" && (row.band == null || !(Number(row.current_rate_cents) > 0));
const hasLetter = (row) => isNotice(row) && Number(row.delta_cents) > 0;
// The anniversary's occurrence inside the batch window (the server derives
// review_date); the stored anniversary_date is the line's start date.
const reviewDate = (row) => row.review_date || row.anniversary_date || null;
const isMonthly = (row) => row.rate_unit === "month";

function summarize(rows) {
  const out = { notices: 0, noChange: 0, exceptions: 0, proposedAnnualCents: 0, approved: 0, sent: 0, green: 0 };
  for (const row of rows) {
    if (isNotice(row)) {
      out.notices += 1;
      out.proposedAnnualCents += Number(row.annual_delta_cents) || 0;
    }
    if (row.status === "green") out.green += 1;
    if (row.status === "no_change") out.noChange += 1;
    if (row.status === "exception") out.exceptions += 1;
    if (row.status === "approved") out.approved += 1;
    if (row.status === "sent" || row.status === "applied") out.sent += 1;
  }
  return out;
}

// ── gate probe (the hub decides whether the area exists at all) ─────────

// 'pending' until the server answers; 'on' only on an explicit enabled: true.
// A 404 (gate off), a 403, a network failure — anything else — is 'off'.
export function useRateReviewAvailable(enabled) {
  const [state, setState] = useState(enabled ? "pending" : "off");
  useEffect(() => {
    if (!enabled) {
      setState("off");
      return undefined;
    }
    let cancelled = false;
    setState("pending");
    adminFetch(`/admin/rate-review/batches`)
      .then((data) => { if (!cancelled) setState(data && data.enabled === true ? "on" : "off"); })
      .catch(() => { if (!cancelled) setState("off"); });
    return () => { cancelled = true; };
  }, [enabled]);
  return state;
}

// ── small presentational pieces ─────────────────────────────────────────

function StatCard({ label, value, sub }) {
  return (
    <Card>
      <CardBody>
        <div className="text-ui-label font-medium text-ink-secondary">{label}</div>
        <div className="text-22 sm:text-28 font-medium mt-1 u-nums break-words text-zinc-900">{value}</div>
        <div className="text-ui-caption text-ink-secondary mt-1">{sub}</div>
      </CardBody>
    </Card>
  );
}

function bandsSentence(config) {
  const c = config || {};
  const pct = (v) => `${Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
  return `Bands: A at or above list and above-median $/hr → $0. B within ${pct(c.band_b_tolerance_pct)} of list → year pass-through (+${pct(c.pass_through_pct)}). `
    + `C under list ≤${pct(c.band_c_max_pct)} → to list. D under >${pct(c.band_c_max_pct)} or bottom-quartile $/hr → cap +${pct(c.cap_pct)} or +${dollars(c.cap_cents)} per application (whichever is smaller), rest next year. `
    + `Minimum change ${dollars(c.min_delta_cents)}. $/hr needs ${Number(c.min_usable_visits ?? 0)}+ usable visits; otherwise list gap only.`;
}

// Settings knobs: [key, label, unit] — unit 'cents' edits in dollars.
const SETTING_FIELDS = [
  ["pass_through_pct", "Pass-through (%)", "pct"],
  ["band_b_tolerance_pct", "Band B tolerance (%)", "pct"],
  ["band_c_max_pct", "Band C max (%)", "pct"],
  ["cap_pct", "Cap (%)", "pct"],
  ["cap_cents", "Cap ($ per application)", "cents"],
  ["min_delta_cents", "Minimum change ($)", "cents"],
  ["min_usable_visits", "Minimum usable visits", "int"],
  ["lock_months", "Lock (months)", "int"],
  ["exception_callback_days", "Callback window (days)", "int"],
  ["exception_manual_edit_months", "Manual edit window (months)", "int"],
];

function settingsDraftFrom(config) {
  const draft = {};
  for (const [key, , unit] of SETTING_FIELDS) {
    const v = config && config[key];
    draft[key] = v == null ? "" : String(unit === "cents" ? Number(v) / 100 : v);
  }
  draft.cost_block = (config && config.cost_block) || "";
  return draft;
}

// ── the page ────────────────────────────────────────────────────────────

export default function RateReviewPage({ embedded = false } = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedBatch = searchParams.get("batch");

  const [batches, setBatches] = useState(null);
  const [config, setConfig] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [batch, setBatch] = useState(null); // { batchKey, batch, rows, summary, digest }
  const [batchError, setBatchError] = useState(null);
  const [loadingBatch, setLoadingBatch] = useState(false);
  const [feedback, setFeedback] = useState(null); // { ok, text }
  const [lineFilter, setLineFilter] = useState("all");
  const [bandFilter, setBandFilter] = useState("all");
  const [drafts, setDrafts] = useState({}); // rowId → typed dollars
  const [busyRow, setBusyRow] = useState(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [approving, setApproving] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [letter, setLetter] = useState(null); // { row, state: 'loading'|'ready'|'pending'|'error', html, subject, error }
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState(settingsDraftFrom(null));
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsFeedback, setSettingsFeedback] = useState(null);
  const costBlockRef = useRef(null);
  const batchSeq = useRef(0);
  // The key the screen is showing right now — a request that finishes after
  // the owner switched batches must never reload or act on the old one.
  const selectedKeyRef = useRef(null);

  const selectedKey = useMemo(() => {
    if (!batches || !batches.length) return null;
    if (requestedBatch && batches.some((b) => b.batch_key === requestedBatch)) return requestedBatch;
    return batches[0].batch_key;
  }, [batches, requestedBatch]);

  const loadBatches = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await adminFetch(`/admin/rate-review/batches`);
      setBatches(Array.isArray(data.batches) ? data.batches : []);
      setConfig(data.config || null);
      setSettingsDraft(settingsDraftFrom(data.config));
    } catch (e) {
      setLoadError(e.message || "Could not load the rate review.");
    }
  }, []);

  // Resolves true when THIS load installed the batch, false when it failed or
  // a newer load superseded it (the error state is set here; callers only
  // decide what to say about the write that preceded the reload).
  const loadBatch = useCallback(async (key) => {
    const seq = ++batchSeq.current;
    setLoadingBatch(true);
    setBatchError(null);
    try {
      const data = await adminFetch(`/admin/rate-review/batches/${key}`);
      if (batchSeq.current !== seq) return false;
      setBatch(data);
      return true;
    } catch (e) {
      if (batchSeq.current !== seq) return false;
      setBatchError(e.message || "Could not load the batch.");
      return false;
    } finally {
      if (batchSeq.current === seq) setLoadingBatch(false);
    }
  }, []);

  useEffect(() => { loadBatches(); }, [loadBatches]);
  useEffect(() => {
    // A switch clears the previous batch outright: nothing of it stays
    // actionable while the next one loads (or fails to).
    selectedKeyRef.current = selectedKey;
    setBatch(null);
    setDrafts({});
    setLetter(null);
    setApproveOpen(false);
    if (selectedKey) loadBatch(selectedKey);
  }, [selectedKey, loadBatch]);
  const stillSelected = (key) => selectedKeyRef.current === key;

  const rows = batch?.rows || [];
  const totals = useMemo(() => summarize(rows), [rows]);
  const tableRows = useMemo(() => rows.filter((r) => r.status !== "exception" && !unpriced(r)), [rows]);
  const exceptionRows = useMemo(() => rows.filter((r) => r.status === "exception"), [rows]);
  const unpricedCount = useMemo(() => rows.filter(unpriced).length, [rows]);
  const lineOptions = useMemo(() => [...new Set(tableRows.map((r) => r.family_key))], [tableRows]);
  const visibleRows = useMemo(
    () => tableRows.filter((r) => (lineFilter === "all" || r.family_key === lineFilter) && (bandFilter === "all" || r.band === bandFilter)),
    [tableRows, lineFilter, bandFilter],
  );
  const batchLocked = totals.sent > 0;
  const noticeRows = useMemo(() => rows.filter(hasLetter), [rows]);
  const earliestAnniversary = useMemo(
    () => noticeRows.map(reviewDate).filter(Boolean).sort()[0] || null,
    [noticeRows],
  );
  const noticeBy = earliestAnniversary ? shiftDays(earliestAnniversary, -NOTICE_DAYS) : null;
  const windowFrom = batch?.batch?.window_from || null;
  const windowTo = batch?.batch?.window_to || null;

  const selectBatch = (key) => {
    const next = new URLSearchParams(searchParams);
    next.set("batch", key);
    setSearchParams(next);
    setFeedback(null);
  };

  // One PUT per edit; the server recomputes delta/annual/status. The whole
  // batch is then re-read: the digest covers every row, so the screen must
  // never pair a fresh digest with rows another admin changed meanwhile.
  // Every row control is disabled while a save is in flight (`saving`), so
  // a second edit waits instead of being dropped; the saved row's own draft
  // is the only one cleared.
  // The server's write is durable the moment the PUT answers; a reload that
  // then fails is reported as such next to the saved change, and the stale
  // batch is cleared so nothing out of date stays actionable (Try again
  // re-reads it).
  const RELOAD_FAILED = "The batch could not be reloaded — use Try again.";
  const saving = busyRow != null;
  const putRow = async (row, body, { describe } = {}) => {
    if (saving) return;
    const key = batch.batchKey;
    setBusyRow(row.id);
    setFeedback(null);
    try {
      const data = await adminFetch(`/admin/rate-review/batches/${key}/rows/${row.id}`, { method: "PUT", body: JSON.stringify(body) });
      if (!stillSelected(key)) return;
      setDrafts((prev) => { const next = { ...prev }; delete next[row.id]; return next; });
      const reloaded = await loadBatch(key);
      if (!stillSelected(key)) return;
      const text = describe ? describe(data.row) : "Saved.";
      if (!reloaded) setBatch(null);
      setFeedback({ ok: true, text: reloaded ? text : `${text} ${RELOAD_FAILED}` });
    } catch (e) {
      if (!stillSelected(key)) return;
      setDrafts((prev) => { const next = { ...prev }; delete next[row.id]; return next; });
      setFeedback({ ok: false, text: e.message || "The change was refused." });
    } finally {
      setBusyRow(null);
    }
  };

  const commitProposed = (row) => {
    const typed = drafts[row.id];
    if (typed == null) return;
    const current = Number(row.current_rate_cents) || 0;
    // A cleared field is "no edit", never $0: the prior amount comes back.
    if (String(typed).trim() === "") {
      setDrafts((prev) => { const next = { ...prev }; delete next[row.id]; return next; });
      return;
    }
    const parsed = Number(typed);
    if (!Number.isFinite(parsed)) {
      setDrafts((prev) => { const next = { ...prev }; delete next[row.id]; return next; });
      return;
    }
    // Per application = whole dollars; monthly dues keep their cents (a
    // whole-dollar per-application amount spread over 12).
    const cents = Math.max(current, isMonthly(row) ? Math.round(parsed * 100) : Math.round(parsed) * 100);
    if (cents === Number(row.proposed_rate_cents)) {
      setDrafts((prev) => { const next = { ...prev }; delete next[row.id]; return next; });
      return;
    }
    putRow(row, { proposed_rate_cents: cents }, {
      describe: (saved) => `${saved.customer_name || "Customer"}: proposed ${dollars(saved.proposed_rate_cents)} per ${saved.rate_unit === "month" ? "month" : "application"}.`,
    });
  };

  const toggleInclude = (row, checked) => {
    putRow(row, { status: checked ? "green" : "skipped" }, {
      describe: (saved) => (checked ? `${saved.customer_name || "Customer"} is in the batch.` : `${saved.customer_name || "Customer"} skipped this cycle.`),
    });
  };

  const includeException = (row) => {
    putRow(row, { status: "green", includeException: true }, {
      describe: (saved) => `${saved.customer_name || "Customer"} added to the batch.`,
    });
  };

  const skipException = (row) => {
    putRow(row, { status: "skipped", includeException: true }, {
      // No "back next month": a skipped line is listed again when its
      // anniversary next falls in a batch window (or a catch-up build).
      describe: (saved) => `${saved.customer_name || "Customer"} skipped this cycle.`,
    });
  };

  // The approval is durable once the POST answers: a reload failing
  // afterwards never reads as a refusal, and the stale green batch is
  // cleared rather than left approvable a second time.
  const approve = async () => {
    if (approving || !batch) return;
    setApproving(true);
    setFeedback(null);
    const key = batch.batchKey;
    let data;
    try {
      data = await adminFetch(`/admin/rate-review/batches/${key}/approve`, { method: "POST", body: JSON.stringify({ expectedDigest: batch.digest }) });
    } catch (e) {
      setApproveOpen(false);
      setApproving(false);
      if (!stillSelected(key)) return;
      setFeedback({ ok: false, text: e.message || "The approval was refused." });
      if (e.status === 409) await loadBatch(key);
      return;
    }
    setApproveOpen(false);
    try {
      if (!stillSelected(key)) return;
      const text = `Batch approved: ${data.approved} notice${data.approved === 1 ? "" : "s"} marked approved (${signedDollars(data.annual_delta_cents)} per year). Nothing has been sent — the comms lane sends approved rows.`;
      const reloaded = await loadBatch(key);
      if (!stillSelected(key)) return;
      if (!reloaded) setBatch(null);
      setFeedback({ ok: true, text: reloaded ? text : `${text} ${RELOAD_FAILED}` });
    } finally {
      setApproving(false);
    }
  };

  const emailBatch = async () => {
    if (emailing || !batch) return;
    setEmailing(true);
    setFeedback(null);
    const key = batch.batchKey;
    try {
      const data = await adminFetch(`/admin/rate-review/batches/${key}/email`, { method: "POST" });
      if (!stillSelected(key)) return;
      if (data.sent) {
        setFeedback({ ok: true, text: data.channel === "in_app" ? `Batch digest posted to your notifications: ${data.subject}` : `Batch digest emailed to contact@: ${data.subject}` });
      } else {
        setFeedback({ ok: false, text: data.skipped === "recipient" ? "Not sent — the digest address is not an internal inbox." : "Not sent — the mailer is not configured." });
      }
    } catch (e) {
      if (!stillSelected(key)) return;
      setFeedback({ ok: false, text: e.message || "The batch email failed." });
    } finally {
      setEmailing(false);
    }
  };

  const openLetter = async (row) => {
    const key = batch.batchKey;
    setLetter({ row, state: "loading" });
    try {
      const data = await adminFetch(`/admin/rate-review/batches/${key}/rows/${row.id}/letter-preview`);
      if (!stillSelected(key)) return;
      setLetter({ row, state: "ready", html: data.html || "", subject: data.subject || "" });
    } catch (e) {
      if (!stillSelected(key)) return;
      if (e.status === 404) setLetter({ row, state: "pending" });
      else setLetter({ row, state: "error", error: e.message || "Could not load the letter." });
    }
  };

  const previewLetters = () => {
    const first = tableRows.find(hasLetter);
    if (!first) {
      setFeedback({ ok: false, text: "No letters in this batch yet." });
      return;
    }
    openLetter(first);
  };

  const openCostBlock = () => {
    setSettingsOpen(true);
    window.setTimeout(() => {
      const el = costBlockRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 0);
  };

  const saveSettings = async () => {
    if (savingSettings) return;
    const patch = {};
    for (const [key, , unit] of SETTING_FIELDS) {
      const typed = settingsDraft[key];
      if (typed === "" || typed == null) continue;
      const n = Number(typed);
      if (!Number.isFinite(n)) {
        setSettingsFeedback({ ok: false, text: `${key.replace(/_/g, " ")} must be a number.` });
        return;
      }
      const value = unit === "cents" ? Math.round(n * 100) : n;
      const current = config ? Number(config[key]) : null;
      if (current == null || value !== current) patch[key] = value;
    }
    const costBlock = String(settingsDraft.cost_block || "");
    if (costBlock.trim() !== String((config && config.cost_block) || "").trim()) patch.cost_block = costBlock;
    if (!Object.keys(patch).length) {
      setSettingsFeedback({ ok: true, text: "Nothing changed." });
      return;
    }
    setSavingSettings(true);
    setSettingsFeedback(null);
    try {
      const data = await adminFetch(`/admin/rate-review/config`, { method: "PUT", body: JSON.stringify(patch) });
      setConfig(data.config);
      setSettingsDraft(settingsDraftFrom(data.config));
      setSettingsFeedback({ ok: true, text: "Settings saved. They apply to the next build; this batch keeps the values it was ranked with." });
    } catch (e) {
      const detail = e.details && Array.isArray(e.details.errors) ? e.details.errors.join(" · ") : e.message;
      setSettingsFeedback({ ok: false, text: detail || "The settings were refused." });
    } finally {
      setSavingSettings(false);
    }
  };

  const costBlockStatus = () => {
    if (!config) return "…";
    if (!config.cost_block) return "Not written yet · Write it";
    const who = firstName(config.cost_block_set_by_name);
    return `Set ${fmtInstant(config.cost_block_set_at)}${who ? ` by ${who}` : ""} · Edit`;
  };

  const batchState = () => {
    if (totals.sent > 0) return <Badge tone="strong">Sent</Badge>;
    if (totals.approved > 0) return <Badge tone="strong">Approved {fmtInstant(batch?.batch?.approved_at)}</Badge>;
    return <Badge tone="warn">Draft</Badge>;
  };

  const approveLabel = () => {
    if (batchLocked) return "Batch sent";
    if (totals.green === 0 && totals.approved > 0) return "Batch approved";
    return `Approve batch · send ${totals.green} notice${totals.green === 1 ? "" : "s"}`;
  };

  // ── render ──────────────────────────────────────────────────────────

  return (
    <UiSurface density="comfortable" className="min-h-full max-w-[1300px] mx-auto space-y-4">
      <div>
        {!embedded && <h1 className="text-22 font-medium text-zinc-900">Rate review</h1>}
        <p className="text-ui-body text-ink-secondary mt-0.5 max-w-[72ch]">
          One review per account per 12 months. Accounts whose anniversary falls next month are listed with a
          proposed amount from today's list price and revenue per hour. Green rows send after you approve the
          batch; exceptions wait for you. Notices go out at least 30 days ahead, and the new rate applies to each
          customer's first application on or after their anniversary. Nothing changes until then.
        </p>
      </div>

      {loadError && (
        <ActionFeedback error onRetry={loadBatches}>{loadError}</ActionFeedback>
      )}

      {!loadError && batches === null && (
        <div role="status" className="text-ui-body text-ink-secondary min-h-[240px] py-10 text-center">Loading rate review…</div>
      )}

      {batches && batches.length === 0 && (
        <Card className="p-5 text-center text-ui-body text-ink-secondary">
          No batches yet. The monthly job ranks next month's anniversaries on the 1st and emails you the batch.
        </Card>
      )}

      {batches && batches.length > 0 && (
        <>
          <Card className="p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <Field label="Batch">
                <Select value={selectedKey || ""} onChange={(e) => selectBatch(e.target.value)}>
                  {batches.map((b) => (
                    <option key={b.batch_key} value={b.batch_key}>{batchOptionLabel(b)}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Line">
                <Select value={lineFilter} onChange={(e) => setLineFilter(e.target.value)}>
                  <option value="all">All lines</option>
                  {lineOptions.map((key) => (
                    <option key={key} value={key}>{lineLabel(key)}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Band">
                <Select value={bandFilter} onChange={(e) => setBandFilter(e.target.value)}>
                  <option value="all">All bands</option>
                  {Object.entries(BAND_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Cost block" help="The paragraph the letter prints under what changed this year.">
                <Button variant="secondary" className="w-full justify-between font-normal" onClick={openCostBlock}>
                  <span className="truncate">{costBlockStatus()}</span>
                </Button>
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => setApproveOpen(true)}
                disabled={!batch || loadingBatch || saving || batchLocked || totals.green === 0}
                loading={approving}
              >
                {approveLabel()}
              </Button>
              <Button variant="secondary" onClick={emailBatch} disabled={!batch || loadingBatch} loading={emailing}>Email me this batch</Button>
              <Button variant="ghost" onClick={previewLetters} disabled={!batch || loadingBatch}>Preview letters</Button>
              {feedback && <ActionFeedback error={!feedback.ok}>{feedback.text}</ActionFeedback>}
            </div>
          </Card>

          {batchError && <ActionFeedback error onRetry={() => selectedKey && loadBatch(selectedKey)}>{batchError}</ActionFeedback>}
          {!batchError && !batch && loadingBatch && (
            <div role="status" className="text-ui-body text-ink-secondary min-h-[240px] py-10 text-center">Loading batch…</div>
          )}

          {batch && (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatCard label="Notices" value={totals.notices} sub="letters + text pointer" />
                <StatCard label="No change" value={totals.noChange} sub="no letter" />
                <StatCard label="Exceptions" value={totals.exceptions} sub="waiting for you" />
                <StatCard label="Proposed" value={signedDollars(totals.proposedAnnualCents)} sub="per year, this batch" />
              </div>

              <Card className="p-0 overflow-hidden">
                <div className="px-4 py-2.5 border-b border-hairline border-zinc-200 flex items-center gap-2 flex-wrap">
                  <span className="text-ui-body font-medium text-zinc-900">
                    {tableRows.length} account{tableRows.length === 1 ? "" : "s"}
                    {windowFrom && windowTo ? ` · anniversaries ${fmtRange(windowFrom, windowTo)}` : ""}
                    {noticeBy ? ` · notices by ${fmtDay(noticeBy, { year: false })}` : ""}
                  </span>
                  <Badge tone="neutral">rate changes on each anniversary</Badge>
                  {batchState()}
                </div>
                {/* Dense desktop table: compact density (36px controls at 1024+, 44 below), 14px text kept. */}
                <UiSurface density="compact">
                  {/* The bound lives on Table's own container (the sticky THead's scroll ancestor); phones get the plain page scroll. */}
                  <Table layout="records" containerClassName="lg:max-h-[640px] lg:overflow-y-auto" className="lg:[&_th]:px-2 lg:[&_td]:px-2" aria-label="Rate review rows">
                    <THead className="bg-zinc-50 sticky top-0 z-[1]">
                      <TR>
                        <TH className={NOWRAP}>Customer</TH>
                        <TH className={NOWRAP}>Line</TH>
                        <TH className={NOWRAP}>Cadence</TH>
                        <TH className={NOWRAP}>Anniversary</TH>
                        <TH align="right" className={NOWRAP}>Tenure</TH>
                        <TH align="right" className={NOWRAP}>Now</TH>
                        <TH align="right" className={NOWRAP}>List today</TH>
                        <TH align="right" className={NOWRAP}>Gap</TH>
                        <TH align="right" className={NOWRAP}>$/hr (visits)</TH>
                        <TH className={NOWRAP}>Band</TH>
                        <TH align="right" className={NOWRAP}>Proposed</TH>
                        <TH align="right" className={NOWRAP}>+ / yr</TH>
                        <TH className={NOWRAP}>Include</TH>
                        <TH className={NOWRAP}>Letter</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {visibleRows.length === 0 && (
                        <TR>
                          <TD colSpan={14} className="text-ui-body text-ink-secondary py-6 text-center">
                            {tableRows.length === 0 ? "No accounts in this batch." : "No rows match these filters."}
                          </TD>
                        </TR>
                      )}
                      {visibleRows.map((row) => {
                        const locked = batchLocked || isLocked(row);
                        const included = row.status !== "skipped";
                        const letterRow = hasLetter(row);
                        const name = row.customer_name || "Customer";
                        const unit = row.rate_unit === "month" ? "month" : "application";
                        const gap = row.gap_pct == null ? null : -Math.round(Number(row.gap_pct));
                        const busy = busyRow === row.id;
                        const perUnit = row.rate_unit === "month" ? <span className="text-ink-tertiary">/mo</span> : null;
                        return (
                          <TR key={row.id} className={busy ? "opacity-60" : undefined}>
                            <TD data-label="Customer" className={NOWRAP}>
                              <div className="font-medium text-zinc-900">{name}</div>
                              <div className="text-ui-caption text-ink-tertiary">{row.city || "—"}</div>
                            </TD>
                            <TD data-label="Line" className={NOWRAP}>{lineLabel(row.family_key)}</TD>
                            <TD data-label="Cadence" className={NOWRAP}>{cadenceLabel(row.cadence)}</TD>
                            <TD data-label="Anniversary" nums className={NOWRAP}>{fmtDay(reviewDate(row))}</TD>
                            <TD data-label="Tenure" align="right" nums className={NUM}>{row.tenure_months != null ? `${row.tenure_months} mo` : "—"}</TD>
                            <TD data-label="Now" align="right" nums className={`${NUM} text-ink-secondary`}>{dollars(row.current_rate_cents)}{perUnit}</TD>
                            <TD data-label="List today" align="right" nums className={NUM}>
                              {row.list_rate_cents != null ? <>{dollars(row.list_rate_cents)}{perUnit}</> : "—"}
                              {row.list_rate_source === "cadence_mode" && <div className="text-ui-caption text-ink-tertiary">cadence mode</div>}
                            </TD>
                            <TD data-label="Gap" align="right" nums className={gap != null && gap < 0 ? NUM : `${NUM} text-ink-secondary`}>
                              {gap == null ? "—" : `${gap > 0 ? "+" : ""}${gap}%`}
                            </TD>
                            <TD data-label="$/hr (visits)" align="right" nums className={NUM}>
                              {/* The sample the figure was computed from: the account's own not-home visits when the ranking used those alone. */}
                              {row.revenue_per_hour_cents != null
                                ? <>{dollars(row.revenue_per_hour_cents)} <span className="text-ink-tertiary">({row.rph_from_not_home ? `${row.not_home_visits} not-home` : row.usable_visits})</span></>
                                : <span className="text-ink-tertiary">— ({row.usable_visits})</span>}
                            </TD>
                            <TD data-label="Band" className={NOWRAP}>
                              {row.band ? <Badge tone={row.band === "D" ? "strong" : "neutral"} className={NOWRAP}>{BAND_LABELS[row.band] || row.band}</Badge> : <span className="text-ink-tertiary">—</span>}
                            </TD>
                            <TD data-label="Proposed" align="right" className={NUM}>
                              <Input
                                type="number"
                                inputMode={isMonthly(row) ? "decimal" : "numeric"}
                                min={isMonthly(row) ? ((Number(row.current_rate_cents) || 0) / 100).toFixed(2) : Math.round((Number(row.current_rate_cents) || 0) / 100)}
                                step={isMonthly(row) ? "0.01" : "1"}
                                className="!w-[96px] ml-auto text-right u-nums"
                                aria-label={`Proposed per ${unit} for ${name}`}
                                value={drafts[row.id] ?? (isMonthly(row) ? ((Number(row.proposed_rate_cents) || 0) / 100).toFixed(2) : String(Math.round((Number(row.proposed_rate_cents) || 0) / 100)))}
                                disabled={locked || row.band === "A" || saving}
                                onChange={(e) => setDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))}
                                onBlur={() => commitProposed(row)}
                                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                              />
                            </TD>
                            <TD data-label="+ / yr" align="right" nums className={letterRow ? NUM : `${NUM} text-ink-tertiary`}>
                              {letterRow ? signedDollars(row.annual_delta_cents) : "—"}
                            </TD>
                            <TD data-label="Include" className={NOWRAP}>
                              <label className="inline-flex items-center gap-2">
                                <Checkbox
                                  checked={included}
                                  disabled={locked || saving}
                                  aria-label={`Include ${name}`}
                                  onChange={(e) => toggleInclude(row, e.target.checked)}
                                />
                                <span className="text-ui-caption text-ink-tertiary">{included && !letterRow ? "no letter" : ""}</span>
                              </label>
                            </TD>
                            <TD data-label="Letter" align="right" className={NUM}>
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Letter for ${name}`}
                                disabled={!letterRow}
                                title={letterRow ? undefined : row.band === "A" ? "Band A: no letter is sent" : "No letter: no change this cycle"}
                                onClick={() => openLetter(row)}
                              >
                                Letter
                              </Button>
                            </TD>
                          </TR>
                        );
                      })}
                    </TBody>
                  </Table>
                </UiSurface>
                <div className="px-4 py-2.5 border-t border-hairline border-zinc-200 text-ui-body text-ink-secondary space-y-1">
                  <div>{bandsSentence(batch.batch?.config && Object.keys(batch.batch.config).length ? batch.batch.config : config)}</div>
                  {unpricedCount > 0 && <div className="text-ui-caption text-ink-tertiary">{unpricedCount} line{unpricedCount === 1 ? "" : "s"} skipped — could not be priced.</div>}
                </div>
              </Card>

              <Card className="p-0 overflow-hidden">
                <div className="px-4 py-2.5 border-b border-hairline border-zinc-200 flex items-center gap-2 flex-wrap">
                  <span className="text-ui-body font-medium text-zinc-900">Exceptions · {exceptionRows.length} · waiting for you</span>
                  <Badge tone="neutral">default: skip this cycle</Badge>
                </div>
                {exceptionRows.length === 0 && (
                  <div className="text-ui-body text-ink-secondary py-6 text-center">No exceptions in this batch.</div>
                )}
                {exceptionRows.map((row) => {
                  const name = row.customer_name || "Customer";
                  const reasons = row.flags.filter((f) => EXCEPTION_REASONS[f]);
                  const busy = busyRow === row.id;
                  return (
                    <div key={row.id} className="flex items-center gap-3 px-4 py-3 border-b border-hairline border-zinc-200 last:border-b-0 flex-wrap">
                      <div className="flex-[1_1_220px] min-w-0">
                        <div className="font-medium text-zinc-900">{name}</div>
                        <div className="text-ui-caption text-ink-tertiary">
                          {[row.city, lineLabel(row.family_key), cadenceLabel(row.cadence), `anniversary ${fmtDay(reviewDate(row))}`].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {reasons.length === 0 && <Badge tone="neutral">Held for review</Badge>}
                        {reasons.map((flag) => {
                          const [label, tone] = EXCEPTION_REASONS[flag];
                          return <Badge key={flag} tone={tone}>{label}</Badge>;
                        })}
                      </div>
                      <div className="min-w-[140px] text-right u-nums">
                        <span className="text-ink-secondary">{dollars(row.current_rate_cents)}</span>
                        {" → "}
                        <span className="font-medium text-zinc-900">{dollars(row.proposed_rate_cents)}</span>
                        <span className="text-ink-tertiary"> · {signedDollars(row.annual_delta_cents)}/yr</span>
                      </div>
                      <div className="ui-record-actions">
                        <Button variant="secondary" size="sm" disabled={batchLocked || saving} loading={busy || undefined} onClick={() => includeException(row)}>Include</Button>
                        <Button variant="ghost" size="sm" disabled={batchLocked || saving} onClick={() => skipException(row)}>Skip this cycle</Button>
                      </div>
                    </div>
                  );
                })}
              </Card>
            </>
          )}

          <Card className="p-0 overflow-hidden">
            <button
              type="button"
              className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left u-focus-ring min-h-[44px]"
              aria-expanded={settingsOpen}
              aria-controls="rate-review-settings"
              onClick={() => setSettingsOpen((v) => !v)}
            >
              <span className="text-14 font-medium text-zinc-900">Settings</span>
              <span className="text-ui-caption text-ink-secondary">{settingsOpen ? "Hide" : "Bands, caps, windows and the cost block"}</span>
            </button>
            {settingsOpen && (
              <div id="rate-review-settings" className="px-4 pb-4 space-y-3 border-t border-hairline border-zinc-200 pt-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                  {SETTING_FIELDS.map(([key, label, unit]) => (
                    <Field key={key} label={label}>
                      <Input
                        type="number"
                        inputMode="decimal"
                        step={unit === "pct" ? "0.5" : "1"}
                        min={key === "min_delta_cents" ? "1" : "0"}
                        disabled={savingSettings}
                        value={settingsDraft[key]}
                        onChange={(e) => setSettingsDraft((prev) => ({ ...prev, [key]: e.target.value }))}
                      />
                    </Field>
                  ))}
                </div>
                <Field
                  label="Cost block text"
                  help="Written once a year by you, with real figures — technician pay, two or three products by name, fuel, insurance, licensing. The letter prints it under what changed on our side this year. Plain text, nothing generated."
                >
                  <Textarea
                    ref={costBlockRef}
                    rows={6}
                    disabled={savingSettings}
                    value={settingsDraft.cost_block}
                    onChange={(e) => setSettingsDraft((prev) => ({ ...prev, cost_block: e.target.value }))}
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="secondary" onClick={saveSettings} loading={savingSettings}>Save settings</Button>
                  <span className="text-ui-caption text-ink-secondary">Changes apply to the next build; rows already computed keep the values they were ranked with.</span>
                  {settingsFeedback && <ActionFeedback error={!settingsFeedback.ok}>{settingsFeedback.text}</ActionFeedback>}
                </div>
              </div>
            )}
          </Card>
        </>
      )}

      <Dialog open={approveOpen} onClose={() => !approving && setApproveOpen(false)} size="md">
        <DialogHeader>
          <DialogTitle>Approve {batch ? monthLabel(batch.batchKey) : ""} batch</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="flex justify-between gap-3"><span className="text-ink-secondary">Notices</span><span className="u-nums text-right">{totals.green} customer{totals.green === 1 ? "" : "s"} · email letter + text pointer</span></div>
          <div className="flex justify-between gap-3"><span className="text-ink-secondary">Effective</span><span className="text-right">each customer's first application on or after their anniversary{earliestAnniversary ? ` (earliest ${fmtDay(earliestAnniversary)})` : ""}</span></div>
          <div className="flex justify-between gap-3"><span className="text-ink-secondary">Proposed</span><span className="u-nums text-right">{signedDollars(rows.filter((r) => r.status === "green").reduce((s, r) => s + (Number(r.annual_delta_cents) || 0), 0))} per year</span></div>
          <div className="flex justify-between gap-3"><span className="text-ink-secondary">Digest</span><span className="u-nums text-right">{shortDigest(batch?.digest)} · refuses if the list changes before send</span></div>
          <p className="text-ink-secondary m-0">
            Sending schedules the rate change too. If a customer's rate moves by any other path before their effective date,
            that account holds and shows up here. Exceptions stay untouched.
          </p>
          <p className="text-ink-secondary m-0">
            In this build, approving records your decision on the green rows; the letters go out once the comms lane ships.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setApproveOpen(false)} disabled={approving}>Cancel</Button>
          <Button onClick={approve} loading={approving}>Approve {totals.green} notice{totals.green === 1 ? "" : "s"}</Button>
        </DialogFooter>
      </Dialog>

      <Sheet open={!!letter} onClose={() => setLetter(null)} width="lg" ariaLabel="Letter preview">
        <SheetHeader>
          <div className="min-w-0">
            <div className="text-18 font-medium tracking-tight text-zinc-900 truncate">Letter · {letter?.row?.customer_name || "Customer"}</div>
            {letter?.state === "ready" && letter.subject && <div className="text-ui-caption text-ink-secondary truncate">{letter.subject}</div>}
          </div>
          <Button variant="ghost" onClick={() => setLetter(null)}>Close</Button>
        </SheetHeader>
        <SheetBody className="flex flex-col min-h-0">
          {letter?.state === "loading" && <div role="status" className="text-ui-body text-ink-secondary py-10 text-center">Loading letter…</div>}
          {letter?.state === "pending" && <div className="text-ui-body text-ink-secondary py-10 text-center">Letter preview arrives with the comms PR.</div>}
          {letter?.state === "error" && <ActionFeedback error onRetry={() => openLetter(letter.row)}>{letter.error}</ActionFeedback>}
          {letter?.state === "ready" && (
            <iframe
              title={`Letter preview for ${letter.row.customer_name || "customer"}`}
              sandbox=""
              srcDoc={letter.html}
              className="w-full flex-1 min-h-[70vh] border-hairline border-zinc-200 rounded-sm bg-white"
            />
          )}
        </SheetBody>
      </Sheet>
    </UiSurface>
  );
}
