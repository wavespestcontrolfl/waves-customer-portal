import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Gavel } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ActionFeedback, Badge, Button, Card, CardBody, Field, Input, Select, Table, TableColumnPicker, TablePagination, TableSavedViews, TableToolbar, TBody, TD, TH, THead, Textarea, TR, UiSurface,
} from "../../components/ui";
import { useAdminTableScroll } from "../../hooks/useAdminTableScroll";
import { useAdminTableViews } from "../../hooks/useAdminTableViews";
import { normalizeTableColumns } from "../../lib/adminTableViewStorage";
import { adminFetch } from "../../lib/adminFetch";
import { etDatetimeLocalValue, formatETDate, formatETTime } from "../../lib/timezone";
import BidChecklistPanel, { UNCONFIRMED_MESSAGE } from "./BidChecklistPanel";

// Bid Desk (GATE_BID_DESK, dark). Bid invites the email sync stored, filed by a job. The page only reads them and
// records the operator's decisions; nothing here sends a message to a buyer or a contractor.

const STATUS_LABEL = { new: "New", bid: "Bid", no_bid: "No bid", submitted: "Submitted", won: "Won", lost: "Lost" };
const SOURCE_LABEL = {
  buildingconnected: "BuildingConnected", procore: "Procore", gov_email: "Government / portal", email_subject: "Email subject", manual: "Marked by hand", sam_gov: "SAM.gov", bluebook: "Blue Book",
};
// A SAM.gov bid links to its public notice; only an https sam.gov address is rendered as a link.
function isSamLink(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && (url.hostname === "sam.gov" || url.hostname.endsWith(".sam.gov"));
  } catch {
    return false;
  }
}
// Where the due date was read, the solicitation number, and (a SAM.gov bid) the link to its notice.
function SourceLines({ bid }) {
  return (
    <>
      {bid.due_source_line && <div><span className="text-ink-secondary">{bid.source === "sam_gov" ? "Read from SAM.gov: " : "Read from the email: "}</span>“{bid.due_source_line}”</div>}
      {bid.solicitation_number && <div><span className="text-ink-secondary">Solicitation: </span>{bid.solicitation_number}</div>}
      {isSamLink(bid.external_url) && (
        <div><a className="underline" href={bid.external_url} target="_blank" rel="noopener noreferrer">Open the notice on SAM.gov</a></div>
      )}
    </>
  );
}
// A SAM.gov bid has no emails, so its empty email list gets no heading.
const showEmailHeading = (bid, emails) => emails.length > 0 || bid.source !== "sam_gov";
const KIND_LABEL = { invite: "Invite", addendum: "Addendum", reminder: "Reminder", message: "Message" };
const OPEN = ["new", "bid"];
const FILTERS = [
  { key: "open", label: "Open" },
  { key: "decided", label: "Decided" },
  { key: "all", label: "All" },
];
const BID_COLUMNS = [
  { id: "project", label: "Project / action", required: true },
  { id: "buyer", label: "Buyer" },
  { id: "source", label: "Source" },
  { id: "due", label: "Due" },
  { id: "deadline", label: "Deadline" },
  { id: "status", label: "Status" },
];
const ALL_BID_COLUMNS = BID_COLUMNS.map((column) => column.id);
const BID_COLUMN_WIDTHS = { project: 280, buyer: 180, source: 160, due: 240, deadline: 120, status: 120 };
const SORTS = [
  { value: "workflow", label: "Default order" },
  { value: "due", label: "Due soonest" },
  { value: "project", label: "Project A–Z" },
  { value: "buyer", label: "Buyer A–Z" },
];
const DEFAULT_PAGE_SIZE = 100;
const PAGE_SIZES = [25, 50, 100, 500];
const BID_TABLE_VIEW_DEFAULTS = {
  filter: "open",
  showEarlier: true,
  search: "",
  sort: "workflow",
  visibleColumns: ALL_BID_COLUMNS,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  scrollTop: 0,
};

