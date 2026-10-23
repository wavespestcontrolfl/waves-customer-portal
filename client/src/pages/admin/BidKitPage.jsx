import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ActionFeedback, Badge, Button, Card, CardBody, Field, Input, Select, Textarea, UiSurface,
} from "../../components/ui";
import { adminFetch } from "../../lib/adminFetch";
import { formatETDate, formatETDateOnly, formatETTime } from "../../lib/timezone";
import { STATUS_LABEL, SIGN_OFF_REFUSAL, LIMIT_DOLLAR_KEYS, WORKERS_COMP_VALUES, PUBLIC_OR_PRIVATE, REFERENCE_DETAIL_KEYS } from "@bid-kit-catalog";

// Bid kit (GATE_BID_KIT, dark, admin only). The papers and facts every government bid asks for. Nothing here is public and
// nothing is sent to anyone. A status comes from the server; a sign-off belongs to the version of the item you looked at,
// and any edit to the item clears it. Every write carries the version the page loaded; when the server says the item
// changed (409) the open editors close and the list is read again. No AI anywhere.

const STATUS_TONE = {
  ready: "strong", expiring: "strong", missing: "alert", expired: "alert", needs_expiry: "warn", needs_permission: "warn", unattested: "warn",
};
const LIMIT_LABEL = {
  glEachOccurrence: "General liability, each occurrence", glAggregate: "General liability, aggregate", productsCompletedOps: "Products and completed operations",
  autoCombinedSingle: "Auto, combined single limit", employersLiability: "Employer’s liability", umbrella: "Umbrella", pollution: "Pollution",
};
const DETAIL_LABEL = {
  entity: "Entity", contactRole: "Contact role", phone: "Phone", email: "Email", contractPeriod: "Contract period", scope: "Scope of work", annualValue: "Annual value", publicOrPrivate: "Public or private",
};
const INSURANCE_KEYS = ["insurance_certificate", "pollution_coverage"];
const ACCEPT = ".pdf,.png,.jpg,.jpeg,.docx,application/pdf,image/png,image/jpeg,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const CONFLICT_MESSAGE = "Someone else changed this item. Here is the latest version; make your change again.";
const NEW_REFERENCE = "new:reference";
const NEW_CUSTOM = "new:custom";
const CUSTOM_ENTRY = { item: { key: "custom", kind: "document", label: "", expires: true, why: "" }, row: null, status: "missing" };

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  const res = await adminFetch(`/admin/bid-kit${path}`, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error || `HTTP ${res.status}`, res.status);
  return body;
}

// The writes. Each one carries the version of the row the page loaded, so a stale page is refused by the server.
const patchItem = (row, body) => api(`/${row.id}`, { method: "PATCH", body: { ...body, expected_updated_at: row.updated_at } });
const createItem = (item, body, kind) => {
  const create = { kind: kind || item.kind, item_key: item.key, ...body };
  if (item.key !== "custom") delete create.label;
  return api("/", { method: "POST", body: create });
};
const archiveItem = (row) => api(`/${row.id}?expected_updated_at=${encodeURIComponent(row.updated_at)}`, { method: "DELETE" });
const signOffItem = (row) => api(`/${row.id}/attest`, { method: "POST", body: { expected_updated_at: row.updated_at } });
const fetchFileLink = (row) => api(`/${row.id}/file`);
const sendFile = (row, file) => {
  const form = new FormData();
  form.append("expected_updated_at", row.updated_at);
  form.append("file", file);
  return api(`/${row.id}/file`, { method: "POST", body: form });
};
// A file for an item with no row yet gets a blank row first, so the file has a place to live. That row is never removed
// automatically: after a failure the page reads the list again, the row shows as missing (which is true) with the error
// beside it, and a retry uploads to that same row. Archiving it here could hit a row another admin just updated, or one
// whose upload did succeed with the answer lost.
async function uploadFor(entry, file) {
  if (entry.row) return sendFile(entry.row, file);
  const { item: created } = await createItem(entry.item, {});
  try {
    return await sendFile(created, file);
  } catch (err) {
    err.note = "The item was added without a file. Upload again, or archive it.";
    throw err;
  }
}

