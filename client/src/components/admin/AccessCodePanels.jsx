/**
 * Access codes section: the pieces Customer 360 and the Gate codes page share.
 *
 * Presentational only. The two callers own the fetches (so each fetch site is
 * visible to the intelligence-bar coverage check) and hand these components
 * callbacks that return a promise. A callback that rejects shows the error's
 * message under the form; the server's messages for visit_required,
 * invalid_visit, expired and duplicate_active are already plain sentences.
 *
 * Staff-only. Codes are shown to the office as typed; nothing here logs or
 * stores one.
 */
import { useState } from "react";
import { ActionFeedback, Badge, Button, Input, Select, Textarea, cn } from "../ui";

export const ACCESS_KINDS = [
  { value: "neighborhood_gate", label: "Neighborhood gate" },
  { value: "property_gate", label: "Property gate" },
  { value: "door", label: "Door or lock" },
  { value: "lockbox", label: "Lockbox" },
  { value: "garage", label: "Garage" },
  { value: "call_box", label: "Call box" },
  { value: "pass", label: "Visitor pass" },
  { value: "other", label: "Other" },
];
const KIND_LABEL = Object.fromEntries(ACCESS_KINDS.map((k) => [k.value, k.label]));
export const kindLabel = (kind) => KIND_LABEL[kind] || "Access code";

// A visit that is over no longer carries a one-visit code (the server's list).
const ENDED_VISIT_STATUSES = new Set(["completed", "cancelled", "canceled", "skipped", "no_show", "rescheduled"]);
const VISIT_WINDOW_DAYS = 14;
const ET = "America/New_York";

// "YYYY-MM-DD" for a date-only string or an instant, in Eastern time.
function dayKey(value) {
  if (!value) return "";
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text) && text.length <= 10) return text.slice(0, 10);
  // A calendar date serialized as UTC midnight ("2026-10-08T00:00:00.000Z") is
  // that calendar day, not the evening before in Eastern time.
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(text)) return text.slice(0, 10);
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return parts;
}