// Saved records are browser-owned input. Keep only this table's settings and
// restore columns in their canonical order, including the required project action.
function normalizeBidTableState(value) {
  const state = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    filter: FILTERS.some(({ key }) => key === state.filter) ? state.filter : BID_TABLE_VIEW_DEFAULTS.filter,
    showEarlier: typeof state.showEarlier === "boolean" ? state.showEarlier : BID_TABLE_VIEW_DEFAULTS.showEarlier,
    search: typeof state.search === "string" ? state.search.slice(0, 160) : BID_TABLE_VIEW_DEFAULTS.search,
    sort: SORTS.some(({ value: option }) => option === state.sort) ? state.sort : BID_TABLE_VIEW_DEFAULTS.sort,
    visibleColumns: normalizeTableColumns(state.visibleColumns, BID_COLUMNS),
    page: Number.isInteger(state.page) && state.page > 0 ? state.page : BID_TABLE_VIEW_DEFAULTS.page,
    pageSize: PAGE_SIZES.includes(state.pageSize) ? state.pageSize : BID_TABLE_VIEW_DEFAULTS.pageSize,
    scrollTop: Number.isFinite(state.scrollTop) && state.scrollTop >= 0 ? state.scrollTop : BID_TABLE_VIEW_DEFAULTS.scrollTop,
  };
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  const res = await adminFetch(`/admin/bid-desk${path}`, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error || `HTTP ${res.status}`, res.status);
  return body;
}

// A date stored at 23:59 ET came from a date with no time; it is shown as a date only.
function dueText(value) {
  if (!value) return "Not read";
  const at = new Date(value);
  const date = formatETDate(at, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const time = formatETTime(at);
  return time === "11:59 PM" ? date : `${date} at ${time}`;
}

function daysText(days) {
  if (days == null) return "";
  if (days < 0) return `${-days} ${days === -1 ? "day" : "days"} ago`;
  if (days === 0) return "Today";
  return `${days} ${days === 1 ? "day" : "days"}`;
}

const titleOf = (bid) => (bid.project_title
  ? (bid.package_name ? `${bid.project_title}: ${bid.package_name}` : bid.project_title)
  : bid.first_subject || "(no subject)");
const buyerOf = (bid) => bid.gc_or_agency || bid.buyer_name || bid.first_from_name || bid.first_from_address || "";
const emailHref = (emailId) => `/admin/communications?id=${encodeURIComponent(emailId)}#tab=email`;
const searchTextOf = (bid) => [
  bid.project_title,
  bid.package_name,
  bid.first_subject,
  bid.gc_or_agency,
  bid.buyer_name,
  bid.buyer_email,
  bid.first_from_name,
  bid.first_from_address,
  SOURCE_LABEL[bid.source],
  bid.source,
  bid.solicitation_number,
  bid.location,
].filter(Boolean).join(" ").toLocaleLowerCase();

function sortBids(rows, sort) {
  if (sort === "workflow") return rows;
  return rows.map((bid, index) => ({ bid, index })).sort((left, right) => {
    if (sort === "due") {
      const leftDue = left.bid.due_at ? Date.parse(left.bid.due_at) : Number.POSITIVE_INFINITY;
      const rightDue = right.bid.due_at ? Date.parse(right.bid.due_at) : Number.POSITIVE_INFINITY;
      const safeLeftDue = Number.isFinite(leftDue) ? leftDue : Number.POSITIVE_INFINITY;
      const safeRightDue = Number.isFinite(rightDue) ? rightDue : Number.POSITIVE_INFINITY;
      if (safeLeftDue !== safeRightDue) return safeLeftDue - safeRightDue;
    } else {
      const leftText = sort === "project" ? titleOf(left.bid) : buyerOf(left.bid);
      const rightText = sort === "project" ? titleOf(right.bid) : buyerOf(right.bid);
      const compared = leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: "base" });
      if (compared) return compared;
    }
    return left.index - right.index;
  }).map(({ bid }) => bid);
}