// A calendar date (checked, expires, permission) is a plain day with no time zone.
const dateText = (value) => (value ? formatETDateOnly(value, { month: "short", day: "numeric", year: "numeric" }) : "");
// A timestamp (the sign-off) is an instant: it is shown in Eastern time with the zone named, so a sign-off late in the evening
// does not show the next day's date.
const instantText = (value) => {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  return `${formatETDate(at, { month: "short", day: "numeric", year: "numeric" })} at ${formatETTime(at)} ET`;
};
// Today in Eastern time as YYYY-MM-DD: the latest day a check or a permission can carry.
const todayET = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

// The server's items laid over the catalog: one entry per catalog item and row, or one empty entry for an item with no
// row yet. A row with item_key "custom" goes to the last section.
export function buildEntries(sections, items) {
  const live = items.filter((row) => !row.archived_at);
  const out = sections.map((section) => ({
    key: section.key,
    label: section.label,
    entries: section.items.flatMap((item) => {
      const mine = live.filter((row) => row.item_key === item.key && row.kind === item.kind);
      return mine.length ? mine.map((row) => ({ item, row, status: row.status })) : [{ item, row: null, status: "missing" }];
    }),
  }));
  const customs = live.filter((row) => row.item_key === "custom");
  if (customs.length) {
    out.push({
      key: "other",
      label: "Other",
      entries: customs.map((row) => ({ item: { key: "custom", kind: row.kind, label: row.label, expires: false, why: "" }, row, status: row.status })),
    });
  }
  return out;
}

export function StatusChip({ status }) {
  return <Badge tone={STATUS_TONE[status] || "neutral"}>{STATUS_LABEL[status] || status}</Badge>;
}

function CopyButton({ text, label }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      setDone(false);
    }
  };
  return <Button size="sm" variant="secondary" onClick={copy} aria-label={`Copy ${label}`}>{done ? "Copied" : "Copy"}</Button>;
}

function FactLine({ fact }) {
  return (
    <li className="flex flex-wrap items-center gap-2 text-ui-body">
      <span className="w-56 shrink-0 text-ink-secondary">{fact.label}</span>
      {fact.value ? (
        <>
          <span className="min-w-0 flex-1 break-words font-medium text-zinc-900">{fact.value}</span>
          {!fact.signedOff && <Badge tone="warn">Not signed off</Badge>}
          <CopyButton text={fact.value} label={fact.label} />
        </>
      ) : <span className="text-ink-secondary">Not filled in</span>}
    </li>
  );
}

function DocumentLine({ doc }) {
  return (
    <li className="flex flex-wrap items-center gap-2 text-ui-body">
      <span className="w-56 shrink-0 text-ink-secondary">{doc.label}</span>
      {doc.number && (
        <>
          <span className="font-medium text-zinc-900">{doc.number}</span>
          <CopyButton text={doc.number} label={`${doc.label} number`} />
        </>
      )}
      {doc.expiresOn && (
        <>
          <span className="text-ink-secondary">Expires {dateText(doc.expiresOn)}</span>
          <CopyButton text={doc.expiresOn} label={`${doc.label} expiry date`} />
        </>
      )}
      <StatusChip status={doc.status} />
    </li>
  );
}

function FactsSheet() {
  const [state, setState] = useState({ loading: true, error: "", data: null });
  useEffect(() => {
    let live = true;
    api("/facts-sheet")
      .then((data) => live && setState({ loading: false, error: "", data }))
      .catch((err) => live && setState({ loading: false, error: err.message, data: null }));
    return () => { live = false; };
  }, []);
  if (state.loading) return <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Loading facts…</div>;
  if (state.error) return <ActionFeedback error>{state.error}</ActionFeedback>;
  const { facts, documents } = state.data;
  return (
    <div className="grid gap-4">
      <p className="text-ui-body text-ink-secondary">Copy a value into the agency form. A value marked “not signed off” has not been checked by the owner yet.</p>
      <Card>
        <CardBody>
          <h2 className="mb-2 text-ui-body font-medium text-zinc-900">Company facts</h2>
          <ul className="grid gap-2">{facts.map((fact, index) => <FactLine key={`${fact.key}-${index}`} fact={fact} />)}</ul>
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <h2 className="mb-2 text-ui-body font-medium text-zinc-900">Document numbers and expiry dates</h2>
          {documents.length === 0 && <div className="text-ui-body text-ink-secondary">No document numbers or dates saved yet.</div>}
          <ul className="grid gap-2">{documents.map((doc, index) => <DocumentLine key={`${doc.key}-${index}`} doc={doc} />)}</ul>
        </CardBody>
      </Card>
    </div>
  );
}

