import { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ActionFeedback, Badge, Button, Card, CardBody, Checkbox, Field, Input, Select, Textarea, UiSurface,
} from "../../components/ui";
import { adminFetch as rawAdminFetch } from "../../lib/adminFetch";
import { FoundCodeCard } from "../../components/admin/AccessCodePanels";

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

const BLANK_FORM = { gateLabel: "Main gate", accessType: "keypad", code: "", instructions: "", gateLocation: "", unconfirmed: false };

// "27.4321, -82.4567": the stored pin as the office typed it, and as it reads
// back in the form.
const locationText = (point) => (point ? `${point.lat}, ${point.lng}` : "");
// Where the pin opens on a map, for the office to check it is the main gate.
const locationMapHref = (point) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${point.lat},${point.lng}`)}`;

function formFromEntry(entry) {
  return {
    gateLabel: entry.gateLabel || "Main gate",
    accessType: entry.accessType,
    code: entry.code || "",
    instructions: entry.instructions || "",
    gateLocation: locationText(entry.gateLocation),
  };
}

// The request body for an add or an edit. A code travels only with a keypad
// entry; every other type is instructions only (passes are never stored). The
// gate's map point always travels (null clears it), so the office can take a
// pin off as easily as it set one.
function bodyFromForm(form) {
  const body = { gate_label: form.gateLabel, access_type: form.accessType, gate_location: form.gateLocation.trim() || null };
  if (form.accessType === "keypad") body.code = form.code;
  else body.instructions = form.instructions;
  // An old code the office has not seen work files as Needs confirm (owner 2026-10-26).
  if (form.unconfirmed) body.unconfirmed = true;
  return body;
}

