// Pricing hub → Rate review: the admin screen for the annual rate review
// (plan annual-rate-review-2026-09-30; approved mockup "Admin · Pricing →
// Rate review"). Embedded under PricingHubPage like AdminPriceChangePage —
// the hub owns the h1 and the area tabs.
//
// Dark behind GATE_RATE_REVIEW: every /api/admin/rate-review route answers
// 404 while the gate is off, the hub probes once (useRateReviewAvailable)
// and never shows the area. Approve only records the decision: it marks green
// rows 'approved' against a digest of the batch. Customers are written to
// from the Send letters panel under the table (RateReviewSendPanel: prepare
// notices, review who gets what, confirm, send). "Email me this batch" is the
// owner digest (the ranking's POST …/digest), never a customer send.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { adminFetch } from "../../utils/admin-fetch";
import RateReviewSendPanel from "../../components/admin/RateReviewSendPanel";
import {
  ActionFeedback, Badge, Button, Card, CardBody, Checkbox, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle,
  Field, Input, Select, Sheet, SheetBody, SheetHeader, Table, TBody, TD, TH, THead, TR, Textarea, UiSurface,
} from "../../components/ui";

const NOTICE_DAYS = 30;
const NOTICE_STATUSES = ["green", "approved", "sent", "applied"];
const LOCKED_STATUSES = ["approved", "sent", "applied"];

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
  list_low_confidence: ["List price low confidence", "neutral"],
  list_bundle_incomplete: ["Bundle list price incomplete", "neutral"],
  multi_program_line: ["Several programs on one line", "neutral"],
  unsupported_family: ["Unsupported service line", "neutral"],
  cadence_conflict: ["Cadence conflict", "neutral"],
  rate_unattributed: ["Rate unattributed", "neutral"],
  facts_unavailable: ["Account facts unavailable", "neutral"],
  facts_degraded: ["Money facts degraded", "neutral"],
  no_anniversary: ["No anniversary", "neutral"],
  no_current_rate: ["No current rate", "neutral"],
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
// Money, dates and short labels never break mid-value; the table scrolls
// sideways instead (ui-table-cell's overflow-wrap would split "$105").
const NOWRAP = "whitespace-nowrap";
// Right-aligned on the desktop grid; on the records layout (≤1100px) every
// cell is "label · value", so the value reads left like its neighbours.
const NUM = `${NOWRAP} max-[1100px]:text-left`;
const RELOAD_FAILED = "The batch could not be reloaded — use Try again.";
// Where a sent owner digest went (the route's channel): the inbox, or the
// admin bell when ops digests are in-app.
const DIGEST_SENT = { email: "Batch digest sent to contact@", in_app: "Batch digest posted to the admin bell (ops digests are in-app)" };
// What the owner digest route answers when it sends nothing.
const DIGEST_SKIPPED = {
  already_sent: "This batch's digest already went out; a rebuild sends an updated one.",
  recipient: "Not sent — the digest address is not an internal inbox.",
  unconfigured: "Not sent — the mailer is not configured.",
};

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
  return new Date(Date.UTC(p.y, p.m - 1, p.d + days)).toISOString().slice(0, 10);
}