// ---- the editor ----

function initialForm({ item, row }) {
  const r = row || {};
  return {
    label: r.label || (item.key === "custom" ? "" : item.label),
    kind: r.kind || item.kind,
    value: r.value || "",
    source: r.source_document || "",
    checkedOn: r.checked_on || "",
    expiresOn: r.expires_on || "",
    permissionOn: r.permission_on || "",
    limits: Object.fromEntries([...LIMIT_DOLLAR_KEYS, "workersComp"].map((key) => [key, (r.limits || {})[key] ?? ""])),
    details: Object.fromEntries(REFERENCE_DETAIL_KEYS.map((key) => [key, (r.details || {})[key] ?? ""])),
  };
}

// Which fields the form shows for the kind in the form (a custom item's kind can change while it is being added).
function fieldsFor(kind, entry) {
  const { item, row } = entry;
  const isCustom = item.key === "custom";
  const isDocument = kind === "document";
  return {
    isReference: kind === "reference",
    showValue: kind !== "reference",
    showExpiry: (isDocument && (isCustom || Boolean(item.expires))) || Boolean(row && row.expires_on),
    showLimits: isDocument && (isCustom || INSURANCE_KEYS.includes(item.key)),
  };
}

// The limits as whole dollars, or the sentence that says which one is wrong.
function parseLimits(limits) {
  const out = {};
  for (const key of LIMIT_DOLLAR_KEYS) {
    const text = String(limits[key]).replace(/[$,\s]/g, "");
    if (text === "") continue;
    if (!/^\d+$/.test(text)) return { problem: `${LIMIT_LABEL[key]} must be a whole number of dollars` };
    out[key] = Number(text);
  }
  if (limits.workersComp) out.workersComp = limits.workersComp;
  return { limits: Object.keys(out).length ? out : null };
}

// What the form sends: only the fields shown for its kind.
function buildBody(form, shown, isCustom) {
  const body = { source_document: form.source, checked_on: form.checkedOn || null };
  if (shown.showValue) body.value = form.value;
  if (isCustom) body.label = form.label;
  if (shown.showExpiry) body.expires_on = form.expiresOn || null;
  if (shown.isReference) {
    body.permission_on = form.permissionOn || null;
    body.details = Object.fromEntries(Object.entries(form.details).filter(([, entry]) => entry !== ""));
  }
  if (!shown.showLimits) return { body };
  const parsed = parseLimits(form.limits);
  if (parsed.problem) return { problem: parsed.problem };
  body.limits = parsed.limits;
  return { body };
}

function CustomFields({ form, set, canPickKind }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Field id="kit-label" label="Name"><Input value={form.label} maxLength={200} onChange={(event) => set("label", event.target.value)} /></Field>
      {canPickKind && (
        <Field id="kit-kind" label="Type">
          <Select value={form.kind} onChange={(event) => set("kind", event.target.value)}>
            <option value="document">Document</option>
            <option value="fact">Fact</option>
            <option value="reference">Reference</option>
          </Select>
        </Field>
      )}
    </div>
  );
}

function ValueField({ form, set }) {
  const isFact = form.kind === "fact";
  return (
    <Field id="kit-value" label={isFact ? "Value" : "Number or note"} help={isFact ? undefined : "A policy or license number, if the paper has one. Never type a tax ID or Social Security number here."}>
      {isFact
        ? <Textarea rows={2} maxLength={2000} value={form.value} onChange={(event) => set("value", event.target.value)} />
        : <Input value={form.value} maxLength={2000} onChange={(event) => set("value", event.target.value)} />}
    </Field>
  );
}

