// client/src/pages/admin/OwedTabV2.jsx
// Communications → Owed: every open promise across calls, overdue first.
// Endpoints:
//   GET   /admin/call-recordings/commitments/open?party=…&hints=…
//   PATCH /admin/call-recordings/commitments/:id   (fulfill | dismiss)
// Reads and writes go through the shared admin fetch (429/401 handling).
// V2 zinc system + components/ui; alert-fg is used for OVERDUE only.
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Select, cn } from "../../components/ui";
import { adminFetch, isRateLimitError } from "../../utils/admin-fetch";

const KIND_LABEL = {
  send_estimate: "Send estimate",
  send_appointment_confirmation: "Send appointment confirmation",
  callback: "Call back",
  send_report: "Send report",
  send_paperwork: "Send paperwork",
  technician_follow_up: "Technician follow-up",
  schedule_visit: "Schedule visit",
  send_photos: "Send photos",
  confirm_date: "Confirm date",
  call_back: "Call us back",
  provide_info: "Provide info",
  make_payment: "Make payment",
  other: "Other",
};

function fmtWhen(value, withTime = true) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

function humanize(value) {
  return value ? String(value).replace(/_/g, " ") : "";
}

export function whoLabel(row) {
  const name = [row.customer_first_name, row.customer_last_name].filter(Boolean).join(" ");
  if (name) return name;
  const phone = String(row.direction || "").startsWith("outbound") ? row.to_phone : row.from_phone;
  return phone || "Unknown caller";
}

export function isOverdueNow(row, now = Date.now()) {
  return Boolean(row.overdue) || (Boolean(row.due_at) && new Date(row.due_at).getTime() < now);
}

export function dueLabel(row, now = Date.now()) {
  // A human-recorded promise is open since it was RECORDED — the instant its
  // implicit deadline ages from — not since a call that may be weeks older.
  const openSince = row.source === "human" ? row.created_at : (row.call_started_at || row.created_at);
  // The server's overdue flag is a snapshot; a stated deadline that passed
  // while the tab stayed open is overdue NOW (Codex #3725 r19 P2).
  if (isOverdueNow(row, now)) return { text: row.due_at ? `Overdue · was due ${fmtWhen(row.due_at)}` : `Overdue · open since ${fmtWhen(openSince, false)}`, tone: "alert" };
  if (row.due_at) {
    const soon = new Date(row.due_at).getTime() - now < 24 * 60 * 60 * 1000;
    return { text: `Due ${fmtWhen(row.due_at)}`, tone: soon ? "strong" : "neutral" };
  }
  return { text: "No due time", tone: "neutral" };
}