function EntryForm({ initial, submitLabel, busy, error, onSubmit, onCancel, idPrefix, showUnconfirmed = false }) {
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
      <Field
        id={`${idPrefix}-location`}
        label="Gate location"
        help="Where this gate is on the map: paste a Google Maps link to it, or type lat, lng. Directions for every visit in the neighborhood then route through this gate first. Leave blank for none."
      >
        <Input value={form.gateLocation} onChange={set("gateLocation")} maxLength={2048} autoComplete="off" placeholder="27.4321, -82.4567 or a Google Maps link" />
      </Field>
      {showUnconfirmed && (
        <Checkbox
          id={`${idPrefix}-unconfirmed`}
          label="I have not seen this work (file it as Needs confirm)"
          checked={form.unconfirmed === true}
          onChange={(event) => setForm((f) => ({ ...f, unconfirmed: event.target.checked }))}
        />
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
  // Any save in flight locks every row's actions, so a finishing save can
  // never close (or put its error under) a form opened meanwhile.
  const busy = busyKey !== "";
  const retired = entry.status === "retired";
  // The badge means the entry is waiting on the office (status needs_confirm),
  // the same rule as the Needs confirm filter. A live code nobody has
  // confirmed yet only reads "Never confirmed" below, and turns Stale after
  // 6 months from when it was filed (owner ruling D2).
  const unconfirmed = !retired && entry.status === "needs_confirm";
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
        {entry.gateLocation && (
          <div className="mt-1 text-ui-body text-ink-secondary">
            Directions route through this gate
            {" · "}
            <a className="u-nums text-zinc-900 underline" href={locationMapHref(entry.gateLocation)} target="_blank" rel="noopener noreferrer">
              {locationText(entry.gateLocation)}
            </a>
          </div>
        )}
        <div className="mt-1 text-ui-body text-ink-secondary">
          {entry.lastConfirmedAt ? `Last confirmed ${fmtDate(entry.lastConfirmedAt)}` : "Never confirmed"}
          {entry.addedBy ? ` · Added on a visit by ${entry.addedBy}` : ""}
        </div>
        {entry.markedWrongAt && (
          <div className="mt-1 text-ui-body text-ink-secondary">
            Reported wrong on a visit by {entry.markedWrongBy}, {fmtDate(entry.markedWrongAt)}
          </div>
        )}
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

// Codes found in customers' texts, waiting for a one-tap office save. The
// owner (the page) reads the first page to learn whether the section is on.
const FOUND_PAGE_SIZE = 50;

function FoundInMessages({ items, total, loading, error, onRetry, onMore, onSave, onDismiss, onLink, onSearch }) {
  return (
    <div>
      <div className="mb-3 rounded-sm border-hairline border-zinc-200 bg-white px-3 py-2 text-ui-body text-ink-secondary">
        Access codes sent in a text, from a customer or not. Save one to make it usable on the customer&apos;s page,
        or dismiss it. A code from a number with no customer needs a customer first. Nothing here is saved until you decide.
      </div>
      {error && <ActionFeedback error onRetry={onRetry} className="mb-3">{error}</ActionFeedback>}
      {loading && !items.length && (
        <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Loading codes…</div>
      )}
      {!loading && !error && items.length === 0 && (
        <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">No codes are waiting.</div>
      )}
      <div className="grid gap-3">
        {items.map((row) => (
          <FoundCodeCard
            key={`${row.id}:${row.updatedAt || ""}`}
            row={row}
            visits={row.visitChoices || []}
            onSave={onSave}
            onDismiss={onDismiss}
            onLink={onLink}
            onSearch={onSearch}
            renderHeading={(r) => (
              r.customerId
                ? <Link className="underline underline-offset-2 hover:no-underline u-focus-ring" to={`/admin/customers?customerId=${encodeURIComponent(r.customerId)}`}>{r.customerName || "Customer"}</Link>
                : (r.customerName || "No customer yet")
            )}
          />
        ))}
      </div>
      {items.length > 0 && items.length < total && (
        <div className="mt-3 text-center">
          <Button variant="secondary" disabled={loading} onClick={onMore}>Show more ({total - items.length} left)</Button>
        </div>
      )}
    </div>
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What a merge moves, from its dry run, in the words the office reads.
function mergeSummary(source, target, preview) {
  const parts = [`Moves ${plural(preview.homes, "home", "homes")} and ${plural(preview.entries, "gate entry", "gate entries")} into ${target.name}.`];
  if (preview.duplicatesRetired) {
    parts.push(`${plural(preview.duplicatesRetired, "code", "codes")} on file in both ${preview.duplicatesRetired === 1 ? "is" : "are"} kept once.`);
  }
  parts.push(`"${source.name}" becomes another name for it. Undo merge puts it back.`);
  return parts.join(" ");
}

// Merge one neighborhood into another of its county (GATE_NEIGHBORHOOD_MERGE,
// owner 2026-10-25): find the entry it joins, read what moves (a dry run that
// writes nothing), then merge.
function MergeIntoPanel({ neighborhood, initialTarget = null, busy, error, onSearch, onPreview, onMerge, onCancel }) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [searched, setSearched] = useState(false);
  const [picked, setPicked] = useState(null);
  const [preview, setPreview] = useState(null);
  const [localError, setLocalError] = useState("");
  const searchSeq = useRef(0);
  const pickSeq = useRef(0);

  useEffect(() => {
    const q = search.trim();
    const seq = ++searchSeq.current;
    // A new query never shows the previous query's choices.
    setResults([]);
    setSearched(false);
    if (!q) return undefined;
    const timer = setTimeout(async () => {
      try {
        const found = await onSearch(q);
        if (seq !== searchSeq.current) return;
        setResults(found.filter((n) => n.id !== neighborhood.id && (n.county || null) === (neighborhood.county || null)));
        setSearched(true);
        setLocalError("");
      } catch (err) {
        if (seq !== searchSeq.current) return;
        setLocalError(err.message || "Could not search neighborhoods");
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, neighborhood.id, neighborhood.county, onSearch]);

  const pick = useCallback(async (target) => {
    const seq = ++pickSeq.current;
    setPicked(target);
    setPreview(null);
    setLocalError("");
    try {
      const counts = await onPreview(target.id);
      if (seq === pickSeq.current) setPreview(counts);
    } catch (err) {
      if (seq !== pickSeq.current) return;
      setPicked(null);
      setLocalError(err.message || "Could not check this merge");
    }
  }, [onPreview]);
  // A suggested merge opens on its pair: the dry run starts at once.
  const started = useRef(false);
  useEffect(() => {
    if (!initialTarget || started.current) return;
    started.current = true;
    pick(initialTarget);
  }, [initialTarget, pick]);
  const unpick = () => { pickSeq.current += 1; setPicked(null); setPreview(null); };

  return (
    <div className="grid gap-2 rounded-sm border-hairline border-zinc-200 bg-zinc-50 px-3 py-3">
      {picked ? (
        <div className="text-ui-body text-zinc-900">
          {preview ? mergeSummary(neighborhood, picked, preview) : <span className="text-ink-secondary">Checking what moves…</span>}
        </div>
      ) : (
        <>
          <Field id={`merge-${neighborhood.id}-search`} label="Merge into">
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`A neighborhood in ${neighborhood.county || "the same county"}`}
              autoComplete="off"
              disabled={busy}
            />
          </Field>
          {results.length > 0 && (
            <div className="grid gap-1">
              {results.map((n) => (
                <Button key={n.id} size="sm" variant="secondary" className="justify-start" disabled={busy} onClick={() => pick(n)}>
                  {`${n.name} · ${plural(n.propertyCount || 0, "property", "properties")}`}
                </Button>
              ))}
            </div>
          )}
          {searched && results.length === 0 && (
            <div className="text-ui-body text-ink-secondary">No other neighborhood in this county matches.</div>
          )}
        </>
      )}
      {(localError || error) && <ActionFeedback error>{localError || error}</ActionFeedback>}
      <div className="flex flex-wrap gap-2">
        {picked && <Button size="sm" disabled={busy || !preview} onClick={() => onMerge(picked)}>Merge</Button>}
        {picked && <Button size="sm" variant="ghost" disabled={busy} onClick={unpick}>Pick another</Button>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

const SUGGESTIONS_SHOWN = 5;

// Entries whose names read as one community (server rules: a phase, a
// spelling, "X at Y"). The office merges one or marks it Not the same; a
// person always decides (owner ruling 2026-10-25).
// Empty while the merge switch is off (the page clears the list); hidden on a
// linked single-neighborhood view.
function SuggestedMerges({ items, hidden, reviewing, disabled, onReview, onDismiss, renderPanel }) {
  const [all, setAll] = useState(false);
  if (hidden || !items.length) return null;
  const shown = all ? items : items.slice(0, SUGGESTIONS_SHOWN);
  const side = (n) => `${n.name} · ${plural(n.propertyCount || 0, "property", "properties")}`;
  return (
    <div className="mb-3 grid gap-2 rounded-sm border-hairline border-zinc-200 bg-white px-3 py-3">
      <div className="text-ui-body font-medium text-zinc-900">{`Possible duplicates (${items.length})`}</div>
      <div className="text-ui-body text-ink-secondary">
        These names read as one community. Merge when they share a gate; otherwise mark them Not the same.
      </div>
      {shown.map((s) => {
        const key = `${s.source.id}|${s.target.id}`;
        return (
          <div key={key} className="grid gap-2 rounded-sm border-hairline border-zinc-200 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 break-words text-ui-body text-zinc-900">{`${side(s.source)} → ${side(s.target)}`}</span>
              {reviewing !== key && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onReview(key)}>Review merge</Button>
                  <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onDismiss(s)}>Not the same</Button>
                </div>
              )}
            </div>
            {reviewing === key && renderPanel(s)}
          </div>
        );
      })}
      {items.length > SUGGESTIONS_SHOWN && (
        <div>
          <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all (${items.length})`}</Button>
        </div>
      )}
    </div>
  );
}

// Why a home is on the Homes not placed list, in the office's words.
function unplacedReason(h) {
  const parts = [];
  if (h.countyLot) {
    const named = h.countyLot.community ? `the county puts it in ${h.countyLot.community}` : "the county gives no community";
    parts.push(`ZIP ${h.zip || "blank"} here, ${h.countyLot.zip} on the county's lot; ${named}.`);
  }
  if (h.savedCode) parts.push("Its saved gate code reaches only this customer's stops.");
  return parts.join(" ");
}

// Homes the directory cannot place (owner ruling 2026-10-26): no neighborhood,
// so no shared gate code reaches them. A person links each one; nothing links
// by itself. Empty while the switch is off (the page clears the list).
function UnplacedHomes({ items, hidden, disabled, onLink }) {
  const [all, setAll] = useState(false);
  if (hidden || !items.length) return null;
  const shown = all ? items : items.slice(0, SUGGESTIONS_SHOWN);
  return (
    <div className="mb-3 grid gap-2 rounded-sm border-hairline border-zinc-200 bg-white px-3 py-3">
      <div className="text-ui-body font-medium text-zinc-900">{`Homes not placed (${items.length})`}</div>
      <div className="text-ui-body text-ink-secondary">
        These homes have no neighborhood, so no shared gate code reaches them. Check the county's community, then link the home.
      </div>
      {shown.map((h) => (
        <div key={h.propertyId} className="grid gap-1 rounded-sm border-hairline border-zinc-200 px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 break-words text-ui-body text-zinc-900">
              <Link className="underline underline-offset-2 hover:no-underline u-focus-ring" to={`/admin/customers?customerId=${encodeURIComponent(h.customerId)}`}>
                {h.customerName || "Customer"}
              </Link>
              {h.address ? ` · ${h.address}` : ""}
            </span>
            {h.countyLot?.community && (
              <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onLink(h)}>{`Link to ${h.countyLot.community}`}</Button>
            )}
          </div>
          <div className="text-ui-body text-ink-secondary">{unplacedReason(h)}</div>
        </div>
      ))}
      {items.length > SUGGESTIONS_SHOWN && (
        <div>
          <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all (${items.length})`}</Button>
        </div>
      )}
    </div>
  );
}

// The entries merged into this one: their names still find it, and each
// merge can be undone.
function MergedIn({ merges, disabled, onUndo }) {
  if (!merges?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-ui-body text-ink-secondary">
      <span>Also named:</span>
      {merges.map((m) => (
        <span key={m.mergeId} className="inline-flex items-center gap-1">
          <span>{m.name}</span>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onUndo(m)}>Undo merge</Button>
        </span>
      ))}
    </div>
  );
}

// The page's two views. Shown only while the access-codes section is on.
function ViewTabs({ show, tab, onChange, foundTotal }) {
  if (!show) return null;
  return (
    <div className="mb-3 flex items-center gap-2" role="group" aria-label="Gate codes view">
      {[["neighborhoods", "Neighborhoods"], ["found", `Found in messages (${foundTotal})`]].map(([key, label]) => (
        <Button key={key} size="sm" variant={tab === key ? "primary" : "secondary"} aria-pressed={tab === key} onClick={() => onChange(key)}>
          {label}
        </Button>
      ))}
    </div>
  );
}

export default function NeighborhoodGateCodesPage() {
  // A link (a conflict bell, a customer's neighborhood) can open one neighborhood.
  const [searchParams, setSearchParams] = useSearchParams();
  const rawOnly = searchParams.get("neighborhood") || "";
  const onlyNeighborhood = UUID_RE.test(rawOnly) ? rawOnly : "";
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
  const [mergingFrom, setMergingFrom] = useState("");
  const [mergeEnabled, setMergeEnabled] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [unplacedEnabled, setUnplacedEnabled] = useState(false);
  const [unplaced, setUnplaced] = useState([]);
  const [reviewing, setReviewing] = useState("");
  const [formError, setFormError] = useState("");

  // "Found in messages": codes customers texted, waiting for the office. The
  // tab exists only when the access codes section answers (404 = off). The
  // found-codes bell links here with ?view=found, which opens that view.
  const viewFound = searchParams.get("view") === "found";
  const [tab, setTab] = useState(viewFound ? "found" : "neighborhoods");
  const [found, setFound] = useState({ available: false, items: [], total: 0, loading: viewFound, error: "" });
  const foundSeq = useRef(0);
  const loadFound = useCallback(async ({ offset = 0 } = {}) => {
    const seq = ++foundSeq.current;
    setFound((f) => ({ ...f, loading: true, error: "" }));
    try {
      const data = await api(`/admin/access-codes/found?limit=${FOUND_PAGE_SIZE}&offset=${offset}`);
      if (seq !== foundSeq.current) return;
      setFound((f) => ({
        available: true,
        items: offset ? [...f.items, ...(data.items || [])] : data.items || [],
        total: data.total || 0,
        loading: false,
        error: "",
      }));
    } catch (err) {
      if (seq !== foundSeq.current) return;
      if (err.status === 404 || err.status === 403) {
        setFound({ available: false, items: [], total: 0, loading: false, error: "" });
        setTab("neighborhoods");
      }
      // Any other failure keeps the tab, so its error and Try again stay reachable.
      else setFound((f) => ({ ...f, available: true, loading: false, error: err.message || "Could not load found codes" }));
    }
  }, []);

  const foundDecision = async (path, body) => {
    await api(`/admin/access-codes${path}`, { method: "POST", body: JSON.stringify(body || {}) });
    await loadFound();
  };
  // The customer search behind "Find a customer" on a code from an unknown number.
  const searchCustomers = async (term) => {
    const data = await api(`/admin/customers?search=${encodeURIComponent(term)}&limit=8&sort=name`);
    return data.customers || [];
  };

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const readSeq = useRef(0);
  // What the rows on screen were loaded for. A first page for a different
  // view (search, filter or linked neighborhood) drops the old rows at once,
  // so a slow or failed load never leaves another view's entries actionable;
  // a reload of the same view (after a save) keeps them in place.
  const shownView = useRef(null);
  const load = useCallback(async ({ offset = 0 } = {}) => {
    const seq = ++readSeq.current;
    const view = `${onlyNeighborhood || ""}|${query}|${filter}`;
    if (!offset && shownView.current !== view) {
      setNeighborhoods([]);
      setTotal(0);
      shownView.current = view;
    }
    setLoading(true);
    setReadError("");
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      // A linked single neighborhood (the conflict bell) opens on its own: a
      // search or filter left from before must never hide it.
      if (onlyNeighborhood) params.set("neighborhood", onlyNeighborhood);
      else {
        if (query) params.set("q", query);
        if (filter === "needs_confirm") params.set("filter", "needs_confirm");
      }
      const data = await api(`/admin/neighborhood-access?${params.toString()}`);
      if (seq !== readSeq.current) return;
      setDisabled(false);
      setMergeEnabled(data.mergeEnabled === true);
      setUnplacedEnabled(data.unplacedEnabled === true);
      setNeighborhoods((prev) => (offset ? [...prev, ...(data.neighborhoods || [])] : data.neighborhoods || []));
      setTotal(data.total || 0);
    } catch (err) {
      if (seq !== readSeq.current) return;
      if (err.status === 404 && err.body?.enabled === false) setDisabled(true);
      else setReadError(err.message || "Could not load gate codes");
    } finally {
      if (seq === readSeq.current) setLoading(false);
    }
  }, [query, filter, onlyNeighborhood]);

  useEffect(() => { load(); }, [load]);
  // After the neighborhood read, so that stays the first request the page makes.
  useEffect(() => { loadFound(); }, [loadFound]);
  // A bell link (?view=found) opens the found list, also on a page that is
  // already open (with a fresh read), then drops the marker so the next bell
  // link opens it again. The first render already started on that view.
  const viewSeen = useRef(false);
  useEffect(() => {
    const first = !viewSeen.current;
    viewSeen.current = true;
    if (!viewFound) return;
    setTab("found");
    if (!first) loadFound();
    setSearchParams((prev) => { const next = new URLSearchParams(prev); next.delete("view"); return next; }, { replace: true });
  }, [viewFound, loadFound, setSearchParams]);
  // A save that finishes after the search or filter changed reloads the
  // CURRENT view, never the one it started under.
  const loadRef = useRef(load);
  loadRef.current = load;

  const closeForms = () => { setEditingId(""); setAddingTo(""); setMergingFrom(""); setReviewing(""); setFormError(""); };

  const loadSuggestions = useCallback(async () => {
    try {
      const data = await api("/admin/neighborhood-access/merge-suggestions");
      setSuggestions(data.suggestions || []);
    } catch {
      // The list is a help, not the page: on any failure it is just not shown.
      setSuggestions([]);
    }
  }, []);
  useEffect(() => {
    if (mergeEnabled) loadSuggestions();
    else setSuggestions([]);
  }, [mergeEnabled, loadSuggestions]);

  const loadUnplaced = useCallback(async () => {
    try {
      const data = await api("/admin/neighborhood-access/unplaced");
      setUnplaced(data.homes || []);
    } catch {
      // A help list, not the page: on any failure it is just not shown.
      setUnplaced([]);
    }
  }, []);
  useEffect(() => {
    if (unplacedEnabled) loadUnplaced();
    else setUnplaced([]);
  }, [unplacedEnabled, loadUnplaced]);

  const mutate = async ({ key, path, method, body, successText, onError }) => {
    setBusyKey(key);
    setActionError("");
    setToast("");
    try {
      const result = await api(path, { method, body: JSON.stringify(body) });
      closeForms();
      await loadRef.current();
      if (mergeEnabled) await loadSuggestions();
      if (unplacedEnabled) await loadUnplaced();
      setToast(typeof successText === "function" ? successText(result) : successText);
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

  // The merge picker's search: every active neighborhood, empty ones included.
  const searchNeighborhoods = useCallback(async (term) => {
    const data = await api(`/admin/neighborhood-access?q=${encodeURIComponent(term)}&limit=8&picker=1`);
    return data.neighborhoods || [];
  }, []);
  const previewMerge = (neighborhood, targetId) => api(`/admin/neighborhood-access/${neighborhood.id}/merge`, {
    method: "POST",
    body: JSON.stringify({ into: targetId, dryRun: true }),
  });
  const onMerge = (neighborhood, target) => mutate({
    key: `${neighborhood.id}:merge`,
    path: `/admin/neighborhood-access/${neighborhood.id}/merge`,
    method: "POST",
    body: { into: target.id },
    successText: `Merged ${neighborhood.name} into ${target.name}`,
    onError: setFormError,
  });
  const onUndoMerge = (merge) => {
    if (!window.confirm(`Undo the merge of ${merge.name}? Its homes and gate entries go back to it.`)) return;
    mutate({
      key: `${merge.mergeId}:undo`,
      path: `/admin/neighborhood-access/merges/${merge.mergeId}/undo`,
      method: "POST",
      body: {},
      successText: (r) => {
        const kept = (r?.homesKept || 0) + (r?.entriesKept || 0);
        return kept
          ? `Undid the merge of ${merge.name}. ${plural(kept, "item", "items")} changed since ${kept === 1 ? "stays" : "stay"} here.`
          : `Undid the merge of ${merge.name}`;
      },
    });
  };
  const onDismissSuggestion = (s) => mutate({
    key: `${s.source.id}:dismiss`,
    path: "/admin/neighborhood-access/merge-suggestions/dismiss",
    method: "POST",
    body: { sourceId: s.source.id, targetId: s.target.id },
    successText: `Marked ${s.source.name} and ${s.target.name} as not the same`,
  });
  // The office pick on the county's community (the Customer 360 picker's own
  // route): it finds that community under any spelling, or adds it.
  const onLinkUnplaced = (h) => {
    const { community, county } = h.countyLot;
    if (!window.confirm(`Link ${h.address || "this home"} to ${community}? That neighborhood's gate codes will show at this home.`)) return;
    mutate({
      key: `${h.propertyId}:link`,
      path: `/admin/neighborhood-access/properties/${h.propertyId}/neighborhood`,
      method: "PUT",
      body: { create: { name: community, county } },
      successText: `Linked ${h.address || "the home"} to ${community}`,
    });
  };

  const showEmpty = !loading && !readError && !disabled && neighborhoods.length === 0;

  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1300px]">
      <AdminCommandHeader variant="workspace" title="Neighborhood gate codes" icon={KeyRound} />

      <ViewTabs show={found.available} tab={tab} onChange={setTab} foundTotal={found.total} />

      {tab === "found" ? (
        <FoundInMessages
          items={found.items}
          total={found.total}
          loading={found.loading}
          error={found.error}
          onRetry={() => loadFound()}
          onMore={() => loadFound({ offset: found.items.length })}
          onSave={(row, body) => foundDecision(`/${row.id}/accept`, body)}
          onDismiss={(row) => foundDecision(`/${row.id}/dismiss`)}
          onLink={(row, customerId) => foundDecision(`/${row.id}/link`, { customerId })}
          onSearch={searchCustomers}
        />
      ) : (
      <>

      <div className="mb-3 rounded-sm border-hairline border-zinc-200 bg-white px-3 py-2 text-ui-body text-ink-secondary">
        Shared access for each neighborhood: gate codes and gate instructions every stop there can
        use. A neighborhood with more than one gate can have a confirmed entry for each. Staff only:
        customers never see these. Confirm an entry after you have seen it work; one nobody has
        confirmed in 6 months shows as Stale.
      </div>

      {disabled ? (
        <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Gate codes are not turned on yet.</div>
      ) : (
        <>
          <UnplacedHomes
            items={unplaced}
            hidden={Boolean(onlyNeighborhood)}
            disabled={busyKey !== ""}
            onLink={onLinkUnplaced}
          />

          <SuggestedMerges
            items={suggestions}
            hidden={Boolean(onlyNeighborhood)}
            reviewing={reviewing}
            disabled={busyKey !== ""}
            onReview={(key) => { closeForms(); setReviewing(key); }}
            onDismiss={onDismissSuggestion}
            renderPanel={(s) => (
              <MergeIntoPanel
                neighborhood={s.source}
                initialTarget={s.target}
                busy={busyKey === `${s.source.id}:merge`}
                error={formError}
                onSearch={searchNeighborhoods}
                onPreview={(targetId) => previewMerge(s.source, targetId)}
                onMerge={(target) => onMerge(s.source, target)}
                onCancel={closeForms}
              />
            )}
          />

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

          {onlyNeighborhood && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-ui-body text-ink-secondary">
              <span>Showing one neighborhood</span>
              <span aria-hidden="true">·</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSearchParams((prev) => { const next = new URLSearchParams(prev); next.delete("neighborhood"); return next; })}
              >
                Show all
              </Button>
            </div>
          )}

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
                    <div className="flex flex-wrap gap-2">
                      {mergeEnabled && mergingFrom !== n.id && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busyKey !== ""}
                          onClick={() => { closeForms(); setMergingFrom(n.id); }}
                        >
                          Merge into…
                        </Button>
                      )}
                      {addingTo !== n.id && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busyKey !== ""}
                          onClick={() => { closeForms(); setAddingTo(n.id); }}
                        >
                          Add entry
                        </Button>
                      )}
                    </div>
                  </div>
                  {mergeEnabled && <MergedIn merges={n.mergedIn} disabled={busyKey !== ""} onUndo={onUndoMerge} />}
                  {mergingFrom === n.id && (
                    <div className="mb-2">
                      <MergeIntoPanel
                        neighborhood={n}
                        busy={busyKey === `${n.id}:merge`}
                        error={formError}
                        onSearch={searchNeighborhoods}
                        onPreview={(targetId) => previewMerge(n, targetId)}
                        onMerge={(target) => onMerge(n, target)}
                        onCancel={closeForms}
                      />
                    </div>
                  )}
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
                        showUnconfirmed={unplacedEnabled}
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
      </>
      )}
    </UiSurface>
  );
}