function DateFields({ form, set, shown }) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Field id="kit-source" label="Source document" help="Where this came from."><Input value={form.source} maxLength={500} onChange={(event) => set("source", event.target.value)} /></Field>
      <Field id="kit-checked" label="Checked on"><Input type="date" max={todayET()} value={form.checkedOn} onChange={(event) => set("checkedOn", event.target.value)} /></Field>
      {shown.showExpiry && <Field id="kit-expires" label="Expires on"><Input type="date" value={form.expiresOn} onChange={(event) => set("expiresOn", event.target.value)} /></Field>}
      {shown.isReference && <Field id="kit-permission" label="Permission given on" help="The day this person agreed to be named."><Input type="date" max={todayET()} value={form.permissionOn} onChange={(event) => set("permissionOn", event.target.value)} /></Field>}
    </div>
  );
}

function LimitsFields({ form, setNested }) {
  return (
    <fieldset className="grid gap-3 md:grid-cols-3">
      <legend className="mb-1 text-ui-body font-medium text-zinc-900">Limits (whole dollars)</legend>
      {LIMIT_DOLLAR_KEYS.map((key) => (
        <Field key={key} id={`kit-limit-${key}`} label={LIMIT_LABEL[key]}>
          <Input inputMode="numeric" value={form.limits[key]} onChange={(event) => setNested("limits", key, event.target.value)} />
        </Field>
      ))}
      <Field id="kit-limit-workersComp" label="Workers’ compensation">
        <Select value={form.limits.workersComp} onChange={(event) => setNested("limits", "workersComp", event.target.value)}>
          <option value="">Not set</option>
          {WORKERS_COMP_VALUES.map((entry) => <option key={entry} value={entry}>{entry === "statutory" ? "Statutory" : "Exempt"}</option>)}
        </Select>
      </Field>
    </fieldset>
  );
}

function ReferenceFields({ form, setNested }) {
  return (
    <fieldset className="grid gap-3 md:grid-cols-2">
      <legend className="mb-1 text-ui-body font-medium text-zinc-900">Reference details</legend>
      {REFERENCE_DETAIL_KEYS.map((key) => (
        <Field key={key} id={`kit-detail-${key}`} label={DETAIL_LABEL[key]}>
          {key === "publicOrPrivate" ? (
            <Select value={form.details[key]} onChange={(event) => setNested("details", key, event.target.value)}>
              <option value="">Not set</option>
              {PUBLIC_OR_PRIVATE.map((entry) => <option key={entry} value={entry}>{entry === "public" ? "Public" : "Private"}</option>)}
            </Select>
          ) : <Input value={form.details[key]} onChange={(event) => setNested("details", key, event.target.value)} />}
        </Field>
      ))}
    </fieldset>
  );
}

// The editor for one entry: a new row (POST) or a saved one (PATCH, fenced on the version the page loaded).
function Editor({ entry, busy, onSave, onArchive, onCancel }) {
  const { item, row } = entry;
  const isCustom = item.key === "custom";
  const [form, setForm] = useState(() => initialForm(entry));
  const [problem, setProblem] = useState("");
  const shown = fieldsFor(form.kind, entry);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const setNested = (group, key, value) => setForm((f) => ({ ...f, [group]: { ...f[group], [key]: value } }));

  const submit = (event) => {
    event.preventDefault();
    const built = buildBody(form, shown, isCustom);
    setProblem(built.problem || "");
    if (!built.problem) onSave(built.body, { kind: form.kind, label: form.label });
  };

  return (
    <form className="mt-3 grid gap-3 rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3" onSubmit={submit} aria-label={`Edit ${item.label}`}>
      {isCustom && <CustomFields form={form} set={set} canPickKind={!row} />}
      {shown.showValue && <ValueField form={form} set={set} />}
      <DateFields form={form} set={set} shown={shown} />
      {shown.showLimits && <LimitsFields form={form} setNested={setNested} />}
      {shown.isReference && <ReferenceFields form={form} setNested={setNested} />}
      {!row && form.kind === "document" && <p className="text-ui-caption text-ink-secondary">Save the details first, then use Upload file on the item.</p>}
      <p className="text-ui-caption text-ink-secondary">Saving a change to the value, dates, limits, details or source clears the sign-off.</p>
      {problem && <ActionFeedback error>{problem}</ActionFeedback>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || (isCustom && !form.label.trim())}>Save</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        {row && <Button type="button" variant="ghost" disabled={busy} onClick={onArchive}>Archive</Button>}
      </div>
    </form>
  );
}

