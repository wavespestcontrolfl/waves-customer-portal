import { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ActionFeedback, Badge, Button, Card, CardBody, Field, Input, Select, Textarea, UiSurface,
} from "../../components/ui";
import { adminFetch as rawAdminFetch } from "../../lib/adminFetch";

const PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 250;

const ACCESS_TYPES = [
  { value: "keypad", label: "Keypad code" },
  { value: "callbox", label: "Call box" },
  { value: "guard", label: "Guard" },
  { value: "pass", label: "Pass / app" },
  { value: "open", label: "Open" },
  { value: "instructions", label: "Instructions" },
];
const TYPE_LABEL = Object.fromEntries(ACCESS_TYPES.map((t) => [t.value, t.label]));
const STATUS_LABEL = { active: "Active", needs_confirm: "Needs confirm", retired: "Retired" };

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function api(path, options = {}) {
  const res = await rawAdminFetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error || `HTTP ${res.status}`, res.status, body);
  return body;
}

function fmtDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
}

const BLANK_FORM = { gateLabel: "Main gate", accessType: "keypad", code: "", instructions: "" };

function formFromEntry(entry) {
  return {
    gateLabel: entry.gateLabel || "Main gate",
    accessType: entry.accessType,
    code: entry.code || "",
    instructions: entry.instructions || "",
  };
}

// The request body for an add or an edit. A code travels only with a keypad
// entry; every other type is instructions only (passes are never stored).
function bodyFromForm(form) {
  const body = { gate_label: form.gateLabel, access_type: form.accessType };
  if (form.accessType === "keypad") body.code = form.code;
  else body.instructions = form.instructions;
  return body;
}

function EntryForm({ initial, submitLabel, busy, error, onSubmit, onCancel, idPrefix }) {
  const [form, setForm] = useState(initial);
  const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }));
  const keypad = form.accessType === "keypad";
  return (
    <form
      className="grid gap-3 rounded-sm border-hairline border-zinc-200 bg-zinc-50 px-3 py-3"
      onSubmit={(event) => { event.preventDefault(); onSubmit(bodyFromForm(form)); }}
    >
      <div className="grid gap-3 md:grid-cols-3">
        <Field id={`${idPrefix}-label`} label="Gate label">
          <Input value={form.gateLabel} onChange={set("gateLabel")} maxLength={60} />
        </Field>
        <Field id={`${idPrefix}-type`} label="Access type">
          <Select value={form.accessType} onChange={set("accessType")}>
            {ACCESS_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
        </Field>
        {keypad ? (
          <Field id={`${idPrefix}-code`} label="Code" help="3 to 8 digits, # or * allowed at either end">
            <Input value={form.code} onChange={set("code")} maxLength={100} autoComplete="off" inputMode="text" />
          </Field>
        ) : null}
      </div>
      {!keypad && (
        <Field id={`${idPrefix}-instructions`} label="Instructions" help="How to get in. Never store a pass or QR code itself, only how to get one.">
          <Textarea rows={3} value={form.instructions} onChange={set("instructions")} maxLength={1000} />
        </Field>
      )}
      {error && <ActionFeedback error>{error}</ActionFeedback>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={busy}>{submitLabel}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function EntryRow({ entry, busyKey, editing, formError, onAction, onEdit, onCancelEdit, onSaveEdit }) {
  const busy = busyKey.startsWith(`${entry.id}:`);
  const retired = entry.status === "retired";
  const unconfirmed = !retired && (!entry.lastConfirmedAt || entry.status === "needs_confirm");
  if (editing) {
    return (
      <EntryForm
        idPrefix={`edit-${entry.id}`}
        initial={formFromEntry(entry)}
        submitLabel="Save changes"
        busy={busy}
        error={formError}
        onSubmit={(body) => onSaveEdit(entry, body)}
        onCancel={onCancelEdit}
      />
    );
  }
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-sm border-hairline border-zinc-200 px-3 py-2">
      <div className="min-w-0 basis-full flex-1 md:basis-auto">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui-body font-medium text-zinc-900">{entry.gateLabel}</span>
          <span className="text-ui-body text-ink-secondary">{TYPE_LABEL[entry.accessType] || entry.accessType}</span>
          <Badge tone={!retired && entry.status === "active" ? "strong" : "neutral"}>
            {STATUS_LABEL[entry.status] || entry.status}
          </Badge>
          {entry.conflict && <Badge tone="alert">Conflicting codes</Badge>}
          {unconfirmed && <Badge tone="neutral">Unconfirmed</Badge>}
          {entry.stale && <Badge tone="neutral">Stale</Badge>}
        </div>
        {entry.code && (
          <div className="mt-1 u-nums break-all text-ui-body font-medium text-zinc-900">{entry.code}</div>
        )}
        {entry.instructions && (
          <div className="mt-1 break-words whitespace-pre-line text-ui-body text-zinc-900">{entry.instructions}</div>
        )}
        <div className="mt-1 text-ui-body text-ink-secondary">
          {entry.lastConfirmedAt ? `Last confirmed ${fmtDate(entry.lastConfirmedAt)}` : "Never confirmed"}
        </div>
      </div>
      {!retired && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction(entry, "confirm")}>Confirm</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onEdit(entry)}>Edit</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction(entry, "retire")}>Retire</Button>
        </div>
      )}
    </div>
  );
}