function fmtInstant(value) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
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
const displayName = (row) => row.customer_name || "Customer";
const isNotice = (row) => NOTICE_STATUSES.includes(row.status);
const isLocked = (row) => LOCKED_STATUSES.includes(row.status);
// A row the ranking itself could not price (no band / no current rate) is
// not an account to review — it is counted, not listed.
const unpriced = (row) => row.status === "skipped" && (row.band == null || !(Number(row.current_rate_cents) > 0));
const hasLetter = (row) => isNotice(row) && Number(row.delta_cents) > 0;
// The anniversary's occurrence the ranking stored for this batch; the stored
// anniversary_date is the line's start date (an older row's only date).
const reviewDate = (row) => row.review_date || row.anniversary_date || null;
const isMonthly = (row) => row.rate_unit === "month";
const unitWord = (row) => (isMonthly(row) ? "month" : "application");
const noticeCount = (n) => `${n} notice${n === 1 ? "" : "s"}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function summarize(rows) {
  const out = { notices: 0, noChange: 0, exceptions: 0, proposedAnnualCents: 0, approved: 0, sent: 0, green: 0, greenAnnualCents: 0 };
  for (const row of rows) {
    const annual = Number(row.annual_delta_cents) || 0;
    if (isNotice(row)) {
      out.notices += 1;
      out.proposedAnnualCents += annual;
    }
    if (row.status === "green") {
      out.green += 1;
      out.greenAnnualCents += annual;
    }
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
    adminFetch("/admin/rate-review/batches")
      .then((data) => { if (!cancelled) setState(data && data.enabled === true ? "on" : "off"); })
      .catch(() => { if (!cancelled) setState("off"); });
    return () => { cancelled = true; };
  }, [enabled]);
  return state;
}

// ── settings ────────────────────────────────────────────────────────────

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

// Knobs whose floor is one, not zero (the server refuses 0 for both).
const FLOOR_ONE = new Set(["min_delta_cents", "min_usable_visits"]);

function settingsDraftFrom(config) {
  const draft = {};
  for (const [key, , unit] of SETTING_FIELDS) {
    const v = config && config[key];
    draft[key] = v == null ? "" : String(unit === "cents" ? Number(v) / 100 : v);
  }
  draft.cost_block = (config && config.cost_block) || "";
  return draft;
}

// The PUT /config body: only the knobs that differ from the saved config.
function settingsPatch(draft, config) {
  const patch = {};
  for (const [key, , unit] of SETTING_FIELDS) {
    const typed = draft[key];
    if (typed === "" || typed == null) continue;
    const n = Number(typed);
    if (!Number.isFinite(n)) return { error: `${key.replace(/_/g, " ")} must be a number.` };
    const value = unit === "cents" ? Math.round(n * 100) : n;
    if (!config || value !== Number(config[key])) patch[key] = value;
  }
  const costBlock = String(draft.cost_block || "");
  if (costBlock.trim() !== String((config && config.cost_block) || "").trim()) patch.cost_block = costBlock;
  return { patch };
}

function costBlockStatus(config) {
  if (!config) return "…";
  if (!config.cost_block) return "Not written yet · Write it";
  const who = firstName(config.cost_block_set_by_name);
  return `Set ${fmtInstant(config.cost_block_set_at)}${who ? ` by ${who}` : ""} · Edit`;
}

// ── presentational pieces ───────────────────────────────────────────────

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

function StatCards({ totals }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <StatCard label="Notices" value={totals.notices} sub="letters + text pointer" />
      <StatCard label="No change" value={totals.noChange} sub="no letter" />
      <StatCard label="Exceptions" value={totals.exceptions} sub="waiting for you" />
      <StatCard label="Proposed" value={signedDollars(totals.proposedAnnualCents)} sub="per year, this batch" />
    </div>
  );
}

function Loading({ children }) {
  return <div role="status" className="text-ui-body text-ink-secondary min-h-[240px] py-10 text-center">{children}</div>;
}

function BatchControls({ batches, selectedKey, onSelectBatch, lineOptions, lineFilter, onLineFilter, bandFilter, onBandFilter, config, onCostBlock, approve, email, preview, feedback }) {
  return (
    <Card className="p-4 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Field label="Batch">
          <Select value={selectedKey || ""} onChange={(e) => onSelectBatch(e.target.value)}>
            {batches.map((b) => <option key={b.batch_key} value={b.batch_key}>{batchOptionLabel(b)}</option>)}
          </Select>
        </Field>
        <Field label="Line">
          <Select value={lineFilter} onChange={(e) => onLineFilter(e.target.value)}>
            <option value="all">All lines</option>
            {lineOptions.map((key) => <option key={key} value={key}>{lineLabel(key)}</option>)}
          </Select>
        </Field>
        <Field label="Band">
          <Select value={bandFilter} onChange={(e) => onBandFilter(e.target.value)}>
            <option value="all">All bands</option>
            {Object.entries(BAND_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </Select>
        </Field>
        <Field label="Cost block" help="The paragraph the letter prints under what changed this year.">
          <Button variant="secondary" className="w-full justify-between font-normal" onClick={onCostBlock}>
            <span className="truncate">{costBlockStatus(config)}</span>
          </Button>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={approve.onClick} disabled={approve.disabled} loading={approve.loading}>{approve.label}</Button>
        <Button variant="secondary" onClick={email.onClick} disabled={email.disabled} loading={email.loading}>Email me this batch</Button>
        <Button variant="ghost" onClick={preview.onClick} disabled={preview.disabled}>Preview letters</Button>
        {feedback && <ActionFeedback error={!feedback.ok}>{feedback.text}</ActionFeedback>}
      </div>
    </Card>
  );
}

function ListTodayCell({ row }) {
  if (row.list_rate_cents == null) return "—";
  return (
    <>
      {dollars(row.list_rate_cents)}{isMonthly(row) && <span className="text-ink-tertiary">/mo</span>}
      {row.list_rate_source === "cadence_mode" && <div className="text-ui-caption text-ink-tertiary">cadence mode</div>}
    </>
  );
}

// The ranking's gap is "below list" positive; the screen shows now vs list,
// so under list reads negative and is the figure that matters (dark).
function GapCell({ row }) {
  if (row.gap_pct == null) return <TD data-label="Gap" align="right" nums className={`${NUM} text-ink-secondary`}>—</TD>;
  const gap = -Math.round(Number(row.gap_pct));
  return <TD data-label="Gap" align="right" nums className={gap < 0 ? NUM : `${NUM} text-ink-secondary`}>{gap > 0 ? `+${gap}%` : `${gap}%`}</TD>;
}

// The sample the figure was computed from: the account's own not-home
// visits when the ranking used those alone.
function RphCell({ row }) {
  if (row.revenue_per_hour_cents == null) return <span className="text-ink-tertiary">— ({row.usable_visits})</span>;
  const sample = row.rph_from_not_home ? `${row.not_home_visits} not-home` : row.usable_visits;
  return <>{dollars(row.revenue_per_hour_cents)} <span className="text-ink-tertiary">({sample})</span></>;
}

function BandCell({ band }) {
  if (!band) return <span className="text-ink-tertiary">—</span>;
  return <Badge tone={band === "D" ? "strong" : "neutral"} className={NOWRAP}>{BAND_LABELS[band] || band}</Badge>;
}

// Per application = whole dollars; monthly dues keep their cents (a
// whole-dollar per-application amount spread over 12).
function ProposedInput({ row, disabled, draft, onDraft, onCommit }) {
  const monthly = isMonthly(row);
  const current = (Number(row.current_rate_cents) || 0) / 100;
  const proposed = (Number(row.proposed_rate_cents) || 0) / 100;
  return (
    <Input
      type="number"
      inputMode={monthly ? "decimal" : "numeric"}
      min={monthly ? current.toFixed(2) : Math.round(current)}
      step={monthly ? "0.01" : "1"}
      className="!w-[96px] ml-auto text-right u-nums"
      aria-label={`Proposed per ${unitWord(row)} for ${displayName(row)}`}
      value={draft ?? (monthly ? proposed.toFixed(2) : String(Math.round(proposed)))}
      disabled={disabled}
      onChange={(e) => onDraft(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
    />
  );
}

function LetterButton({ row, onLetter }) {
  const letterRow = hasLetter(row);
  const title = row.band === "A" ? "Band A: no letter is sent" : "No letter: no change this cycle";
  return (
    <Button variant="ghost" size="sm" aria-label={`Letter for ${displayName(row)}`} disabled={!letterRow} title={letterRow ? undefined : title} onClick={() => onLetter(row)}>
      Letter
    </Button>
  );
}

function RateReviewRow({ row, batchLocked, saving, busy, draft, onDraft, onCommit, onToggle, onLetter }) {
  const name = displayName(row);
  const locked = batchLocked || isLocked(row);
  const included = row.status !== "skipped";
  const letterRow = hasLetter(row);
  const perMonth = isMonthly(row) && <span className="text-ink-tertiary">/mo</span>;
  return (
    <TR className={busy ? "opacity-60" : undefined}>
      <TD data-label="Customer" className={NOWRAP}>
        <div className="font-medium text-zinc-900">{name}</div>
        <div className="text-ui-caption text-ink-tertiary">{row.city || "—"}</div>
      </TD>
      <TD data-label="Line" className={NOWRAP}>{lineLabel(row.family_key)}</TD>
      <TD data-label="Cadence" className={NOWRAP}>{cadenceLabel(row.cadence)}</TD>
      <TD data-label="Anniversary" nums className={NOWRAP}>{fmtDay(reviewDate(row))}</TD>
      <TD data-label="Tenure" align="right" nums className={NUM}>{row.tenure_months == null ? "—" : `${row.tenure_months} mo`}</TD>
      <TD data-label="Now" align="right" nums className={`${NUM} text-ink-secondary`}>{dollars(row.current_rate_cents)}{perMonth}</TD>
      <TD data-label="List today" align="right" nums className={NUM}><ListTodayCell row={row} /></TD>
      <GapCell row={row} />
      <TD data-label="$/hr (visits)" align="right" nums className={NUM}><RphCell row={row} /></TD>
      <TD data-label="Band" className={NOWRAP}><BandCell band={row.band} /></TD>
      <TD data-label="Proposed" align="right" className={NUM}>
        <ProposedInput row={row} disabled={locked || row.band === "A" || saving} draft={draft} onDraft={onDraft} onCommit={onCommit} />
      </TD>
      <TD data-label="+ / yr" align="right" nums className={letterRow ? NUM : `${NUM} text-ink-tertiary`}>{letterRow ? signedDollars(row.annual_delta_cents) : "—"}</TD>
      <TD data-label="Include" className={NOWRAP}>
        <label className="inline-flex items-center gap-2">
          <Checkbox checked={included} disabled={locked || saving} aria-label={`Include ${name}`} onChange={(e) => onToggle(e.target.checked)} />
          <span className="text-ui-caption text-ink-tertiary">{included && !letterRow ? "no letter" : ""}</span>
        </label>
      </TD>
      <TD data-label="Letter" align="right" className={NUM}><LetterButton row={row} onLetter={onLetter} /></TD>
    </TR>
  );
}

function BatchState({ totals, approvedAt }) {
  if (totals.sent > 0) return <Badge tone="strong">Sent</Badge>;
  if (totals.approved > 0) return <Badge tone="strong">Approved {fmtInstant(approvedAt)}</Badge>;
  return <Badge tone="warn">Draft</Badge>;
}

function BatchTable({ batch, totals, tableRows, visibleRows, unpricedCount, liveConfig, rowProps }) {
  const meta = batch.batch || {};
  // The bands sentence reads the config the batch was ranked with; the live
  // config stands in for a batch row without one.
  const config = meta.config && Object.keys(meta.config).length ? meta.config : liveConfig;
  const earliest = batch.rows.filter(hasLetter).map(reviewDate).filter(Boolean).sort()[0] || null;
  const noticeBy = earliest && shiftDays(earliest, -NOTICE_DAYS);
  const title = [
    plural(tableRows.length, "account"),
    meta.window_from && meta.window_to ? `anniversaries ${fmtRange(meta.window_from, meta.window_to)}` : null,
    noticeBy ? `notices by ${fmtDay(noticeBy, { year: false })}` : null,
  ].filter(Boolean).join(" · ");
  const empty = tableRows.length === 0 ? "No accounts in this batch." : "No rows match these filters.";
  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-hairline border-zinc-200 flex items-center gap-2 flex-wrap">
        <span className="text-ui-body font-medium text-zinc-900">{title}</span>
        <Badge tone="neutral">rate changes on each anniversary</Badge>
        <BatchState totals={totals} approvedAt={meta.approved_at} />
      </div>
      {/* Dense desktop table: compact density (36px controls at 1024+, 44 below), 14px text kept. The
          scroll bound lives on Table's own container (the sticky THead's scroll ancestor); phones get
          the plain page scroll. */}
      <UiSurface density="compact">
        <Table layout="records" containerClassName="lg:max-h-[640px] lg:overflow-y-auto" className="lg:[&_th]:px-2 lg:[&_td]:px-2" aria-label="Rate review rows">
          <THead className="bg-zinc-50 sticky top-0 z-[1]">
            <TR>
              {["Customer", "Line", "Cadence", "Anniversary"].map((h) => <TH key={h} className={NOWRAP}>{h}</TH>)}
              {["Tenure", "Now", "List today", "Gap", "$/hr (visits)"].map((h) => <TH key={h} align="right" className={NOWRAP}>{h}</TH>)}
              <TH className={NOWRAP}>Band</TH>
              <TH align="right" className={NOWRAP}>Proposed</TH>
              <TH align="right" className={NOWRAP}>+ / yr</TH>
              <TH className={NOWRAP}>Include</TH>
              <TH className={NOWRAP}>Letter</TH>
            </TR>
          </THead>
          <TBody>
            {visibleRows.length === 0 && (
              <TR><TD colSpan={14} className="text-ui-body text-ink-secondary py-6 text-center">{empty}</TD></TR>
            )}
            {visibleRows.map((row) => <RateReviewRow key={row.id} row={row} {...rowProps(row)} />)}
          </TBody>
        </Table>
      </UiSurface>
      <div className="px-4 py-2.5 border-t border-hairline border-zinc-200 text-ui-body text-ink-secondary space-y-1">
        <div>{bandsSentence(config)}</div>
        {unpricedCount > 0 && <div className="text-ui-caption text-ink-tertiary">{plural(unpricedCount, "line")} skipped — could not be priced.</div>}
      </div>
    </Card>
  );
}

function ExceptionRow({ row, disabled, busy, onInclude, onSkip }) {
  const reasons = row.flags.filter((f) => EXCEPTION_REASONS[f]);
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-hairline border-zinc-200 last:border-b-0 flex-wrap">
      <div className="flex-[1_1_220px] min-w-0">
        <div className="font-medium text-zinc-900">{displayName(row)}</div>
        <div className="text-ui-caption text-ink-tertiary">
          {[row.city, lineLabel(row.family_key), cadenceLabel(row.cadence), `anniversary ${fmtDay(reviewDate(row))}`].filter(Boolean).join(" · ")}
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {reasons.length === 0 && <Badge tone="neutral">Held for review</Badge>}
        {reasons.map((flag) => <Badge key={flag} tone={EXCEPTION_REASONS[flag][1]}>{EXCEPTION_REASONS[flag][0]}</Badge>)}
      </div>
      <div className="min-w-[140px] text-right u-nums">
        <span className="text-ink-secondary">{dollars(row.current_rate_cents)}</span>
        {" → "}
        <span className="font-medium text-zinc-900">{dollars(row.proposed_rate_cents)}</span>
        <span className="text-ink-tertiary"> · {signedDollars(row.annual_delta_cents)}/yr</span>
      </div>
      <div className="ui-record-actions">
        <Button variant="secondary" size="sm" disabled={disabled} loading={busy || undefined} onClick={() => onInclude(row)}>Include</Button>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onSkip(row)}>Skip this cycle</Button>
      </div>
    </div>
  );
}

function ExceptionsCard({ rows, disabled, busyRow, onInclude, onSkip }) {
  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-hairline border-zinc-200 flex items-center gap-2 flex-wrap">
        <span className="text-ui-body font-medium text-zinc-900">Exceptions · {rows.length} · waiting for you</span>
        <Badge tone="neutral">default: skip this cycle</Badge>
      </div>
      {rows.length === 0 && <div className="text-ui-body text-ink-secondary py-6 text-center">No exceptions in this batch.</div>}
      {rows.map((row) => <ExceptionRow key={row.id} row={row} disabled={disabled} busy={busyRow === row.id} onInclude={onInclude} onSkip={onSkip} />)}
    </Card>
  );
}

function SettingsCard({ open, onToggle, draft, onDraft, saving, feedback, onSave, costBlockRef }) {
  return (
    <Card className="p-0 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left u-focus-ring min-h-[44px]"
        aria-expanded={open}
        aria-controls="rate-review-settings"
        onClick={onToggle}
      >
        <span className="text-14 font-medium text-zinc-900">Settings</span>
        <span className="text-ui-caption text-ink-secondary">{open ? "Hide" : "Bands, caps, windows and the cost block"}</span>
      </button>
      {open && (
        <div id="rate-review-settings" className="px-4 pb-4 space-y-3 border-t border-hairline border-zinc-200 pt-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            {SETTING_FIELDS.map(([key, label, unit]) => (
              <Field key={key} label={label}>
                <Input
                  type="number"
                  inputMode="decimal"
                  step={unit === "pct" ? "0.5" : "1"}
                  min={FLOOR_ONE.has(key) ? "1" : "0"}
                  disabled={saving}
                  value={draft[key]}
                  onChange={(e) => onDraft(key, e.target.value)}
                />
              </Field>
            ))}
          </div>
          <Field
            label="Cost block text"
            help="Written once a year by you, with real figures — technician pay, two or three products by name, fuel, insurance, licensing. The letter prints it under what changed on our side this year. Plain text, nothing generated."
          >
            <Textarea ref={costBlockRef} rows={6} disabled={saving} value={draft.cost_block} onChange={(e) => onDraft("cost_block", e.target.value)} />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={onSave} loading={saving}>Save settings</Button>
            <span className="text-ui-caption text-ink-secondary">Changes apply to the next build; rows already computed keep the values they were ranked with.</span>
            {feedback && <ActionFeedback error={!feedback.ok}>{feedback.text}</ActionFeedback>}
          </div>
        </div>
      )}
    </Card>
  );
}

function ApproveDialog({ open, onClose, batchKey, totals, earliest, approvalDigest, approving, onApprove }) {
  return (
    <Dialog open={open} onClose={onClose} size="md">
      <DialogHeader><DialogTitle>Approve {monthLabel(batchKey)} batch</DialogTitle></DialogHeader>
      <DialogBody className="space-y-3">
        <div className="flex justify-between gap-3"><span className="text-ink-secondary">Notices</span><span className="u-nums text-right">{plural(totals.green, "customer")} · email letter + text pointer</span></div>
        <div className="flex justify-between gap-3"><span className="text-ink-secondary">Effective</span><span className="text-right">each customer's first application on or after their anniversary{earliest ? ` (earliest ${fmtDay(earliest)})` : ""}</span></div>
        <div className="flex justify-between gap-3"><span className="text-ink-secondary">Proposed</span><span className="u-nums text-right">{signedDollars(totals.greenAnnualCents)} per year</span></div>
        <div className="flex justify-between gap-3"><span className="text-ink-secondary">Digest</span><span className="u-nums text-right">{shortDigest(approvalDigest)} · refuses if the list changes before send</span></div>
        <p className="text-ink-secondary m-0">
          Sending schedules the rate change too. If a customer's rate moves by any other path before their effective date,
          that account holds and shows up here. Exceptions stay untouched.
        </p>
        <p className="text-ink-secondary m-0">
          Approving only records your decision on the green rows. Nothing goes to a customer until you press Send in the Send letters panel below the table.
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={approving}>Cancel</Button>
        <Button onClick={onApprove} loading={approving}>Approve {noticeCount(totals.green)}</Button>
      </DialogFooter>
    </Dialog>
  );
}

function LetterSheet({ letter, onClose, onRetry }) {
  const name = letter ? displayName(letter.row) : "Customer";
  return (
    <Sheet open={!!letter} onClose={onClose} width="lg" ariaLabel="Letter preview">
      <SheetHeader>
        <div className="min-w-0">
          <div className="text-18 font-medium tracking-tight text-zinc-900 truncate">Letter · {name}</div>
          {letter?.subject && <div className="text-ui-caption text-ink-secondary truncate">{letter.subject}</div>}
        </div>
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </SheetHeader>
      <SheetBody className="flex flex-col min-h-0">
        {letter?.state === "loading" && <Loading>Loading letter…</Loading>}
        {letter?.state === "pending" && <div className="text-ui-body text-ink-secondary py-10 text-center">No letter for this row yet. Approve the batch, then use Prepare notices in the Send letters panel below the table.</div>}
        {letter?.state === "error" && <ActionFeedback error onRetry={onRetry}>{letter.error}</ActionFeedback>}
        {letter?.state === "ready" && (
          <iframe title={`Letter preview for ${name}`} sandbox="" srcDoc={letter.html} className="w-full flex-1 min-h-[70vh] border-hairline border-zinc-200 rounded-sm bg-white" />
        )}
      </SheetBody>
    </Sheet>
  );
}

// The list of batches: not loaded yet, failed, empty — or nothing to show
// (the controls render then).
function BatchStage({ loadError, batches, onRetry }) {
  if (loadError) return <ActionFeedback error onRetry={onRetry}>{loadError}</ActionFeedback>;
  if (batches === null) return <Loading>Loading rate review…</Loading>;
  if (batches.length === 0) {
    return (
      <Card className="p-5 text-center text-ui-body text-ink-secondary">
        No batches yet. The monthly job ranks next month's anniversaries on the 1st and emails you the batch.
      </Card>
    );
  }
  return null;
}

// The selected batch: its load error, its loading state, or the stat cards,
// the table and the exceptions.
function BatchBody({ batch, batchError, loadingBatch, onRetry, totals, tableRows, visibleRows, exceptionRows, unpricedCount, liveConfig, rowProps, exceptionProps, sendProps }) {
  if (batchError) return <ActionFeedback error onRetry={onRetry}>{batchError}</ActionFeedback>;
  if (!batch) return loadingBatch ? <Loading>Loading batch…</Loading> : null;
  return (
    <>
      <StatCards totals={totals} />
      <BatchTable batch={batch} totals={totals} tableRows={tableRows} visibleRows={visibleRows} unpricedCount={unpricedCount} liveConfig={liveConfig} rowProps={rowProps} />
      {/* Keyed by batch: switching batches remounts the panel so a preview never outlives its batch. */}
      <RateReviewSendPanel key={batch.batchKey} batchKey={batch.batchKey} {...sendProps} />
      <ExceptionsCard rows={exceptionRows} {...exceptionProps} />
    </>
  );
}

// The primary action, derived once: its label and whether it can run.
function approveAction(totals, { ready, saving, batchLocked }) {
  if (batchLocked) return { label: "Batch sent", disabled: true };
  if (totals.green === 0) return { label: totals.approved > 0 ? "Batch approved" : "Approve batch · send 0 notices", disabled: true };
  return { label: `Approve batch · send ${noticeCount(totals.green)}`, disabled: !ready || saving };
}

// ── the page ────────────────────────────────────────────────────────────

export default function RateReviewPage({ embedded = false } = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedBatch = searchParams.get("batch");

  const [batches, setBatches] = useState(null);
  const [config, setConfig] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [batch, setBatch] = useState(null); // { batchKey, batch, rows, summary, approvalDigest }
  const [batchError, setBatchError] = useState(null);
  const [loadingBatch, setLoadingBatch] = useState(false);
  const [feedback, setFeedback] = useState(null); // { ok, text }
  const [lineFilter, setLineFilter] = useState("all");
  const [bandFilter, setBandFilter] = useState("all");
  const [drafts, setDrafts] = useState({}); // rowId → typed amount
  const [busyRow, setBusyRow] = useState(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [approving, setApproving] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [letter, setLetter] = useState(null); // { row, state: 'loading'|'ready'|'pending'|'error', html, subject, error }
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState(settingsDraftFrom(null));
  const [savingSettings, setSavingSettings] = useState(false);
  const [sending, setSending] = useState(false); // the send panel has a request in flight
  const [settingsFeedback, setSettingsFeedback] = useState(null);
  const costBlockRef = useRef(null);
  const batchSeq = useRef(0);
  // The key the screen is showing right now — a request that finishes after
  // the owner switched batches must never reload or act on the old one.
  const selectedKeyRef = useRef(null);
  // The letter preview in flight; closing the sheet (or opening another
  // row's letter) retires it, so a late answer never reopens the sheet.
  const letterSeq = useRef(0);

  const selectedKey = useMemo(() => {
    if (!batches || !batches.length) return null;
    if (requestedBatch && batches.some((b) => b.batch_key === requestedBatch)) return requestedBatch;
    return batches[0].batch_key;
  }, [batches, requestedBatch]);

  const loadBatches = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await adminFetch("/admin/rate-review/batches");
      setBatches(Array.isArray(data.batches) ? data.batches : []);
      setConfig(data.config || null);
      setSettingsDraft(settingsDraftFrom(data.config));
    } catch (e) {
      setLoadError(e.message || "Could not load the rate review.");
    }
  }, []);

  // Resolves 'loaded' when THIS load installed the batch, 'failed' when it
  // failed (the error state is set here), 'superseded' when a newer load
  // took over — a later request for the same batch may well have installed
  // it, so a superseded load is never treated as a failed one.
  const loadBatch = useCallback(async (key) => {
    const seq = ++batchSeq.current;
    setLoadingBatch(true);
    setBatchError(null);
    try {
      const data = await adminFetch(`/admin/rate-review/batches/${key}`);
      if (batchSeq.current !== seq) return "superseded";
      setBatch(data);
      return "loaded";
    } catch (e) {
      if (batchSeq.current !== seq) return "superseded";
      setBatchError(e.message || "Could not load the batch.");
      return "failed";
    } finally {
      if (batchSeq.current === seq) setLoadingBatch(false);
    }
  }, []);

  const closeLetter = useCallback(() => {
    letterSeq.current += 1;
    setLetter(null);
  }, []);

  useEffect(() => { loadBatches(); }, [loadBatches]);
  useEffect(() => {
    // A switch clears the previous batch outright: nothing of it stays
    // actionable while the next one loads (or fails to).
    selectedKeyRef.current = selectedKey;
    setBatch(null);
    setDrafts({});
    closeLetter();
    setApproveOpen(false);
    if (selectedKey) loadBatch(selectedKey);
  }, [selectedKey, loadBatch, closeLetter]);
  const stillSelected = (key) => selectedKeyRef.current === key;

  const rows = batch?.rows || [];
  const totals = useMemo(() => summarize(rows), [rows]);
  const tableRows = useMemo(() => rows.filter((r) => r.status !== "exception" && !unpriced(r)), [rows]);
  const exceptionRows = useMemo(() => rows.filter((r) => r.status === "exception"), [rows]);
  const unpricedCount = useMemo(() => rows.filter(unpriced).length, [rows]);
  const lineOptions = useMemo(() => [...new Set(tableRows.map((r) => r.family_key))], [tableRows]);
  // A line filter the loaded batch does not offer would hide every row
  // behind an "All lines" select — it falls back to all.
  useEffect(() => {
    if (lineFilter !== "all" && batch && !lineOptions.includes(lineFilter)) setLineFilter("all");
  }, [batch, lineOptions, lineFilter]);
  const visibleRows = useMemo(
    () => tableRows.filter((r) => (lineFilter === "all" || r.family_key === lineFilter) && (bandFilter === "all" || r.band === bandFilter)),
    [tableRows, lineFilter, bandFilter],
  );
  const batchLocked = totals.sent > 0;
  const earliestAnniversary = useMemo(() => rows.filter(hasLetter).map(reviewDate).filter(Boolean).sort()[0] || null, [rows]);
  const saving = busyRow != null || sending;
  const ready = !!batch && !loadingBatch;
  const primary = approveAction(totals, { ready, saving, batchLocked });

  const selectBatch = (key) => {
    const next = new URLSearchParams(searchParams);
    next.set("batch", key);
    setSearchParams(next);
    setFeedback(null);
  };

  const dropDraft = (rowId) => setDrafts((prev) => { const next = { ...prev }; delete next[rowId]; return next; });

  // A reload that fails after a durable write clears the stale batch so
  // nothing out of date stays actionable (Try again re-reads it). A reload a
  // newer request superseded clears nothing: that request owns the screen.
  const reloadAfterWrite = async (key) => {
    const outcome = await loadBatch(key);
    if (outcome === "failed" && stillSelected(key)) setBatch(null);
    return outcome !== "failed";
  };

  // One PUT per edit; the server recomputes delta/annual/status. The whole
  // batch is then re-read: the digest covers every row, so the screen must
  // never pair a fresh digest with rows another admin changed meanwhile.
  // Every row control is disabled while a save is in flight (`saving`), so
  // a second edit waits instead of being dropped; the saved row's own draft
  // is the only one cleared.
  const putRow = async (row, body, describe) => {
    if (saving) return;
    const key = batch.batchKey;
    setBusyRow(row.id);
    setFeedback(null);
    try {
      const data = await adminFetch(`/admin/rate-review/batches/${key}/rows/${row.id}`, { method: "PUT", body: JSON.stringify(body) });
      if (!stillSelected(key)) return;
      dropDraft(row.id);
      const reloaded = await reloadAfterWrite(key);
      if (!stillSelected(key)) return;
      const text = describe(data.row);
      setFeedback({ ok: true, text: reloaded ? text : `${text} ${RELOAD_FAILED}` });
    } catch (e) {
      if (!stillSelected(key)) return;
      dropDraft(row.id);
      setFeedback({ ok: false, text: e.message || "The change was refused." });
      // A conflict means the batch moved under the screen: show the batch as it is now.
      if (e.status === 409) await reloadAfterWrite(key);
    } finally {
      setBusyRow(null);
    }
  };

  const commitProposed = (row) => {
    const typed = drafts[row.id];
    if (typed == null) return;
    // A cleared field is "no edit", never $0: the prior amount comes back.
    const parsed = String(typed).trim() === "" ? NaN : Number(typed);
    if (!Number.isFinite(parsed)) {
      dropDraft(row.id);
      return;
    }
    const current = Number(row.current_rate_cents) || 0;
    const cents = Math.max(current, isMonthly(row) ? Math.round(parsed * 100) : Math.round(parsed) * 100);
    if (cents === Number(row.proposed_rate_cents)) {
      dropDraft(row.id);
      return;
    }
    putRow(row, { proposed_rate_cents: cents }, (saved) => `${displayName(saved)}: proposed ${dollars(saved.proposed_rate_cents)} per ${unitWord(saved)}.`);
  };

  const toggleInclude = (row, checked) => putRow(row, { status: checked ? "green" : "skipped" }, (saved) => (checked ? `${displayName(saved)} is in the batch.` : `${displayName(saved)} skipped this cycle.`));
  const includeException = (row) => putRow(row, { status: "green", includeException: true }, (saved) => `${displayName(saved)} added to the batch.`);
  // No "back next month": a skipped line is listed again when its
  // anniversary next falls in a batch window (or a catch-up build).
  const skipException = (row) => putRow(row, { status: "skipped", includeException: true }, (saved) => `${displayName(saved)} skipped this cycle.`);

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
      data = await adminFetch(`/admin/rate-review/batches/${key}/approve`, { method: "POST", body: JSON.stringify({ expectedDigest: batch.approvalDigest }) });
    } catch (e) {
      setApproveOpen(false);
      setApproving(false);
      if (!stillSelected(key)) return;
      setFeedback({ ok: false, text: e.message || "The approval was refused." });
      if (e.status === 409) await reloadAfterWrite(key);
      return;
    }
    setApproveOpen(false);
    try {
      if (!stillSelected(key)) return;
      const text = `Batch approved: ${noticeCount(data.approved)} marked approved (${signedDollars(data.annual_delta_cents)} per year). Nothing has been sent yet — use Send letters below the table.`;
      const reloaded = await reloadAfterWrite(key);
      if (stillSelected(key)) setFeedback({ ok: true, text: reloaded ? text : `${text} ${RELOAD_FAILED}` });
    } finally {
      setApproving(false);
    }
  };

  // The owner digest (the ranking's POST …/digest): the same ops email the
  // monthly tick sends to contact@, never a customer send.
  const emailBatch = async () => {
    if (emailing || !batch) return;
    setEmailing(true);
    setFeedback(null);
    const key = batch.batchKey;
    try {
      const data = await adminFetch(`/admin/rate-review/batches/${key}/digest`, { method: "POST" });
      if (!stillSelected(key)) return;
      if (data.sent) setFeedback({ ok: true, text: `${DIGEST_SENT[data.channel] || "Batch digest sent"}: ${data.subject}` });
      else setFeedback({ ok: false, text: DIGEST_SKIPPED[data.skipped] || "Not sent." });
    } catch (e) {
      if (!stillSelected(key)) return;
      setFeedback({ ok: false, text: e.message || "The batch digest failed." });
    } finally {
      setEmailing(false);
    }
  };

  const openLetter = async (row) => {
    const key = batch.batchKey;
    const seq = ++letterSeq.current;
    setLetter({ row, state: "loading" });
    const live = () => letterSeq.current === seq && stillSelected(key);
    try {
      const data = await adminFetch(`/admin/rate-review/batches/${key}/rows/${row.id}/letter-preview`);
      if (live()) setLetter({ row, state: "ready", html: data.html || "", subject: data.subject || "" });
    } catch (e) {
      if (!live()) return;
      setLetter(e.status === 404 ? { row, state: "pending" } : { row, state: "error", error: e.message || "Could not load the letter." });
    }
  };

  const previewLetters = () => {
    const first = tableRows.find(hasLetter);
    if (first) openLetter(first);
    else setFeedback({ ok: false, text: "No letters in this batch yet." });
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
    const { patch, error } = settingsPatch(settingsDraft, config);
    if (error) {
      setSettingsFeedback({ ok: false, text: error });
      return;
    }
    if (!Object.keys(patch).length) {
      setSettingsFeedback({ ok: true, text: "Nothing changed." });
      return;
    }
    setSavingSettings(true);
    setSettingsFeedback(null);
    try {
      const data = await adminFetch("/admin/rate-review/config", { method: "PUT", body: JSON.stringify(patch) });
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

  const rowProps = (row) => ({
    batchLocked,
    saving,
    busy: busyRow === row.id,
    draft: drafts[row.id],
    onDraft: (value) => setDrafts((prev) => ({ ...prev, [row.id]: value })),
    onCommit: () => commitProposed(row),
    onToggle: (checked) => toggleInclude(row, checked),
    onLetter: openLetter,
  });

  // The panel's prepare/send change row states (approved → sent): re-read the batch.
  const reloadSelected = () => { if (selectedKeyRef.current) reloadAfterWrite(selectedKeyRef.current); };
  const closeApprove = () => { if (!approving) setApproveOpen(false); };
  const retryLetter = () => { if (letter) openLetter(letter.row); };
  const retryBatch = () => { if (selectedKey) loadBatch(selectedKey); };

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

      <BatchStage loadError={loadError} batches={batches} onRetry={loadBatches} />

      {batches?.length > 0 && (
        <BatchControls
          batches={batches}
          selectedKey={selectedKey}
          onSelectBatch={selectBatch}
          lineOptions={lineOptions}
          lineFilter={lineFilter}
          onLineFilter={setLineFilter}
          bandFilter={bandFilter}
          onBandFilter={setBandFilter}
          config={config}
          onCostBlock={openCostBlock}
          approve={{ ...primary, loading: approving, onClick: () => setApproveOpen(true) }}
          email={{ disabled: !ready, loading: emailing, onClick: emailBatch }}
          preview={{ disabled: !ready, onClick: previewLetters }}
          feedback={feedback}
        />
      )}

      <BatchBody
        batch={batch}
        batchError={batchError}
        loadingBatch={loadingBatch}
        onRetry={retryBatch}
        totals={totals}
        tableRows={tableRows}
        visibleRows={visibleRows}
        exceptionRows={exceptionRows}
        unpricedCount={unpricedCount}
        liveConfig={config}
        rowProps={rowProps}
        exceptionProps={{ disabled: batchLocked || saving, busyRow, onInclude: includeException, onSkip: skipException }}
        sendProps={{ disabled: busyRow != null || approving || savingSettings, onBusyChange: setSending, onChanged: reloadSelected }}
      />

      {/* Settings stand on their own: the knobs and the cost block are set before the first batch exists. */}
      {config && (
        <SettingsCard
          open={settingsOpen}
          onToggle={() => setSettingsOpen((v) => !v)}
          draft={settingsDraft}
          onDraft={(key, value) => setSettingsDraft((prev) => ({ ...prev, [key]: value }))}
          saving={savingSettings}
          feedback={settingsFeedback}
          onSave={saveSettings}
          costBlockRef={costBlockRef}
        />
      )}

      <ApproveDialog
        open={approveOpen}
        onClose={closeApprove}
        batchKey={batch?.batchKey}
        totals={totals}
        earliest={earliestAnniversary}
        approvalDigest={batch?.approvalDigest}
        approving={approving}
        onApprove={approve}
      />
      <LetterSheet letter={letter} onClose={closeLetter} onRetry={retryLetter} />
    </UiSurface>
  );
}