// ---- one row of the checklist ----

function Line({ label, children }) {
  return <div><span className="text-ink-secondary">{label}</span>{children}</div>;
}

const limitsText = (limits) => Object.entries(limits)
  .map(([key, amount]) => `${LIMIT_LABEL[key] || (key === "workersComp" ? "Workers’ comp" : key)} ${typeof amount === "number" ? `$${amount.toLocaleString("en-US")}` : amount}`)
  .join("; ");

function referenceValue(key, value) {
  if (key !== "publicOrPrivate") return value;
  return value === "public" ? "Public" : "Private";
}

function ReferenceLines({ row }) {
  const details = row.details || {};
  return (
    <>
      {Object.keys(DETAIL_LABEL).filter((key) => details[key]).map((key) => (
        <Line key={key} label={`${DETAIL_LABEL[key]}: `}>{referenceValue(key, String(details[key]))}</Line>
      ))}
      {row.permission_on && <Line label="Permission given: ">{dateText(row.permission_on)}</Line>}
    </>
  );
}

function SourceLine({ row }) {
  if (!row.source_document && !row.checked_on) return null;
  return (
    <div>
      <span className="text-ink-secondary">Source: </span>{row.source_document || "not recorded"}
      {row.checked_on && <span className="text-ink-secondary"> · checked {dateText(row.checked_on)}</span>}
    </div>
  );
}

function RowDetails({ row, item }) {
  return (
    <div className="mt-1 grid gap-0.5 text-ui-body">
      {row.value && <Line label={item.kind === "fact" ? "Value: " : "Number: "}>{row.value}</Line>}
      {row.file && <Line label="File: ">{row.file.name}</Line>}
      {row.expires_on && <Line label="Expires: ">{dateText(row.expires_on)}</Line>}
      {item.expires && !row.expires_on && <div className="text-warn-fg">No expiry date saved. Add one so the kit can warn you.</div>}
      <SourceLine row={row} />
      {row.kind === "reference" && <ReferenceLines row={row} />}
      {row.limits && <Line label="Limits: ">{limitsText(row.limits)}</Line>}
      {row.attested_at && <div className="text-ink-secondary">Signed off {instantText(row.attested_at)}</div>}
    </div>
  );
}

function RowTitle({ entry }) {
  const { item, row, status } = entry;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="break-words text-ui-body font-medium text-zinc-900">{(row && row.label) || item.label}</h3>
        <StatusChip status={status} />
        {item.perBid && <Badge>New one for each bid</Badge>}
        {item.notarized && <Badge>Notarized</Badge>}
      </div>
      {!row && item.why && <div className="text-ui-caption text-ink-secondary">{item.why}</div>}
      {item.renewalRule && <div className="text-ui-caption text-ink-secondary">{item.renewalRule}</div>}
    </div>
  );
}

function FileButtons({ entry, busy, onOpenFile, onUpload }) {
  const { item, row } = entry;
  const fileInput = useRef(null);
  const name = (row && row.label) || item.label;
  return (
    <>
      {row && row.file && <Button size="sm" variant="secondary" disabled={busy} onClick={() => onOpenFile(row)}>Open file</Button>}
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => fileInput.current && fileInput.current.click()}>{row && row.file ? "Replace file" : "Upload file"}</Button>
      <input
        ref={fileInput} type="file" accept={ACCEPT} hidden aria-label={`File for ${name}`}
        onChange={(event) => { const file = event.target.files && event.target.files[0]; event.target.value = ""; if (file) onUpload(entry, file); }}
      />
    </>
  );
}

function SignOffButton({ entry, busy, onSignOff }) {
  const { row, status } = entry;
  const refused = SIGN_OFF_REFUSAL[status];
  const reason = row.attested_at ? "Signed off" : refused || "";
  return <Button size="sm" disabled={busy || Boolean(row.attested_at) || Boolean(refused)} title={reason} onClick={() => onSignOff(row)}>Sign off</Button>;
}