export default function NeighborhoodGateCodesPage() {
  const [neighborhoods, setNeighborhoods] = useState([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState("");
  const [disabled, setDisabled] = useState(false);
  const [toast, setToast] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [editingId, setEditingId] = useState("");
  const [addingTo, setAddingTo] = useState("");
  const [formError, setFormError] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const readSeq = useRef(0);
  const load = useCallback(async ({ offset = 0 } = {}) => {
    const seq = ++readSeq.current;
    setLoading(true);
    setReadError("");
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (query) params.set("q", query);
      if (filter === "needs_confirm") params.set("filter", "needs_confirm");
      const data = await api(`/admin/neighborhood-access?${params.toString()}`);
      if (seq !== readSeq.current) return;
      setDisabled(false);
      setNeighborhoods((prev) => (offset ? [...prev, ...(data.neighborhoods || [])] : data.neighborhoods || []));
      setTotal(data.total || 0);
    } catch (err) {
      if (seq !== readSeq.current) return;
      if (err.status === 404 && err.body?.enabled === false) setDisabled(true);
      else setReadError(err.message || "Could not load gate codes");
    } finally {
      if (seq === readSeq.current) setLoading(false);
    }
  }, [query, filter]);

  useEffect(() => { load(); }, [load]);

  const closeForms = () => { setEditingId(""); setAddingTo(""); setFormError(""); };

  const mutate = async ({ key, path, method, body, successText, onError }) => {
    setBusyKey(key);
    setActionError("");
    setToast("");
    try {
      await api(path, { method, body: JSON.stringify(body) });
      closeForms();
      await load();
      setToast(successText);
    } catch (err) {
      if (onError) onError(err.message || "Action failed");
      else setActionError(err.message || "Action failed");
    } finally {
      setBusyKey("");
    }
  };

  const onAction = (entry, action) => {
    if (action === "retire" && !window.confirm("Retire this gate entry? It stops showing to staff; it is kept for history.")) return;
    mutate({
      key: `${entry.id}:${action}`,
      path: `/admin/neighborhood-access/entries/${entry.id}`,
      method: "PATCH",
      body: { action },
      successText: action === "confirm" ? "Confirmed" : "Retired",
    });
  };
  const onSaveEdit = (entry, body) => mutate({
    key: `${entry.id}:edit`,
    path: `/admin/neighborhood-access/entries/${entry.id}`,
    method: "PATCH",
    body,
    successText: "Saved",
    onError: setFormError,
  });
  const onAdd = (neighborhood, body) => mutate({
    key: `${neighborhood.id}:add`,
    path: `/admin/neighborhood-access/${neighborhood.id}/entries`,
    method: "POST",
    body,
    successText: "Entry added",
    onError: setFormError,
  });

  const showEmpty = !loading && !readError && !disabled && neighborhoods.length === 0;

  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1300px]">
      <AdminCommandHeader variant="workspace" title="Neighborhood gate codes" icon={KeyRound} />

      <div className="mb-3 rounded-sm border-hairline border-zinc-200 bg-white px-3 py-2 text-ui-body text-ink-secondary">
        One gate code per neighborhood, shared by every stop in it. Staff only: customers never see
        these. Confirm a code after you have seen it work; an entry nobody has confirmed in 6 months
        shows as Stale.
      </div>

      {disabled ? (
        <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Gate codes are not turned on yet.</div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <div className="min-w-0 basis-full md:basis-80">
              <Field id="gate-code-search" label="Search neighborhoods">
                <Input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Neighborhood or subdivision"
                />
              </Field>
            </div>
            <div className="flex items-center gap-2" role="group" aria-label="Filter">
              <Button
                size="sm"
                variant={filter === "all" ? "primary" : "secondary"}
                aria-pressed={filter === "all"}
                onClick={() => setFilter("all")}
              >
                All
              </Button>
              <Button
                size="sm"
                variant={filter === "needs_confirm" ? "primary" : "secondary"}
                aria-pressed={filter === "needs_confirm"}
                onClick={() => setFilter("needs_confirm")}
              >
                Needs confirm
              </Button>
            </div>
          </div>

          {readError && <ActionFeedback error onRetry={() => load()} className="mb-3">{readError}</ActionFeedback>}
          {actionError && <ActionFeedback error className="mb-3">{actionError}</ActionFeedback>}
          {toast && <ActionFeedback className="mb-3">{toast}</ActionFeedback>}

          {loading && !neighborhoods.length && (
            <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Loading gate codes…</div>
          )}
          {showEmpty && (
            <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">
              {filter === "needs_confirm" ? "Nothing needs confirming." : "No neighborhoods match."}
            </div>
          )}

          <div className="grid gap-3">
            {neighborhoods.map((n) => (
              <Card key={n.id}>
                <CardBody>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="break-words text-ui-body font-medium text-zinc-900">{n.name}</span>
                      <span className="ml-2 text-ui-body text-ink-secondary">
                        {[n.county, `${n.propertyCount} ${n.propertyCount === 1 ? "property" : "properties"}`].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                    {addingTo !== n.id && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => { closeForms(); setAddingTo(n.id); }}
                      >
                        Add entry
                      </Button>
                    )}
                  </div>
                  <div className="grid gap-2">
                    {n.entries.length === 0 && addingTo !== n.id && (
                      <div className="text-ui-body text-ink-secondary">No gate entry on file yet.</div>
                    )}
                    {n.entries.map((entry) => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        busyKey={busyKey}
                        editing={editingId === entry.id}
                        formError={editingId === entry.id ? formError : ""}
                        onAction={onAction}
                        onEdit={(e) => { closeForms(); setEditingId(e.id); }}
                        onCancelEdit={closeForms}
                        onSaveEdit={onSaveEdit}
                      />
                    ))}
                    {addingTo === n.id && (
                      <EntryForm
                        idPrefix={`add-${n.id}`}
                        initial={BLANK_FORM}
                        submitLabel="Save entry"
                        busy={busyKey === `${n.id}:add`}
                        error={formError}
                        onSubmit={(body) => onAdd(n, body)}
                        onCancel={closeForms}
                      />
                    )}
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>

          {neighborhoods.length > 0 && neighborhoods.length < total && (
            <div className="mt-3 text-center">
              <Button variant="secondary" disabled={loading} onClick={() => load({ offset: neighborhoods.length })}>
                Show more ({total - neighborhoods.length} left)
              </Button>
            </div>
          )}
        </>
      )}
    </UiSurface>
  );
}