function DueCell({ bid }) {
  if (!bid.due_at) return <span className="text-ink-secondary" title="No due date was read from the email">Not read</span>;
  return (
    <div className="grid gap-1 break-normal">
      <span className="break-normal" title={bid.due_source_line ? `Read from: ${bid.due_source_line}` : undefined}>{dueText(bid.due_at)}</span>
      <span className="flex flex-wrap gap-1">
        {bid.due_confirmed ? <Badge className="whitespace-nowrap" tone="strong">Confirmed</Badge> : <Badge className="whitespace-nowrap" tone="warn">Unconfirmed</Badge>}
        {bid.needs_date_confirmation && <Badge tone="warn">Date may have changed</Badge>}
      </span>
    </div>
  );
}

function BidTable({ bids, selectedId, onSelect, checklistLive, visibleColumns = ALL_BID_COLUMNS, adaptiveColumns = false }) {
  const visible = new Set(visibleColumns);
  const adaptiveMinWidth = visibleColumns.reduce((total, id) => total + (BID_COLUMN_WIDTHS[id] || 0), 0);
  return (
    <Table
      layout="records"
      containerClassName="bid-desk-table"
      className={`table-fixed ${adaptiveColumns ? "min-[1101px]:min-w-[var(--bid-desk-table-min-width)]" : "min-[1101px]:min-w-[1100px]"}`}
      style={adaptiveColumns ? { "--bid-desk-table-min-width": `${adaptiveMinWidth}px` } : undefined}
      aria-label="Bid desk projects"
    >
      <THead>
        <TR>
          <TH scope="col">Project</TH>
          {visible.has("buyer") && <TH scope="col" className="w-[180px]">Buyer</TH>}
          {visible.has("source") && <TH scope="col" className="w-[160px]">Source</TH>}
          {visible.has("due") && <TH scope="col" className="w-[240px]">Due</TH>}
          {visible.has("deadline") && <TH scope="col" className="w-[120px]">Deadline</TH>}
          {visible.has("status") && <TH scope="col" className="w-[120px]">Status</TH>}
        </TR>
      </THead>
      <TBody>
        {bids.map((bid) => (
          <TR key={bid.id} className={bid.id === selectedId ? "bg-zinc-50" : undefined}>
            <TD data-label="Project" className="bid-desk-project-cell">
              <div className="grid min-w-0 justify-items-start gap-2">
                <Button
                  variant="secondary"
                  className="bid-desk-open-record h-auto min-h-11 max-w-full justify-start whitespace-normal px-3 py-2 text-left"
                  onClick={() => onSelect(bid.id)}
                  data-bid-open={bid.id}
                  aria-label={`Open ${titleOf(bid)}`}
                >
                  <span className="min-w-0 break-words">{titleOf(bid)}</span>
                </Button>
                {(bid.historical || (checklistLive && bid.checklist_progress?.required > 0)) && (
                  <span className="flex flex-wrap gap-1">
                    {bid.historical && <Badge className="whitespace-nowrap">Earlier</Badge>}
                    {checklistLive && bid.checklist_progress?.required > 0 && (
                      <Badge className="whitespace-nowrap" tone={bid.checklist_progress.checked === bid.checklist_progress.required ? "strong" : "neutral"} title="Required checklist lines checked">
                        {bid.checklist_progress.checked}/{bid.checklist_progress.required}
                      </Badge>
                    )}
                  </span>
                )}
              </div>
            </TD>
            {visible.has("buyer") && <TD data-label="Buyer">{buyerOf(bid)}</TD>}
            {visible.has("source") && <TD data-label="Source">{SOURCE_LABEL[bid.source] || bid.source}</TD>}
            {visible.has("due") && <TD data-label="Due" className="bid-desk-due-cell"><DueCell bid={bid} /></TD>}
            {visible.has("deadline") && <TD data-label="Deadline" nums className="whitespace-nowrap">{OPEN.includes(bid.status) ? daysText(bid.days_left) : ""}</TD>}
            {visible.has("status") && <TD data-label="Status" className="whitespace-nowrap">{STATUS_LABEL[bid.status] || bid.status}</TD>}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

// A lost reply whose recovery read failed too (the connection is still down): the bid on screen is not refreshed.
const RELOAD_FAILED_MESSAGE = "Could not confirm the save, and the bid could not be reloaded. What you typed is kept: save again when the connection is back.";
const isFailure = (message) => message.startsWith("Not saved") || message === UNCONFIRMED_MESSAGE || message === RELOAD_FAILED_MESSAGE;

function BidDetail({ bidId, onChanged, onClose, onProgress }) {
  const [state, setState] = useState({ loading: true, error: "", bid: null, emails: [], extras: null });
  const [dueInput, setDueInput] = useState("");
  // The bid version the date field was typed against: a date save is fenced on it, so a decision saved in between
  // (which moves the version) cannot carry a date typed against the older bid.
  const [dueEditedAt, setDueEditedAt] = useState(null);
  const [status, setStatus] = useState("new");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const headingRef = useRef(null);
  const arrived = useRef(false);

  // The due date typed but not saved yet, as of the last render (load() reads it without re-creating itself).
  const dueEditedAtNow = useRef(null);
  dueEditedAtNow.current = dueEditedAt;

  // keepDrafts: the reload after a lost reply refreshes the bid as the server has it and leaves every unsaved field
  // alone (Decision, Note, and a due date typed but not saved, still tied to the version it was typed on), as a
  // successful save does. Only the save's own date (resetDueDraft) is re-read.
  const load = useCallback(async ({ keepDrafts = false, resetDueDraft = false } = {}) => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const data = await api(`/${bidId}`);
      // The checklist fields arrive only while GATE_BID_CHECKLIST is on; without them the panel is not shown.
      const extras = data.checklist_live
        ? { checklist: data.checklist || [], progress: data.checklist_progress || { checked: 0, required: 0, total: 0 }, missing: data.checklist_missing ?? 0, estimate: data.estimate || null, documents: data.documents || [] }
        : null;
      setState({ loading: false, error: "", bid: data.bid, emails: data.emails, extras });
      if (!keepDrafts || resetDueDraft || !dueEditedAtNow.current) {
        setDueInput(etDatetimeLocalValue(data.bid.due_at));
        setDueEditedAt(null);
      }
      if (!keepDrafts) {
        setStatus(data.bid.status);
        setNote(data.bid.decision_note || "");
      }
    } catch (err) {
      // A recovery read that fails too keeps the bid and every field on screen as they are, unsaved typing included,
      // instead of replacing the detail with an error (whose Retry would reload without the drafts).
      if (keepDrafts) {
        setState((s) => (s.bid ? { ...s, loading: false } : { loading: false, error: err.message, bid: null, emails: [], extras: null }));
        setMessage(RELOAD_FAILED_MESSAGE);
        return;
      }
      setState({ loading: false, error: err.message, bid: null, emails: [], extras: null });
    }
  }, [bidId]);
  useEffect(() => { setMessage(""); load(); }, [load]);

  // The detail renders below the whole list, so when it first loads (after an Open, or from a ?bid= link) it is
  // scrolled to and its heading takes focus. A reload of the same bid does not move the page again.
  useEffect(() => {
    if (!state.bid || arrived.current) return;
    arrived.current = true;
    const heading = headingRef.current;
    if (!heading) return;
    const card = heading.closest("[data-bid-detail]");
    if (card && card.scrollIntoView) card.scrollIntoView({ block: "start", behavior: "instant" });
    heading.focus({ preventScroll: true });
  }, [state.bid]);

  const save = async (body, done) => {
    setBusy(true);
    setMessage("");
    try {
      const data = await api(`/${bidId}`, { method: "PATCH", body });
      setState((s) => ({ ...s, bid: data.bid }));
      // Only a date save resets the date field: a decision saved first keeps a date the operator typed but has
      // not saved yet.
      // After a date save, or when the operator has not touched the date field, the field shows the saved date.
      // A date typed but not saved yet stays, still tied to the version it was typed on (dueEditedAt).
      if ("due_at" in body || body.confirm_due || !dueEditedAt) {
        setDueInput(etDatetimeLocalValue(data.bid.due_at));
        setDueEditedAt(null);
      }
      setMessage(done);
      onChanged();
      return true;
    } catch (err) {
      if (err instanceof ApiError) {
        setMessage(`Not saved: ${err.message}`);
      } else {
        // No answer arrived (the network dropped): the server may have written the change, so show what it has.
        // Awaited before the saves unlock (finally): a save made meanwhile would be overwritten by this older read.
        setMessage(UNCONFIRMED_MESSAGE);
        onChanged();
        await load({ keepDrafts: true, resetDueDraft: "due_at" in body || body.confirm_due === true });
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const { bid, emails, extras } = state;
  if (state.loading && !bid) return <Card><CardBody>Loading…</CardBody></Card>;
  if (state.error) return <ActionFeedback error onRetry={load}>{state.error}</ActionFeedback>;
  if (!bid) return null;

  return (
    <Card data-bid-detail>
      <CardBody>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 ref={headingRef} tabIndex={-1} className="break-words text-ui-body font-medium text-zinc-900 outline-none">{titleOf(bid)}</h2>
            <div className="text-ui-body text-ink-secondary">
              {[buyerOf(bid), SOURCE_LABEL[bid.source], bid.location].filter(Boolean).join(" · ")}
            </div>
            {(bid.buyer_name || bid.buyer_email) && (
              <div className="text-ui-body text-ink-secondary">Lead on the invite: {[bid.buyer_name, bid.buyer_email].filter(Boolean).join(" · ")}</div>
            )}
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>

        <div className="mb-4 grid gap-1 rounded-sm border-hairline border-zinc-200 bg-zinc-50 px-3 py-2 text-ui-body">
          <div><span className="text-ink-secondary">Due: </span>{dueText(bid.due_at)} {bid.due_at && (bid.due_confirmed ? <Badge tone="strong">Confirmed</Badge> : <Badge tone="warn">Unconfirmed</Badge>)}</div>
          <SourceLines bid={bid} />
          {bid.needs_date_confirmation && (
            <div className="text-warn-fg">{bid.source === "sam_gov"
              ? "SAM.gov changed this notice: the line above says what changed (a new deadline, no deadline, or a closed notice). Check the notice on SAM.gov before you type or confirm a date."
              : "A later email may have changed the date. Check the emails below, then type or confirm the date."}</div>
          )}
          {bid.job_walk_at && <div><span className="text-ink-secondary">Job walk: </span>{dueText(bid.job_walk_at)}</div>}
        </div>

        <div className="mb-4 grid gap-3 md:grid-cols-[minmax(0,18rem)_auto] md:items-end">
          <Field id="bid-due" label="Due date (Eastern time)" help="Type the date from the bid documents. Reminders start only after the date is confirmed.">
            <Input type="datetime-local" value={dueInput} onChange={(event) => { setDueInput(event.target.value); setDueEditedAt((at) => at || bid.updated_at); }} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || !dueInput} onClick={() => save({ due_at: dueInput, expected_updated_at: dueEditedAt || bid.updated_at }, "Due date saved and confirmed")}>Save as confirmed</Button>
            {bid.due_at && !bid.due_confirmed && (
              <Button variant="secondary" disabled={busy} onClick={() => save({ confirm_due: true, expected_updated_at: bid.updated_at }, "Date confirmed as read")}>Confirm date as read</Button>
            )}
            {bid.due_at && (
              <Button variant="ghost" disabled={busy} onClick={() => save({ due_at: null, expected_updated_at: bid.updated_at }, "Due date cleared")}>Clear date</Button>
            )}
          </div>
        </div>

        <div className="mb-4 grid gap-3 md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] md:items-end">
          <Field id="bid-status" label="Decision">
            <Select value={status} onChange={(event) => setStatus(event.target.value)}>
              {Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          </Field>
          <Field id="bid-note" label="Note">
            <Textarea rows={2} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          <Button disabled={busy} onClick={() => save({ status, decision_note: note }, "Decision saved")}>Save decision</Button>
        </div>

        {message && <ActionFeedback error={isFailure(message)} className="mb-3">{message}</ActionFeedback>}

        {extras && (
          <BidChecklistPanel key={bid.id} bidId={bidId} bid={bid} extras={extras} save={save} busy={busy} invite={status === "submitted"} onProgress={onProgress} />
        )}

        {showEmailHeading(bid, emails) && <h3 className={`mb-1 text-ui-body font-medium text-zinc-900${extras ? " mt-4" : ""}`}>Emails on this bid</h3>}
        <ul className="grid gap-1">
          {emails.map((email) => (
            <li key={email.email_id} className="flex flex-wrap items-center gap-2 text-ui-body">
              <Badge>{KIND_LABEL[email.kind] || email.kind}</Badge>
              <span className="text-ink-secondary">{formatETDate(email.received_at, { month: "short", day: "numeric", year: "numeric" })}</span>
              <span className="min-w-0 break-words">{email.subject || "(no subject)"}</span>
              <Link className="underline" to={emailHref(email.email_id)}>Open email</Link>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function MarkEmail({ onMarked }) {
  const [emailId, setEmailId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState({ text: "", error: false });
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage({ text: "", error: false });
    try {
      const data = await api("/from-email", { method: "POST", body: { email_id: emailId.trim() } });
      setMessage({ text: data.created ? "Marked as a bid" : "That email was already on a bid", error: false });
      setEmailId("");
      onMarked(data.bid_id);
    } catch (err) {
      const text = err.status === 404 ? "No email has that id"
        : err.status === 400 ? "Enter the id from the email's address bar link (the id= part)"
          : `Could not mark it: ${err.message}. Try again.`;
      setMessage({ text, error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="mb-3 flex flex-wrap items-end gap-3" onSubmit={submit}>
      <div className="min-w-0 basis-full md:basis-96">
        <Field id="bid-mark-email" label="Mark an email as a bid" help="Open the email in Communications and copy the id= value from the address bar.">
          <Input value={emailId} onChange={(event) => setEmailId(event.target.value)} placeholder="Email id" autoComplete="off" />
        </Field>
      </div>
      <Button type="submit" variant="secondary" disabled={busy || !emailId.trim()}>Mark as bid</Button>
      {message.text && <ActionFeedback error={message.error}>{message.text}</ActionFeedback>}
    </form>
  );
}

function BidDeskControls({
  enhanced, search, onSearchChange, filter, onFilterChange, showEarlier, onEarlierChange,
  sort, onSortChange, visibleColumns, onColumnsChange, onReset, canReset, loadedCount, savedViewsControl,
}) {
  if (!enhanced) {
    return (
      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filter">
        {FILTERS.map(({ key, label }) => (
          <Button key={key} size="sm" variant={filter === key ? "primary" : "secondary"} aria-pressed={filter === key} onClick={() => onFilterChange(key)}>
            {label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" aria-pressed={showEarlier} onClick={() => onEarlierChange(!showEarlier)}>
          {showEarlier ? "Hide earlier mail" : "Show earlier mail"}
        </Button>
      </div>
    );
  }
  return (
    <div className="mb-3 grid gap-2">
      <TableToolbar
        label="Bid Desk"
        search={search}
        onSearchChange={onSearchChange}
        searchPlaceholder="Search loaded bids"
        onReset={onReset}
        canReset={canReset}
      >
        <Field id="bid-table-status" label="Status" className="w-36">
          <Select value={filter} onChange={(event) => onFilterChange(event.target.value)}>
            {FILTERS.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
          </Select>
        </Field>
        <Field id="bid-table-earlier" label="Earlier mail" className="w-44">
          <Select value={showEarlier ? "show" : "hide"} onChange={(event) => onEarlierChange(event.target.value === "show")}>
            <option value="show">Show earlier mail</option>
            <option value="hide">Hide earlier mail</option>
          </Select>
        </Field>
        <Field id="bid-table-sort" label="Sort" className="w-48">
          <Select value={sort} onChange={(event) => onSortChange(event.target.value)}>
            {SORTS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </Field>
        <TableColumnPicker label="Bid Desk" columns={BID_COLUMNS} visibleColumns={visibleColumns} onChange={onColumnsChange} />
        {savedViewsControl}
      </TableToolbar>
      <p className="text-ui-caption text-ink-secondary">Search, filters, sorting, and page counts apply to the loaded bids.</p>
      {loadedCount >= 500 && (
        <p className="text-ui-body text-ink-secondary">Only the first 500 bids are loaded. Search and filters apply to this set.</p>
      )}
    </div>
  );
}

function BidDeskResults({
  error, loading, loadedCount, shown, displayed, selectedId, onSelect, checklistLive, enhanced,
  visibleColumns, page, totalPages, pageSize, onPageChange, onPageSizeChange,
}) {
  return (
    <>
      {error.text && <ActionFeedback error onRetry={error.onRetry} className="mb-3">{error.text}</ActionFeedback>}
      {loading && !loadedCount && <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Loading bids…</div>}
      {!loading && !error.text && shown.length === 0 && (
        <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">No bids here.</div>
      )}
      {displayed.length > 0 && (
        <BidTable
          bids={displayed}
          selectedId={selectedId}
          onSelect={onSelect}
          checklistLive={checklistLive}
          visibleColumns={enhanced ? visibleColumns : ALL_BID_COLUMNS}
          adaptiveColumns={enhanced}
        />
      )}
      {enhanced && !loading && !error.text && (
        <TablePagination
          label="Bid Desk"
          page={page}
          totalPages={totalPages}
          total={shown.length}
          pageSize={pageSize}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
          itemLabel="loaded bids"
          pageSizeOptions={PAGE_SIZES}
        />
      )}
    </>
  );
}

export default function BidDeskPage({ embedded = false }) {
  const [params, setParams] = useSearchParams();
  const [bids, setBids] = useState([]);
  const [checklistLive, setChecklistLive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState({ text: "", off: false });
  const enhancedControls = params.get("tableControls") !== "0";
  const savedViewsEnabled = enhancedControls && params.get("savedViews") === "1";
  const selectedId = params.get("bid") || "";
  const tableViews = useAdminTableViews({
    tableId: "bids",
    enabled: savedViewsEnabled,
    defaults: BID_TABLE_VIEW_DEFAULTS,
    normalize: normalizeBidTableState,
  });
  const { state: tableState, setState: setTableState } = tableViews;
  const { filter, showEarlier, search, sort, visibleColumns, page, pageSize, scrollTop } = tableState;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api("/");
      setBids(data.bids);
      setChecklistLive(data.checklist_live === true);
      setError({ text: "", off: false });
    } catch (err) {
      setError({ text: err.message, off: err.status === 404 });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // A checklist change in the open bid moves its chip in the list at once.
  const setProgress = useCallback((id, progress) => {
    if (!progress) return;
    setBids((rows) => rows.map((row) => (row.id === id ? { ...row, checklist_progress: { checked: progress.checked, required: progress.required } } : row)));
  }, []);

  // Closing a bid puts focus back on its Open button, so the operator keeps their place in the list.
  const returnFocusTo = useRef("");
  useEffect(() => {
    if (selectedId || !returnFocusTo.current) return;
    const id = returnFocusTo.current;
    returnFocusTo.current = "";
    const button = Array.from(document.querySelectorAll("[data-bid-open]")).find((node) => node.dataset.bidOpen === id);
    if (button) button.focus({ preventScroll: true });
  }, [selectedId]);

  const select = (id) => setParams((prev) => { const next = new URLSearchParams(prev); if (id) next.set("bid", id); else next.delete("bid"); return next; });

  const shown = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const filtered = bids.filter((bid) => {
      if (!showEarlier && bid.historical) return false;
      if (filter === "open" && !OPEN.includes(bid.status)) return false;
      if (filter === "decided" && OPEN.includes(bid.status)) return false;
      return !enhancedControls || !query || searchTextOf(bid).includes(query);
    });
    return enhancedControls ? sortBids(filtered, sort) : filtered;
  }, [bids, enhancedControls, filter, search, showEarlier, sort]);
  const totalPages = Math.max(1, Math.ceil(shown.length / pageSize));
  useEffect(() => {
    if (!enhancedControls || loading || error.text) return;
    const nextPage = Math.min(Math.max(1, page), totalPages);
    if (nextPage !== page) {
      setTableState((current) => ({ ...current, page: nextPage, scrollTop: 0 }));
    }
  }, [enhancedControls, error.text, loading, page, setTableState, totalPages]);
  const displayed = enhancedControls
    ? shown.slice((page - 1) * pageSize, page * pageSize)
    : shown;
  const scrollResetKey = useMemo(
    () => JSON.stringify([filter, showEarlier, search, sort, page, pageSize]),
    [filter, page, pageSize, search, showEarlier, sort],
  );
  const rememberScroll = useCallback((value) => {
    setTableState((current) => ({ ...current, scrollTop: value }));
  }, [setTableState]);
  useAdminTableScroll({
    enabled: savedViewsEnabled && tableViews.available,
    active: !selectedId,
    ready: !loading && !error.text,
    scope: tableViews.storageKey,
    scrollTop,
    onScroll: rememberScroll,
    resetKey: scrollResetKey,
  });
  const resetEnhancedControls = () => {
    setTableState((current) => ({
      ...current,
      search: BID_TABLE_VIEW_DEFAULTS.search,
      filter: BID_TABLE_VIEW_DEFAULTS.filter,
      showEarlier: BID_TABLE_VIEW_DEFAULTS.showEarlier,
      page: 1,
      scrollTop: 0,
    }));
  };
  const enhancedControlsChanged = Boolean(search) || filter !== "open" || !showEarlier;

  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1300px]">
      {!embedded && <AdminCommandHeader variant="workspace" title="Bid Desk" icon={Gavel} />}

      <div className="mb-3 rounded-sm border-hairline border-zinc-200 bg-white px-3 py-2 text-ui-body text-ink-secondary">
        Bid invites that reached the shared inbox (BuildingConnected, Procore, city and HOA requests). A due date is read from the invite
        and shows as Unconfirmed until you confirm or type it. {checklistLive
          ? "Reminders go to the bell 14, 7 and 2 days before a confirmed date, and 2 days before the questions date and the site visit."
          : "Reminders go to the bell 7 and 2 days before a confirmed date."} Nothing here
        is sent to a buyer or a contractor.
      </div>

      {error.off ? (
        <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Bid Desk is not turned on yet.</div>
      ) : (
        <>
          <MarkEmail onMarked={(id) => { load(); if (id) select(id); }} />

          <BidDeskControls
            enhanced={enhancedControls}
            search={search}
            onSearchChange={(value) => setTableState((current) => ({ ...current, search: value, page: 1, scrollTop: 0 }))}
            filter={filter}
            onFilterChange={(value) => setTableState((current) => ({ ...current, filter: value, page: 1, scrollTop: 0 }))}
            showEarlier={showEarlier}
            onEarlierChange={(value) => setTableState((current) => ({ ...current, showEarlier: value, page: 1, scrollTop: 0 }))}
            sort={sort}
            onSortChange={(value) => setTableState((current) => ({ ...current, sort: value, page: 1, scrollTop: 0 }))}
            visibleColumns={visibleColumns}
            onColumnsChange={(value) => setTableState((current) => ({ ...current, visibleColumns: value }))}
            onReset={resetEnhancedControls}
            canReset={enhancedControlsChanged}
            loadedCount={bids.length}
            savedViewsControl={savedViewsEnabled ? <TableSavedViews label="Bid Desk" controller={tableViews} /> : null}
          />

          <BidDeskResults
            error={{ ...error, onRetry: load }}
            loading={loading}
            loadedCount={bids.length}
            shown={shown}
            displayed={displayed}
            selectedId={selectedId}
            onSelect={select}
            checklistLive={checklistLive}
            enhanced={enhancedControls}
            visibleColumns={visibleColumns}
            page={page}
            totalPages={totalPages}
            pageSize={pageSize}
            onPageChange={(value) => setTableState((current) => ({ ...current, page: value, scrollTop: 0 }))}
            onPageSizeChange={(size) => setTableState((current) => ({ ...current, pageSize: size, page: 1, scrollTop: 0 }))}
          />

          {selectedId && (
            <div className="mt-4">
              <BidDetail key={selectedId} bidId={selectedId} onChanged={load} onClose={() => { returnFocusTo.current = selectedId; select(""); }} onProgress={setProgress} />
            </div>
          )}
        </>
      )}
    </UiSurface>
  );
}