function Row({ entry, busy, editing, highlighted, handlers }) {
  const { item, row } = entry;
  return (
    <li id={row ? `bid-kit-${row.id}` : undefined} className={`rounded-sm border-hairline px-3 py-3 ${highlighted ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 bg-white"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <RowTitle entry={entry} />
        <div className="flex flex-wrap gap-2">
          {item.kind !== "fact" && <FileButtons entry={entry} busy={busy} onOpenFile={handlers.openFile} onUpload={handlers.upload} />}
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => handlers.edit(entry)}>{row ? "Edit" : "Add details"}</Button>
          {row && <SignOffButton entry={entry} busy={busy} onSignOff={handlers.signOff} />}
        </div>
      </div>
      {row && <RowDetails row={row} item={item} />}
      {editing && (
        <Editor
          key={row ? row.updated_at : "new"} entry={entry} busy={busy}
          onSave={(body, extra) => handlers.save(entry, body, extra)} onArchive={() => handlers.archive(row)} onCancel={handlers.cancel}
        />
      )}
    </li>
  );
}

function Section({ section, counts, editing, busy, focusId, handlers }) {
  const hasRows = section.entries.some((entry) => entry.row);
  return (
    <section aria-labelledby={`bid-kit-section-${section.key}`}>
      <h2 id={`bid-kit-section-${section.key}`} className="mb-2 text-ui-body font-medium text-zinc-900">
        {section.label}
        {counts && <span className="ml-2 font-normal text-ink-secondary">{counts.ready} of {counts.total} ready</span>}
      </h2>
      <ul className="grid gap-2">
        {section.entries.map((entry) => {
          const id = entry.row ? entry.row.id : `new:${entry.item.key}`;
          return <Row key={id} entry={entry} busy={busy} editing={editing === id} highlighted={!!entry.row && entry.row.id === focusId} handlers={handlers} />;
        })}
      </ul>
      {section.key === "references" && (
        <>
          <Button size="sm" variant="secondary" className="mt-2" disabled={busy} onClick={() => handlers.setEditing(NEW_REFERENCE)}>Add a reference</Button>
          {editing === NEW_REFERENCE && hasRows && (
            <Editor
              entry={{ ...section.entries[0], row: null }} busy={busy}
              onSave={(body, extra) => handlers.save({ item: section.entries[0].item, row: null }, body, extra)} onArchive={() => {}} onCancel={handlers.cancel}
            />
          )}
        </>
      )}
    </section>
  );
}

function SummaryLine({ overall }) {
  const open = [
    overall.missing && `${overall.missing} missing`,
    overall.expired && `${overall.expired} expired`,
    overall.needs_expiry && `${overall.needs_expiry} need an expiry date`,
  ].filter(Boolean);
  return (
    <span className="ml-2 text-ui-body font-medium text-zinc-900" data-testid="bid-kit-summary">
      {overall.ready} of {overall.total} ready{overall.expiring > 0 && ` · ${overall.expiring} expiring soon`}
      {open.length > 0 && <span className="font-normal text-ink-secondary"> · {open.join(", ")}</span>}
    </span>
  );
}

// ---- state ----

function useKit() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState({ text: "", off: false });
  const load = useCallback(async () => {
    try {
      setData(await api("/"));
      setError({ text: "", off: false });
    } catch (err) {
      setError({ text: err.message, off: err.status === 404 });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  return { data, loading, error, load };
}

// The page's writes. One mutation at a time (busy), a message that says what happened, and the list read again after it so
// statuses and the summary always come from the server. A 409 closes every open editor: they hold fields from the old
// version, and a later Save would send them with the new version token and overwrite the other change.
function useKitActions(load, closeEditors) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState({ text: "", error: false });

  const run = async (action, done) => {
    setBusy(true);
    setMessage({ text: "", error: false });
    try {
      await action();
      setMessage({ text: done, error: false });
      await load();
      return true;
    } catch (err) {
      if (err.status === 409) {
        closeEditors();
        setMessage({ text: CONFLICT_MESSAGE, error: true });
        await load();
        return false;
      }
      setMessage({ text: `Not saved: ${err.message}${err.note ? ` ${err.note}` : ""}`, error: true });
      // After any failure the list is read again, so the page shows what the server holds (a lost answer, a row just
      // created) and never acts on a row it only remembers.
      await load();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async (entry, body, extra) => {
    const ok = await run(() => (entry.row ? patchItem(entry.row, body) : createItem(entry.item, body, extra.kind)), "Saved. Check the item again and sign off.");
    if (ok) closeEditors();
  };
  const archive = (row) => run(async () => { await archiveItem(row); closeEditors(); }, "Archived");
  const signOff = (row) => run(() => signOffItem(row), "Signed off");
  const upload = (entry, file) => run(() => uploadFor(entry, file), "File saved. Check it and sign off.");

  // The tab opens inside the click, before the link is fetched: a tab opened after an await is a pop-up the browser blocks.
  const openFile = async (row) => {
    const tab = window.open("", "_blank");
    if (!tab) {
      setMessage({ text: "Your browser blocked the new tab. Allow pop-ups for this page and try again.", error: true });
      return;
    }
    tab.opener = null;
    try {
      const { url } = await fetchFileLink(row);
      tab.location.href = url;
    } catch (err) {
      tab.close();
      setMessage({ text: `Could not open the file: ${err.message}`, error: true });
    }
  };
  return { busy, message, save, archive, signOff, upload, openFile };
}

export default function BidKitPage() {
  const [params] = useSearchParams();
  const focusId = params.get("item") || "";
  const { data, loading, error, load } = useKit();
  const [view, setView] = useState("checklist");
  const [editing, setEditing] = useState("");
  const closeEditors = useCallback(() => setEditing(""), []);
  const actions = useKitActions(load, closeEditors);

  const checklist = useMemo(() => (data ? buildEntries(data.catalog, data.items) : []), [data]);
  useEffect(() => {
    if (!focusId || !data) return;
    const node = document.getElementById(`bid-kit-${focusId}`);
    if (node && node.scrollIntoView) node.scrollIntoView({ block: "center" });
  }, [focusId, data]);

  const handlers = {
    ...actions, setEditing, cancel: closeEditors,
    edit: (entry) => setEditing(entry.row ? entry.row.id : `new:${entry.item.key}`),
  };
  const sectionCounts = (data && data.summary.sections) || {};

  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1100px]">
      <AdminCommandHeader variant="workspace" title="Bid kit" icon={ClipboardCheck} />

      <div className="mb-3 rounded-sm border-hairline border-zinc-200 bg-white px-3 py-2 text-ui-body text-ink-secondary">
        The papers and facts every government bid asks for. Files are private and open only through a short link. Nothing here is public or sent to
        anyone. A sign-off covers the item as you saw it; any change clears it.
      </div>

      {error.off ? (
        <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Bid kit is not turned on yet.</div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="View">
            <Button size="sm" variant={view === "checklist" ? "primary" : "secondary"} aria-pressed={view === "checklist"} onClick={() => setView("checklist")}>Checklist</Button>
            <Button size="sm" variant={view === "facts" ? "primary" : "secondary"} aria-pressed={view === "facts"} onClick={() => setView("facts")}>Facts sheet</Button>
            {data && view === "checklist" && <SummaryLine overall={data.summary.overall} />}
          </div>

          {error.text && <ActionFeedback error onRetry={load} className="mb-3">{error.text}</ActionFeedback>}
          {actions.message.text && <ActionFeedback error={actions.message.error} className="mb-3">{actions.message.text}</ActionFeedback>}
          {loading && !data && <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Loading the kit…</div>}

          {view === "facts" && <FactsSheet />}

          {view === "checklist" && data && (
            <div className="grid gap-5">
              {checklist.map((section) => (
                <Section key={section.key} section={section} counts={sectionCounts[section.key]} editing={editing} busy={actions.busy} focusId={focusId} handlers={handlers} />
              ))}
              <div>
                <Button size="sm" variant="secondary" disabled={actions.busy} onClick={() => setEditing(editing === NEW_CUSTOM ? "" : NEW_CUSTOM)}>Add another item</Button>
                {editing === NEW_CUSTOM && (
                  <Editor
                    entry={CUSTOM_ENTRY} busy={actions.busy} onArchive={() => {}} onCancel={closeEditors}
                    onSave={(body, extra) => actions.save({ item: { key: "custom", kind: extra.kind, label: "" }, row: null }, body, extra)}
                  />
                )}
              </div>
            </div>
          )}
        </>
      )}
    </UiSurface>
  );
}
