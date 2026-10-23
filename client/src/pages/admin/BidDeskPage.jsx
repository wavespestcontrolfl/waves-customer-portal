import { useCallback, useEffect, useMemo, useState } from "react";
import { Gavel } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ActionFeedback, Badge, Button, Card, CardBody, Field, Input, Select, Table, TBody, TD, TH, THead, Textarea, TR, UiSurface,
} from "../../components/ui";
import { adminFetch } from "../../lib/adminFetch";
import { etDatetimeLocalValue, formatETDate, formatETTime } from "../../lib/timezone";
import BidChecklistPanel from "./BidChecklistPanel";

// Bid Desk (GATE_BID_DESK, dark). Bid invites the email sync stored, filed by a job. The page only reads them and
// records the operator's decisions; nothing here sends a message to a buyer or a contractor.

const STATUS_LABEL = { new: "New", bid: "Bid", no_bid: "No bid", submitted: "Submitted", won: "Won", lost: "Lost" };
const SOURCE_LABEL = {
  buildingconnected: "BuildingConnected", procore: "Procore", gov_email: "Government / portal", email_subject: "Email subject", manual: "Marked by hand", sam_gov: "SAM.gov",
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

function DueCell({ bid }) {
  if (!bid.due_at) return <span className="text-ink-secondary" title="No due date was read from the email">Not read</span>;
  return (
    <div className="grid gap-1">
      <span title={bid.due_source_line ? `Read from: ${bid.due_source_line}` : undefined}>{dueText(bid.due_at)}</span>
      <span className="flex flex-wrap gap-1">
        {bid.due_confirmed ? <Badge tone="strong">Confirmed</Badge> : <Badge tone="warn">Unconfirmed</Badge>}
        {bid.needs_date_confirmation && <Badge tone="warn">Date may have changed</Badge>}
      </span>
    </div>
  );
}

function BidTable({ bids, selectedId, onSelect, checklistLive }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Buyer</TH>
          <TH>Project</TH>
          <TH>Source</TH>
          <TH>Due</TH>
          <TH>Days left</TH>
          <TH>Status</TH>
        </TR>
      </THead>
      <TBody>
        {bids.map((bid) => (
          <TR key={bid.id} className={bid.id === selectedId ? "bg-zinc-50" : undefined}>
            <TD>{buyerOf(bid)}</TD>
            <TD>
              <button type="button" className="text-left font-medium text-zinc-900 underline" onClick={() => onSelect(bid.id)} aria-label={`Open ${titleOf(bid)}`}>
                {titleOf(bid)}
              </button>
              {bid.historical && <Badge className="ml-2">Earlier</Badge>}
              {checklistLive && bid.checklist_progress?.required > 0 && (
                <Badge className="ml-2" tone={bid.checklist_progress.checked === bid.checklist_progress.required ? "strong" : "neutral"} title="Required checklist lines checked">
                  {bid.checklist_progress.checked}/{bid.checklist_progress.required}
                </Badge>
              )}
            </TD>
            <TD>{SOURCE_LABEL[bid.source] || bid.source}</TD>
            <TD><DueCell bid={bid} /></TD>
            <TD nums>{OPEN.includes(bid.status) ? daysText(bid.days_left) : ""}</TD>
            <TD>{STATUS_LABEL[bid.status] || bid.status}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

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

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const data = await api(`/${bidId}`);
      // The checklist fields arrive only while GATE_BID_CHECKLIST is on; without them the panel is not shown.
      const extras = data.checklist_live
        ? { checklist: data.checklist || [], progress: data.checklist_progress || { checked: 0, required: 0, total: 0 }, missing: data.checklist_missing ?? 0, estimate: data.estimate || null, documents: data.documents || [] }
        : null;
      setState({ loading: false, error: "", bid: data.bid, emails: data.emails, extras });
      setDueInput(etDatetimeLocalValue(data.bid.due_at));
      setDueEditedAt(null);
      setStatus(data.bid.status);
      setNote(data.bid.decision_note || "");
    } catch (err) {
      setState({ loading: false, error: err.message, bid: null, emails: [], extras: null });
    }
  }, [bidId]);
  useEffect(() => { setMessage(""); load(); }, [load]);

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
      setMessage(`Not saved: ${err.message}`);
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
    <Card>
      <CardBody>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="break-words text-ui-body font-medium text-zinc-900">{titleOf(bid)}</h2>
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

        {message && <ActionFeedback error={message.startsWith("Not saved")} className="mb-3">{message}</ActionFeedback>}

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
      setMessage({ text: err.status === 404 ? "No email has that id" : "Enter the id from the email's address bar link (the id= part)", error: true });
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

export default function BidDeskPage() {
  const [params, setParams] = useSearchParams();
  const [bids, setBids] = useState([]);
  const [checklistLive, setChecklistLive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState({ text: "", off: false });
  const [filter, setFilter] = useState("open");
  const [showEarlier, setShowEarlier] = useState(true);
  const selectedId = params.get("bid") || "";

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

  const select = (id) => setParams((prev) => { const next = new URLSearchParams(prev); if (id) next.set("bid", id); else next.delete("bid"); return next; });

  const shown = useMemo(() => bids.filter((bid) => {
    if (!showEarlier && bid.historical) return false;
    if (filter === "open") return OPEN.includes(bid.status);
    if (filter === "decided") return !OPEN.includes(bid.status);
    return true;
  }), [bids, filter, showEarlier]);

  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1300px]">
      <AdminCommandHeader variant="workspace" title="Bid Desk" icon={Gavel} />

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

          <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filter">
            {FILTERS.map(({ key, label }) => (
              <Button key={key} size="sm" variant={filter === key ? "primary" : "secondary"} aria-pressed={filter === key} onClick={() => setFilter(key)}>
                {label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" aria-pressed={showEarlier} onClick={() => setShowEarlier((v) => !v)}>
              {showEarlier ? "Hide earlier mail" : "Show earlier mail"}
            </Button>
          </div>

          {error.text && <ActionFeedback error onRetry={load} className="mb-3">{error.text}</ActionFeedback>}
          {loading && !bids.length && <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Loading bids…</div>}
          {!loading && !error.text && shown.length === 0 && (
            <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">No bids here.</div>
          )}
          {shown.length > 0 && <BidTable bids={shown} selectedId={selectedId} onSelect={select} checklistLive={checklistLive} />}

          {selectedId && (
            <div className="mt-4">
              <BidDetail key={selectedId} bidId={selectedId} onChanged={load} onClose={() => select("")} onProgress={setProgress} />
            </div>
          )}
        </>
      )}
    </UiSurface>
  );
}