export default function OwedTabV2() {
  const [party, setParty] = useState("waves");
  const [showHints, setShowHints] = useState(true);
  const [state, setState] = useState({ status: "loading", rows: [], error: null, implicitDays: null, implicitEstimateHours: null, enabled: true, hasMore: false, nextOffset: null });
  const [loadingMore, setLoadingMore] = useState(false);
  // A minute tick so a deadline that passes while the tab is open re-renders
  // as overdue without a reload.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60 * 1000); return () => clearInterval(t); }, []);
  const [busyId, setBusyId] = useState(null);
  // Only the latest request may paint: a filter change while an earlier
  // load (or a post-action reload) is in flight would otherwise let the
  // older response overwrite the newer selection.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setState((s) => ({ ...s, status: "loading", error: null }));
    try {
      const params = new URLSearchParams();
      if (party !== "all") params.set("party", party);
      if (!showHints) params.set("hints", "0");
      params.set("limit", "200");
      const body = await adminFetch(`/admin/call-recordings/commitments/open?${params.toString()}`);
      if (seq !== requestSeq.current) return;
      setState({ status: "ready", rows: body.commitments || [], error: null, implicitDays: body.overdue_implicit_days ?? null, implicitEstimateHours: body.overdue_implicit_estimate_hours ?? null, enabled: body.enabled !== false, hasMore: body.has_more === true, nextOffset: body.next_offset ?? null });
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setState((s) => ({
        ...s,
        status: "error",
        error: isRateLimitError(err) ? "You're going too fast — try again in a few seconds." : (err.message || "Could not load the owed queue."),
      }));
    }
  }, [party, showHints]);

  useEffect(() => { load(); }, [load]);

  // The server pages at 200: walk the queue with the offset it returned and
  // append, under the same latest-request guard (a filter change while a
  // page is in flight drops the stale page). An action reloads page one.
  const loadMore = async () => {
    if (loadingMore || state.nextOffset == null) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams();
      if (party !== "all") params.set("party", party);
      if (!showHints) params.set("hints", "0");
      params.set("limit", "200");
      params.set("offset", String(state.nextOffset));
      const body = await adminFetch(`/admin/call-recordings/commitments/open?${params.toString()}`);
      if (seq !== requestSeq.current) return;
      setState((s) => ({ ...s, rows: [...s.rows, ...(body.commitments || [])], hasMore: body.has_more === true, nextOffset: body.next_offset ?? null }));
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setState((s) => ({ ...s, error: isRateLimitError(err) ? "You're going too fast — try again in a few seconds." : (err.message || "Could not load more of the owed queue.") }));
    } finally {
      setLoadingMore(false);
    }
  };

  // An action reloads through the LATEST load: a filter change while the
  // PATCH is pending would otherwise let the old closure's reload take the
  // newest sequence number and paint the old filters' rows.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  const act = async (row, action) => {
    if (busyId) return;
    setBusyId(row.id);
    try {
      await adminFetch(`/admin/call-recordings/commitments/${encodeURIComponent(row.id)}`, { method: "PATCH", body: JSON.stringify({ action }) });
      await loadRef.current();
    } catch (err) {
      setState((s) => ({ ...s, error: err.message || "That change did not save." }));
    } finally {
      setBusyId(null);
    }
  };

  const openCall = (row) => {
    // The Calls tab reads `call` from the hash and opens that call's
    // intelligence panel. Coming back to Owed through the header changes
    // only React state, so the hash can still hold this exact target — an
    // identical assignment fires no hashchange, and both listeners (the tab
    // switch and the Calls focus) re-read the hash only on that event.
    const next = `#tab=calls&call=${encodeURIComponent(row.call_log_id)}`;
    if (window.location.hash === next) window.dispatchEvent(new Event("hashchange"));
    else window.location.hash = next;
  };

  const rows = state.rows;
  const overdueCount = rows.filter((r) => isOverdueNow(r, now)).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Whose promises" value={party} onChange={(e) => setParty(e.target.value)} className="h-11 md:h-9">
          <option value="waves">Waves promised</option>
          <option value="customer">Customer agreed</option>
          <option value="all">All</option>
        </Select>
        <label className="flex items-center gap-1.5 text-13 md:text-12 text-ink-secondary min-h-11 md:min-h-0">
          <input type="checkbox" checked={showHints} onChange={(e) => setShowHints(e.target.checked)} />
          Show possibly-kept
        </label>
        <span className="text-13 md:text-12 text-ink-tertiary">
          {state.status === "ready" ? `${rows.length}${state.hasMore ? "+" : ""} open${overdueCount ? ` · ${overdueCount} overdue` : ""}` : ""}
          {state.implicitDays != null && party !== "customer" ? ` · with no due time, an estimate is overdue after ${state.implicitEstimateHours ?? 24} hours, a callback after the day of the call, other promises after ${state.implicitDays} days` : ""}
        </span>
        <Button size="sm" variant="ghost" onClick={load} disabled={state.status === "loading"}>Refresh</Button>
      </div>

      {state.status === "loading" && rows.length === 0 && (
        <div className="text-13 md:text-12 text-ink-tertiary" role="status" aria-live="polite">Loading owed promises…</div>
      )}
      {state.error && (
        <div className="text-13 md:text-12 text-alert-fg" role="alert">
          {state.error}{" "}
          <button type="button" className="underline u-focus-ring" onClick={load}>Retry</button>
        </div>
      )}
      {state.status === "ready" && state.enabled === false && (
        <div className="text-13 md:text-12 text-ink-tertiary">Commitments are recorded and settled only while GATE_CALL_COMMITMENTS is on; rows already recorded stay visible.</div>
      )}
      {state.status === "ready" && rows.length === 0 && (
        <div className="text-14 md:text-13 text-ink-secondary py-6 text-center">
          Nothing owed. Every promise on record is kept, dismissed, or not yet detected.
        </div>
      )}

      <ul className="space-y-1.5">
        {rows.map((row) => {
          const due = dueLabel(row, now);
          const hint = row.status === "open" && row.fulfillment?.strength === "association" ? row.fulfillment : null;
          return (
            <li key={row.id} className="border-hairline rounded-md bg-white p-2 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={due.tone} dot>{due.text}</Badge>
                <Badge tone={row.party === "waves" ? "strong" : "neutral"}>{row.party === "waves" ? "Waves" : "Customer"}</Badge>
                <span className="text-13 md:text-11 text-ink-tertiary">{KIND_LABEL[row.kind] || humanize(row.kind)}</span>
                <Badge tone="neutral">{row.source === "human" ? "office" : row.extractor_version === "relay-v1" ? "AI assistant" : "AI"}</Badge>
              </div>
              <div className="text-14 md:text-12 text-ink-primary">{row.description}</div>
              <div className="text-13 md:text-12 text-ink-secondary flex flex-wrap items-center gap-x-2">
                {row.customer_id ? (
                  <a className="underline u-focus-ring" href={`/admin/customers?customerId=${encodeURIComponent(row.customer_id)}`}>{whoLabel(row)}</a>
                ) : (
                  <span className="font-mono u-nums">{whoLabel(row)}</span>
                )}
                <span className="text-ink-tertiary">· call {fmtWhen(row.call_started_at)}</span>
                {row.human_note && <span className="text-ink-tertiary">· note: {row.human_note}</span>}
              </div>
              {hint && (
                <div className="text-13 md:text-12 text-ink-secondary">
                  Possibly kept: {humanize(hint.kind)}{hint.matched_at ? ` on ${fmtWhen(hint.matched_at)}` : ""}
                  <span className="text-ink-tertiary"> · {humanize(hint.basis)} — confirm with Mark done</span>
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {state.enabled && (
                  <>
                    <Button size="sm" variant="secondary" disabled={busyId === row.id} onClick={() => act(row, "fulfill")}>Mark done</Button>
                    <Button size="sm" variant="ghost" disabled={busyId === row.id} onClick={() => act(row, "dismiss")}>Dismiss</Button>
                  </>
                )}
                <Button size="sm" variant="ghost" onClick={() => openCall(row)} className={cn("ml-auto")}>Open call</Button>
              </div>
            </li>
          );
        })}
      </ul>
      {state.status === "ready" && state.hasMore && (
        <div className="flex items-center gap-2 text-13 md:text-12 text-ink-tertiary">
          <span>Showing {rows.length} — more open promises below.</span>
          <Button size="sm" variant="ghost" onClick={loadMore} disabled={loadingMore}>{loadingMore ? "Loading…" : "Load more"}</Button>
        </div>
      )}
    </div>
  );
}
