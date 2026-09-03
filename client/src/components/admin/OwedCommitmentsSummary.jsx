// client/src/components/admin/OwedCommitmentsSummary.jsx
// "Owed to this customer" — the open promises across a customer's calls,
// rendered where the office already works (Customer 360 → Comms). Reads
// GET /admin/call-recordings/commitments/open?customer_id=…; Mark done and
// Dismiss go through the same PATCH the Owed tab uses. Renders nothing when
// nothing is owed, so the tab looks exactly as before for most customers.
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button } from "../ui";
import { adminFetch } from "../../utils/admin-fetch";

function fmtWhen(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Up to this many rows are shown; past it the heading says "N+" and a line
// points at the Owed tab instead of silently dropping the rest.
const SUMMARY_LIMIT = 20;

export default function OwedCommitmentsSummary({ customerId }) {
  // One panel serves many customers in turn. Loaded rows are keyed by the
  // customer they belong to and rendered ONLY while that is the customer
  // shown — so a switch shows nothing of the previous customer on the very
  // next render, before any effect runs — and a response is applied only
  // when it is the latest request for the customer currently shown, so a
  // slow request for the previous customer never puts their promises (with
  // live Mark done / Dismiss) under this one.
  const [loaded, setLoaded] = useState({ customerId: null, rows: [] });
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const requestRef = useRef({ customerId: null, number: 0 });
  const rows = loaded.customerId === customerId ? loaded.rows : [];

  const load = useCallback(async () => {
    if (!customerId) return;
    const number = requestRef.current.number + 1;
    requestRef.current = { customerId, number };
    const current = () => requestRef.current.customerId === customerId && requestRef.current.number === number;
    try {
      const body = await adminFetch(`/admin/call-recordings/commitments/open?customer_id=${encodeURIComponent(customerId)}&limit=${SUMMARY_LIMIT + 1}`);
      if (!current()) return;
      setLoaded({ customerId, rows: body.commitments || [] });
      setEnabled(body.enabled !== false);
      setError(null);
    } catch (err) {
      if (!current()) return;
      setError(err.message || "Could not load owed promises.");
    }
  }, [customerId]);

  useEffect(() => {
    setError(null);
    load();
  }, [load]);

  // An action started for customer A must not reload — or report — into
  // customer B's profile once the profile has switched: the reload goes
  // through the LATEST load (B's), and only if the profile still shows the
  // customer the action was for.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  const act = async (row, action) => {
    if (busyId) return;
    const forCustomer = customerId;
    setBusyId(row.id);
    try {
      await adminFetch(`/admin/call-recordings/commitments/${encodeURIComponent(row.id)}`, { method: "PATCH", body: JSON.stringify({ action }) });
      if (requestRef.current.customerId !== forCustomer) return;
      await loadRef.current();
    } catch (err) {
      if (requestRef.current.customerId !== forCustomer) return;
      setError(err.message || "That change did not save.");
    } finally {
      setBusyId(null);
    }
  };

  if (!error && rows.length === 0) return null;
  const shown = rows.slice(0, SUMMARY_LIMIT);
  const overflow = rows.length > SUMMARY_LIMIT;
  return (
    <div className="mb-3 border-hairline rounded-md bg-zinc-50 p-2 space-y-1.5" data-testid="owed-summary">
      <div className="text-13 md:text-11 text-ink-tertiary font-medium uppercase tracking-label">
        Owed to this customer{rows.length ? ` (${overflow ? `${SUMMARY_LIMIT}+` : rows.length})` : ""}
      </div>
      {error && <div className="text-13 md:text-12 text-alert-fg" role="alert">{error}</div>}
      {shown.map((row) => (
        <div key={row.id} className="flex flex-wrap items-center gap-1.5 text-14 md:text-12">
          <Badge tone={row.overdue ? "alert" : "neutral"} dot>{row.overdue ? "Overdue" : row.due_at ? `Due ${fmtWhen(row.due_at)}` : "Open"}</Badge>
          <Badge tone={row.party === "waves" ? "strong" : "neutral"}>{row.party === "waves" ? "Waves" : "Customer"}</Badge>
          <span className="text-ink-primary min-w-0">{row.description}</span>
          <span className="text-ink-tertiary">· call {fmtWhen(row.call_started_at)}</span>
          {enabled && (
            <Button size="sm" variant="secondary" disabled={busyId === row.id} onClick={() => act(row, "fulfill")}>Mark done</Button>
          )}
          {enabled && (
            <Button size="sm" variant="ghost" disabled={busyId === row.id} onClick={() => act(row, "dismiss")}>Dismiss</Button>
          )}
        </div>
      ))}
      {overflow && (
        <div className="text-13 md:text-12 text-ink-tertiary">
          More promises are owed to this customer — <a className="underline u-focus-ring" href="/admin/communications#tab=owed">open the Owed tab</a> for the full queue.
        </div>
      )}
    </div>
  );
}