function shiftDay(key, days) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmtDay(key, opts = { month: "short", day: "numeric" }) {
  if (!key) return "";
  const d = new Date(`${key}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}

export function lifeLabel(row) {
  if (row.life !== "visit") return "Always";
  const day = fmtDay(dayKey(row.scheduledDate));
  return day ? `This visit: ${day}` : "One visit only";
}

export function sourceLabel(row) {
  if (row.sourceType === "staff") return "Added by office";
  const day = fmtDay(dayKey(row.sourceAt));
  return day ? `Text, ${day}` : "Text";
}

// The customer's visits a one-visit code may be tied to: not over, and inside
// the 14 days that start the day the code was sent (the server enforces the
// same window). `fromAt` is the send time; omit it for "today".
export function visitChoices(visits, fromAt = null, today = dayKey(new Date()), homes = []) {
  // On a multi-home account each choice names its home, so two visits on one
  // day at different homes differ.
  const homeOf = (v) => (homes.length > 1 ? homes.find((h) => h.id === (v.property_id || v.propertyId))?.label || "Home not set" : null);
  const from = dayKey(fromAt) || today;
  const to = shiftDay(from, VISIT_WINDOW_DAYS);
  return (Array.isArray(visits) ? visits : [])
    .filter((v) => v?.id && !ENDED_VISIT_STATUSES.has(String(v.status || "").toLowerCase()))
    .map((v) => ({ id: v.id, day: dayKey(v.scheduled_date || v.scheduledDate), type: v.service_type || v.serviceType || "", home: homeOf(v) }))
    .filter((v) => v.day && v.day >= from && v.day <= to)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .map((v) => ({
      id: v.id,
      label: [fmtDay(v.day, { weekday: "short", month: "short", day: "numeric" }), v.type, v.home].filter(Boolean).join(" · "),
    }));
}

const errorText = (err, fallback) => err?.body?.error || err?.message || fallback;

function Label({ children }) {
  return <span className="ui-label text-ink-secondary mb-1 block">{children}</span>;
}

function LifeToggle({ value, onChange, disabled }) {
  return (
    <div className="flex items-center gap-2" role="group" aria-label="How long the code works">
      <Button size="sm" type="button" variant={value === "standing" ? "primary" : "secondary"} aria-pressed={value === "standing"} disabled={disabled} onClick={() => onChange("standing")}>
        Always
      </Button>
      <Button size="sm" type="button" variant={value === "visit" ? "primary" : "secondary"} aria-pressed={value === "visit"} disabled={disabled} onClick={() => onChange("visit")}>
        This visit only
      </Button>
    </div>
  );
}

// kind / code / directions / life / visit: the fields a found code is edited
// in and a staff code is typed into. `draft` and `setDraft` live in the caller.
function CodeFields({ idPrefix, draft, setDraft, choices, busy, homes = [] }) {
  const set = (key) => (event) => setDraft((d) => ({ ...d, [key]: event.target.value }));
  return (
    <div className="grid gap-2">
      <div className="grid gap-2 md:grid-cols-2">
        <label className="block">
          <Label>Kind</Label>
          <Select id={`${idPrefix}-kind`} value={draft.kind} onChange={set("kind")} disabled={busy}>
            {ACCESS_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </Select>
        </label>
        <label className="block">
          <Label>Code</Label>
          <Input
            id={`${idPrefix}-code`}
            className="font-mono"
            value={draft.code}
            onChange={set("code")}
            maxLength={40}
            autoComplete="off"
            disabled={busy}
          />
        </label>
      </div>
      <label className="block">
        <Label>Directions</Label>
        <Textarea id={`${idPrefix}-instructions`} rows={2} value={draft.instructions} onChange={set("instructions")} maxLength={600} disabled={busy} />
      </label>
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <Label>Works for</Label>
          <LifeToggle value={draft.life} disabled={busy} onChange={(life) => setDraft((d) => ({ ...d, life }))} />
        </div>
        {draft.life === "visit" && (
          <label className="block">
            <Label>Visit</Label>
            <Select id={`${idPrefix}-visit`} value={draft.scheduledServiceId} onChange={set("scheduledServiceId")} disabled={busy}>
              <option value="">{choices.length ? "Choose a visit" : "No visit in the next 14 days"}</option>
              {choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select>
          </label>
        )}
      </div>
      {draft.life === "standing" && homes.length > 1 && (
        <label className="block">
          <Label>Home</Label>
          <Select id={`${idPrefix}-home`} value={draft.propertyId} onChange={set("propertyId")} disabled={busy}>
            <option value="">Choose which home</option>
            {homes.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
          </Select>
        </label>
      )}
      {draft.life === "visit" && choices.length === 0 && (
        <div className="text-ui-label text-ink-secondary">
          No visit to tie it to. The code is kept for 14 days from the day it was sent.
        </div>
      )}
    </div>
  );
}

// The body for accept and add. A standing code never names a visit.
export function bodyFromDraft(draft) {
  const body = {
    kind: draft.kind,
    life: draft.life,
    code: draft.code.trim() || null,
    instructions: draft.instructions.trim() || null,
  };
  if (draft.life === "visit" && draft.scheduledServiceId) body.scheduledServiceId = draft.scheduledServiceId;
  // A multi-home account names the home of a standing code.
  if (draft.life === "standing" && draft.propertyId) body.propertyId = draft.propertyId;
  return body;
}

function draftFromRow(row, choices) {
  const bound = row.scheduledServiceId && choices.some((c) => c.id === row.scheduledServiceId) ? row.scheduledServiceId : "";
  return {
    kind: row.kind || "other",
    life: row.life || "standing",
    code: row.code || "",
    instructions: row.instructions || "",
    scheduledServiceId: bound,
    propertyId: row.propertyId || "",
  };
}

const BLANK_DRAFT = { kind: "door", life: "standing", code: "", instructions: "", scheduledServiceId: "", propertyId: "" };

function useGuarded() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn, fallback) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      return true;
    } catch (err) {
      setError(errorText(err, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

// One active code. Retire asks inline (no browser dialog).
export function ActiveCodeRow({ row, homes = [], onRetire }) {
  // On a multi-home account each code says which home it opens.
  const home = homes.length > 1 ? homes.find((h) => h.id === row.propertyId)?.label || "No home set" : null;
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useGuarded();
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 rounded-sm border-hairline border-zinc-200 px-3 py-2">
      <div className="min-w-0 basis-full flex-1 md:basis-auto">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui-label font-medium text-zinc-900">{kindLabel(row.kind)}</span>
          <Badge tone={row.life === "visit" ? "neutral" : "strong"}>{lifeLabel(row)}</Badge>
        </div>
        {row.code && <div className="mt-1 font-mono u-nums break-all text-ui-body font-medium text-zinc-900">{row.code}</div>}
        {row.instructions && <div className="mt-1 break-words whitespace-pre-line text-ui-label text-zinc-900">{row.instructions}</div>}
        {home && <div className="mt-1 text-ui-label text-zinc-900">{home}</div>}
        <div className="mt-1 text-ui-label text-ink-secondary">{sourceLabel(row)}</div>
        {error && <ActionFeedback error className="mt-1">{error}</ActionFeedback>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <span className="text-ui-label text-ink-secondary">Retire this code?</span>
            <Button size="sm" variant="secondary" disabled={busy} onClick={async () => { if (await run(() => onRetire(row), "Could not retire the code")) setConfirming(false); }}>
              Yes, retire
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Keep</Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>Retire</Button>
        )}
      </div>
    </div>
  );
}

// A code found in a text, waiting for the office. `visits` is the customer's
// upcoming visits; `renderHeading` names the customer on the page that lists
// every customer's codes.
export function FoundCodeCard({ row, visits, homes = null, onSave, onDismiss, renderHeading = null }) {
  const homeList = homes || row.propertyChoices || [];
  const choices = visitChoices(visits, row.sourceAt, undefined, homeList);
  const [draft, setDraft] = useState(() => draftFromRow(row, choices));
  const { busy, error, run } = useGuarded();
  const typed = draft.code.trim() || draft.instructions.trim();
  return (
    <div className="grid gap-2 rounded-sm border-hairline border-zinc-200 bg-zinc-50 px-3 py-3">
      {renderHeading && <div className="text-ui-body font-medium text-zinc-900">{renderHeading(row)}</div>}
      {row.sourceQuote && (
        <blockquote className="border-l-2 border-zinc-300 pl-2 text-ui-label text-zinc-900 break-words whitespace-pre-line">
          {row.sourceQuote}
        </blockquote>
      )}
      <div className="text-ui-label text-ink-secondary">{sourceLabel(row)}</div>
      <CodeFields idPrefix={`found-${row.id}`} draft={draft} setDraft={setDraft} choices={choices} busy={busy} homes={homeList} />
      {error && <ActionFeedback error>{error}</ActionFeedback>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || !typed} onClick={() => run(() => onSave(row, bodyFromDraft(draft)), "Could not save the code")}>
          Save
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => onDismiss(row), "Could not dismiss the code")}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

// The office types a code in itself.
export function AddCodeForm({ visits, homes = [], onSubmit, onCancel }) {
  const choices = visitChoices(visits, null, undefined, homes);
  const [draft, setDraft] = useState(BLANK_DRAFT);
  const { busy, error, run } = useGuarded();
  const typed = draft.code.trim() || draft.instructions.trim();
  return (
    <form
      className={cn("grid gap-2 rounded-sm border-hairline border-zinc-200 bg-zinc-50 px-3 py-3")}
      onSubmit={async (event) => {
        event.preventDefault();
        if (await run(() => onSubmit(bodyFromDraft(draft)), "Could not add the code")) onCancel();
      }}
    >
      <CodeFields idPrefix="add-access-code" draft={draft} setDraft={setDraft} choices={choices} busy={busy} homes={homes} />
      {error && <ActionFeedback error>{error}</ActionFeedback>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={busy || !typed}>Add code</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
