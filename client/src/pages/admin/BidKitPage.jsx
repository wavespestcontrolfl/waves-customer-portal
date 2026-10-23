import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ActionFeedback, Badge, Button, Card, CardBody, Field, Input, Select, Textarea, UiSurface,
} from "../../components/ui";
import { adminFetch } from "../../lib/adminFetch";
import { formatETDateOnly } from "../../lib/timezone";
import { STATUS_LABEL, SIGN_OFF_REFUSAL, LIMIT_DOLLAR_KEYS, WORKERS_COMP_VALUES, PUBLIC_OR_PRIVATE, REFERENCE_DETAIL_KEYS } from "@bid-kit-catalog";

// Bid kit (GATE_BID_KIT, dark, admin only). The papers and facts every government bid asks for. Nothing here is public and
// nothing is sent to anyone. A status comes from the server; a sign-off belongs to the version of the item you looked at,
// and any edit to the item clears it. No AI anywhere.

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

const dateText = (value) => (value ? formatETDateOnly(value, { month: "short", day: "numeric", year: "numeric" }) : "");

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
      entries: customs.map((row) => ({ item: { key: "custom", kind: row.kind, label: row.label, expires: true, why: "" }, row, status: row.status })),
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
          <ul className="grid gap-2">
            {facts.map((fact, index) => (
              <li key={`${fact.key}-${index}`} className="flex flex-wrap items-center gap-2 text-ui-body">
                <span className="w-56 shrink-0 text-ink-secondary">{fact.label}</span>
                {fact.value ? (
                  <>
                    <span className="min-w-0 flex-1 break-words font-medium text-zinc-900">{fact.value}</span>
                    {!fact.signedOff && <Badge tone="warn">Not signed off</Badge>}
                    <CopyButton text={fact.value} label={fact.label} />
                  </>
                ) : <span className="text-ink-secondary">Not filled in</span>}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <h2 className="mb-2 text-ui-body font-medium text-zinc-900">Document numbers and expiry dates</h2>
          {documents.length === 0 && <div className="text-ui-body text-ink-secondary">No document numbers or dates saved yet.</div>}
          <ul className="grid gap-2">
            {documents.map((doc, index) => (
              <li key={`${doc.key}-${index}`} className="flex flex-wrap items-center gap-2 text-ui-body">
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
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}

// The editor for one entry: a new row (POST) or a saved one (PATCH, fenced on the version the page loaded).
function Editor({ entry, busy, onSave, onArchive, onCancel }) {
  const { item, row } = entry;
  const [label, setLabel] = useState(row?.label || (item.key === "custom" ? "" : item.label));
  const [kind, setKind] = useState(row?.kind || item.kind);
  const [value, setValue] = useState(row?.value || "");
  const [source, setSource] = useState(row?.source_document || "");
  const [checkedOn, setCheckedOn] = useState(row?.checked_on || "");
  const [expiresOn, setExpiresOn] = useState(row?.expires_on || "");
  const [permissionOn, setPermissionOn] = useState(row?.permission_on || "");
  const [limits, setLimits] = useState(() => Object.fromEntries([...LIMIT_DOLLAR_KEYS, "workersComp"].map((key) => [key, row?.limits?.[key] ?? ""])));
  const [details, setDetails] = useState(() => Object.fromEntries(REFERENCE_DETAIL_KEYS.map((key) => [key, row?.details?.[key] ?? ""])));
  const [problem, setProblem] = useState("");
  const isReference = kind === "reference";
  const showLimits = INSURANCE_KEYS.includes(item.key) || item.key === "custom";
  const showExpiry = item.expires || Boolean(row?.expires_on);

  const submit = (event) => {
    event.preventDefault();
    const body = { source_document: source, checked_on: checkedOn || null, value };
    if (item.key === "custom") body.label = label;
    if (showExpiry) body.expires_on = expiresOn || null;
    if (isReference) {
      body.permission_on = permissionOn || null;
      body.details = Object.fromEntries(Object.entries(details).filter(([, entry]) => entry !== ""));
    }
    if (showLimits) {
      const out = {};
      for (const key of LIMIT_DOLLAR_KEYS) {
        const text = String(limits[key]).replace(/[$,\s]/g, "");
        if (text === "") continue;
        if (!/^\d+$/.test(text)) { setProblem(`${LIMIT_LABEL[key]} must be a whole number of dollars`); return; }
        out[key] = Number(text);
      }
      if (limits.workersComp) out.workersComp = limits.workersComp;
      body.limits = Object.keys(out).length ? out : null;
    }
    setProblem("");
    onSave(body, { kind, label });
  };

  return (
    <form className="mt-3 grid gap-3 rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3" onSubmit={submit} aria-label={`Edit ${item.label}`}>
      {item.key === "custom" && (
        <div className="grid gap-3 md:grid-cols-2">
          <Field id="kit-label" label="Name"><Input value={label} maxLength={200} onChange={(event) => setLabel(event.target.value)} /></Field>
          {!row && (
            <Field id="kit-kind" label="Type">
              <Select value={kind} onChange={(event) => setKind(event.target.value)}>
                <option value="document">Document</option>
                <option value="fact">Fact</option>
              </Select>
            </Field>
          )}
        </div>
      )}
      <Field id="kit-value" label={item.kind === "fact" ? "Value" : "Number or note"} help={item.kind === "fact" ? undefined : "A policy or license number, if the paper has one. Never type a tax ID or Social Security number here."}>
        {item.kind === "fact" ? <Textarea rows={2} maxLength={2000} value={value} onChange={(event) => setValue(event.target.value)} /> : <Input value={value} maxLength={2000} onChange={(event) => setValue(event.target.value)} />}
      </Field>
      <div className="grid gap-3 md:grid-cols-3">
        <Field id="kit-source" label="Source document" help="Where this came from."><Input value={source} maxLength={500} onChange={(event) => setSource(event.target.value)} /></Field>
        <Field id="kit-checked" label="Checked on"><Input type="date" value={checkedOn} onChange={(event) => setCheckedOn(event.target.value)} /></Field>
        {showExpiry && <Field id="kit-expires" label="Expires on"><Input type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} /></Field>}
        {isReference && <Field id="kit-permission" label="Permission given on" help="The day this person agreed to be named."><Input type="date" value={permissionOn} onChange={(event) => setPermissionOn(event.target.value)} /></Field>}
      </div>
      {showLimits && (
        <fieldset className="grid gap-3 md:grid-cols-3">
          <legend className="mb-1 text-ui-body font-medium text-zinc-900">Limits (whole dollars)</legend>
          {LIMIT_DOLLAR_KEYS.map((key) => (
            <Field key={key} id={`kit-limit-${key}`} label={LIMIT_LABEL[key]}>
              <Input inputMode="numeric" value={limits[key]} onChange={(event) => setLimits((s) => ({ ...s, [key]: event.target.value }))} />
            </Field>
          ))}
          <Field id="kit-limit-workersComp" label="Workers’ compensation">
            <Select value={limits.workersComp} onChange={(event) => setLimits((s) => ({ ...s, workersComp: event.target.value }))}>
              <option value="">Not set</option>
              {WORKERS_COMP_VALUES.map((entry) => <option key={entry} value={entry}>{entry === "statutory" ? "Statutory" : "Exempt"}</option>)}
            </Select>
          </Field>
        </fieldset>
      )}
      {isReference && (
        <fieldset className="grid gap-3 md:grid-cols-2">
          <legend className="mb-1 text-ui-body font-medium text-zinc-900">Reference details</legend>
          {REFERENCE_DETAIL_KEYS.map((key) => (
            <Field key={key} id={`kit-detail-${key}`} label={DETAIL_LABEL[key]}>
              {key === "publicOrPrivate" ? (
                <Select value={details[key]} onChange={(event) => setDetails((s) => ({ ...s, [key]: event.target.value }))}>
                  <option value="">Not set</option>
                  {PUBLIC_OR_PRIVATE.map((entry) => <option key={entry} value={entry}>{entry === "public" ? "Public" : "Private"}</option>)}
                </Select>
              ) : <Input value={details[key]} onChange={(event) => setDetails((s) => ({ ...s, [key]: event.target.value }))} />}
            </Field>
          ))}
        </fieldset>
      )}
      <p className="text-ui-caption text-ink-secondary">Saving a change to the value, dates, limits, details or source clears the sign-off.</p>
      {problem && <ActionFeedback error>{problem}</ActionFeedback>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || (item.key === "custom" && !label.trim())}>Save</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        {row && <Button type="button" variant="ghost" disabled={busy} onClick={onArchive}>Archive</Button>}
      </div>
    </form>
  );
}

function RowDetails({ row, item }) {
  return (
    <div className="mt-1 grid gap-0.5 text-ui-body">
      {row.value && <div><span className="text-ink-secondary">{item.kind === "fact" ? "Value: " : "Number: "}</span>{row.value}</div>}
      {row.file && <div><span className="text-ink-secondary">File: </span>{row.file.name}</div>}
      {row.expires_on && <div><span className="text-ink-secondary">Expires: </span>{dateText(row.expires_on)}</div>}
      {item.expires && !row.expires_on && <div className="text-warn-fg">No expiry date saved. Add one so the kit can warn you.</div>}
      {(row.source_document || row.checked_on) && (
        <div>
          <span className="text-ink-secondary">Source: </span>{row.source_document || "not recorded"}
          {row.checked_on && <span className="text-ink-secondary"> · checked {dateText(row.checked_on)}</span>}
        </div>
      )}
      {row.kind === "reference" && row.details?.entity && <div><span className="text-ink-secondary">Reference: </span>{[row.details.entity, row.details.contactRole].filter(Boolean).join(", ")}</div>}
      {row.kind === "reference" && row.permission_on && <div><span className="text-ink-secondary">Permission given: </span>{dateText(row.permission_on)}</div>}
      {row.limits && (
        <div>
          <span className="text-ink-secondary">Limits: </span>
          {Object.entries(row.limits).map(([key, amount]) => `${LIMIT_LABEL[key] || (key === "workersComp" ? "Workers’ comp" : key)} ${typeof amount === "number" ? `$${amount.toLocaleString("en-US")}` : amount}`).join("; ")}
        </div>
      )}
      {row.attested_at && <div className="text-ink-secondary">Signed off {dateText(row.attested_at)}</div>}
    </div>
  );
}

function Row({ entry, busy, editing, highlighted, onEdit, onCancel, onSave, onArchive, onSignOff, onOpenFile, onUpload }) {
  const { item, row, status } = entry;
  const fileInput = useRef(null);
  const refused = SIGN_OFF_REFUSAL[status];
  const canSign = !!row && !row.attested_at && !refused;
  const signReason = !row ? "" : row.attested_at ? "Signed off" : refused || "";
  return (
    <li id={row ? `bid-kit-${row.id}` : undefined} className={`rounded-sm border-hairline px-3 py-3 ${highlighted ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 bg-white"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-words text-ui-body font-medium text-zinc-900">{row?.label || item.label}</h3>
            <StatusChip status={status} />
            {item.perBid && <Badge>New one for each bid</Badge>}
            {item.notarized && <Badge>Notarized</Badge>}
          </div>
          {!row && item.why && <div className="text-ui-caption text-ink-secondary">{item.why}</div>}
          {item.renewalRule && <div className="text-ui-caption text-ink-secondary">{item.renewalRule}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          {item.kind !== "fact" && (
            <>
              {row?.file && <Button size="sm" variant="secondary" disabled={busy} onClick={() => onOpenFile(row)}>Open file</Button>}
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>{row?.file ? "Replace file" : "Upload file"}</Button>
              <input
                ref={fileInput} type="file" accept={ACCEPT} hidden aria-label={`File for ${row?.label || item.label}`}
                onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) onUpload(entry, file); }}
              />
            </>
          )}
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onEdit(entry)}>{row ? "Edit" : "Add details"}</Button>
          {row && <Button size="sm" disabled={busy || !canSign} title={signReason} onClick={() => onSignOff(row)}>Sign off</Button>}
        </div>
      </div>
      {row && <RowDetails row={row} item={item} />}
      {editing && <Editor entry={entry} busy={busy} onSave={(body, extra) => onSave(entry, body, extra)} onArchive={() => onArchive(row)} onCancel={onCancel} />}
    </li>
  );
}

export default function BidKitPage() {
  const [params] = useSearchParams();
  const focusId = params.get("item") || "";
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState({ text: "", off: false });
  const [view, setView] = useState("checklist");
  const [editing, setEditing] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState({ text: "", error: false });
  const [adding, setAdding] = useState(false);

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

  const checklist = useMemo(() => (data ? buildEntries(data.catalog, data.items) : []), [data]);
  useEffect(() => {
    if (!focusId || !data) return;
    document.getElementById(`bid-kit-${focusId}`)?.scrollIntoView?.({ block: "center" });
  }, [focusId, data]);

  // One mutation: busy while it runs, the message says what happened, and the list is read again so statuses and the
  // summary always come from the server.
  const run = async (action, done) => {
    setBusy(true);
    setMessage({ text: "", error: false });
    try {
      await action();
      setMessage({ text: done, error: false });
      await load();
      return true;
    } catch (err) {
      setMessage({ text: err.status === 409 ? err.message : `Not saved: ${err.message}`, error: true });
      if (err.status === 409) await load();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async (entry, body, extra) => {
    const { row, item } = entry;
    const ok = await run(async () => {
      if (row) await api(`/${row.id}`, { method: "PATCH", body: { ...body, expected_updated_at: row.updated_at } });
      else {
        const create = { kind: extra.kind || item.kind, item_key: item.key, ...body };
        if (item.key !== "custom") delete create.label;
        await api("/", { method: "POST", body: create });
      }
    }, "Saved. Check the item again and sign off.");
    if (ok) { setEditing(""); setAdding(false); }
  };
  const archive = (row) => run(async () => { await api(`/${row.id}`, { method: "DELETE" }); setEditing(""); }, "Archived");
  const signOff = (row) => run(() => api(`/${row.id}/attest`, { method: "POST", body: { expected_updated_at: row.updated_at } }), "Signed off");
  const openFile = async (row) => {
    try {
      const { url } = await api(`/${row.id}/file`);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setMessage({ text: `Could not open the file: ${err.message}`, error: true });
    }
  };
  const upload = (entry, file) => run(async () => {
    let id = entry.row?.id;
    // An item with no row yet gets a blank row first, so the file has a place to live.
    if (!id) {
      const created = await api("/", { method: "POST", body: { kind: entry.item.kind, item_key: entry.item.key } });
      id = created.item.id;
    }
    const form = new FormData();
    form.append("file", file);
    await api(`/${id}/file`, { method: "POST", body: form });
  }, "File saved. Check it and sign off.");

  const overall = data?.summary?.overall;
  const sectionCounts = data?.summary?.sections || {};

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
            {overall && view === "checklist" && (
              <span className="ml-2 text-ui-body font-medium text-zinc-900" data-testid="bid-kit-summary">
                {overall.ready} of {overall.total} ready{overall.expiring > 0 && ` · ${overall.expiring} expiring soon`}
                {(overall.expired > 0 || overall.missing > 0 || overall.needs_expiry > 0) && (
                  <span className="font-normal text-ink-secondary"> · {[overall.missing && `${overall.missing} missing`, overall.expired && `${overall.expired} expired`, overall.needs_expiry && `${overall.needs_expiry} need an expiry date`].filter(Boolean).join(", ")}</span>
                )}
              </span>
            )}
          </div>

          {error.text && <ActionFeedback error onRetry={load} className="mb-3">{error.text}</ActionFeedback>}
          {message.text && <ActionFeedback error={message.error} className="mb-3">{message.text}</ActionFeedback>}
          {loading && !data && <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Loading the kit…</div>}

          {view === "facts" && <FactsSheet />}

          {view === "checklist" && data && (
            <div className="grid gap-5">
              {checklist.map((section) => (
                <section key={section.key} aria-labelledby={`bid-kit-section-${section.key}`}>
                  <h2 id={`bid-kit-section-${section.key}`} className="mb-2 text-ui-body font-medium text-zinc-900">
                    {section.label}
                    {sectionCounts[section.key] && <span className="ml-2 font-normal text-ink-secondary">{sectionCounts[section.key].ready} of {sectionCounts[section.key].total} ready</span>}
                  </h2>
                  <ul className="grid gap-2">
                    {section.entries.map((entry) => {
                      const id = entry.row ? entry.row.id : `new:${entry.item.key}`;
                      return (
                        <Row
                          key={id} entry={entry} busy={busy} editing={editing === id} highlighted={!!entry.row && entry.row.id === focusId}
                          onEdit={() => setEditing(id)} onCancel={() => setEditing("")} onSave={save} onArchive={archive}
                          onSignOff={signOff} onOpenFile={openFile} onUpload={upload}
                        />
                      );
                    })}
                  </ul>
                  {section.key === "references" && (
                    <>
                      <Button size="sm" variant="secondary" className="mt-2" disabled={busy} onClick={() => setEditing("new:reference")}>Add a reference</Button>
                      {editing === "new:reference" && section.entries.some((entry) => entry.row) && (
                        <Editor entry={section.entries[0].row ? { ...section.entries[0], row: null } : section.entries[0]} busy={busy} onSave={(body, extra) => save({ item: section.entries[0].item, row: null }, body, extra)} onArchive={() => {}} onCancel={() => setEditing("")} />
                      )}
                    </>
                  )}
                </section>
              ))}
              <div>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => setAdding((v) => !v)}>Add another item</Button>
                {adding && (
                  <Editor
                    entry={{ item: { key: "custom", kind: "document", label: "", expires: true, why: "" }, row: null, status: "missing" }}
                    busy={busy} onSave={(body, extra) => save({ item: { key: "custom", kind: extra.kind, label: "" }, row: null }, body, extra)}
                    onArchive={() => {}} onCancel={() => setAdding(false)}
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
