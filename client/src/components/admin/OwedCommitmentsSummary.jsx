// Customer 360 uses the existing commitment reader and correction route for
// call promises and SMS follow-up. SMS is explicitly scoped to one customer;
// it never joins the global call Owed queue.
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button } from "../ui";
import { adminFetch } from "../../utils/admin-fetch";

function fmtWhen(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const SUMMARY_LIMIT = 20;

export default function OwedCommitmentsSummary({ customerId, source = "call" }) {
  const scope = `${customerId}:${source}`;
  const [loaded, setLoaded] = useState({ scope: null, rows: [], nextOffset: null });
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef({ scope: null, number: 0 });
  const rows = loaded.scope === scope ? loaded.rows : [];
  const nextOffset = loaded.scope === scope ? loaded.nextOffset : null;

  const load = useCallback(async (offset = 0) => {
    if (!customerId) return;
    const number = requestRef.current.number + 1;
    requestRef.current = { scope, number };
    const current = () => requestRef.current.scope === scope && requestRef.current.number === number;
    setLoading(true);
    try {
      const collection = source === "sms" ? "sms" : "open";
      const body = await adminFetch(`/admin/call-recordings/commitments/${collection}?customer_id=${encodeURIComponent(customerId)}&limit=${SUMMARY_LIMIT}&offset=${offset}`);
      if (!current()) return;
      setLoaded((previous) => {
        const combined = offset && previous.scope === scope ? [...previous.rows, ...(body.commitments || [])] : body.commitments || [];
        return { scope, rows: [...new Map(combined.map((row) => [row.id, row])).values()],
          nextOffset: body.has_more ? body.next_offset : null };
      });
      setEnabled(body.enabled === true);
      setError(null);
    } catch (err) {
      if (!current()) return;
      setError(err.message || "Could not load follow-up.");
    } finally {
      if (current()) setLoading(false);
    }
  }, [customerId, source, scope]);

  useEffect(() => {
    setError(null);
    load();
  }, [load]);

  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  const act = async (row, action) => {
    if (busyId) return;
    const forScope = scope;
    setBusyId(row.id);
    try {
      await adminFetch(`/admin/call-recordings/commitments/${encodeURIComponent(row.id)}`, {
        method: "PATCH", body: JSON.stringify({ action, ...(source === "sms" ? { customer_id: customerId } : {}) }),
      });
      if (requestRef.current.scope !== forScope) return;
      await loadRef.current();
    } catch (err) {
      if (requestRef.current.scope !== forScope) return;
      setError(err.message || "That change did not save.");
    } finally {
      setBusyId(null);
    }
  };

  if (!error && rows.length === 0) return null;
  return (
    <div className="mb-3 border-hairline rounded-md bg-zinc-50 p-3 space-y-2" data-testid={source === "sms" ? "sms-followup-summary" : "owed-summary"}>
      <div className="text-14 text-ink-tertiary font-medium">
        {source === "sms" ? "SMS follow-up" : "Owed to this customer"}{rows.length ? ` (${rows.length}${nextOffset !== null ? "+" : ""})` : ""}
      </div>
      {source === "sms" && <p className="text-14 text-ink-secondary">Mark done after verifying completion. Dismiss requests that no longer apply.</p>}
      {error && <div className="text-14 text-alert-fg" role="alert">{error}</div>}
      {rows.map((row) => (
        <div key={row.id} className="border-t border-zinc-200 pt-2 text-14">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="!text-14" tone={row.overdue ? "alert" : "neutral"} dot>{row.overdue ? "Overdue" : row.due_at ? `Due ${fmtWhen(row.due_at)}` : "Open"}</Badge>
            <Badge className="!text-14" tone={row.party === "waves" ? "strong" : "neutral"}>{row.party === "waves" ? "Waves" : "Customer"}</Badge>
            <span className="text-ink-primary min-w-0 break-words">{row.description}</span>
          </div>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-ink-tertiary">{source === "sms" ? "SMS" : "Call"} {fmtWhen(row.sms_started_at || row.call_started_at)}</span>
            {enabled && (
              <div className="flex gap-2">
                <Button className="!text-14" size="sm" variant="secondary" disabled={!!busyId || loading} onClick={() => act(row, "fulfill")}>Mark done</Button>
                <Button className="!text-14" size="sm" variant="ghost" disabled={!!busyId || loading} onClick={() => act(row, "dismiss")}>Dismiss</Button>
              </div>
            )}
          </div>
        </div>
      ))}
      {nextOffset !== null && (
        <Button className="!text-14" size="sm" variant="ghost" disabled={loading || !!busyId} onClick={() => load(nextOffset)}>
          {loading ? "Loading…" : "Show more"}
        </Button>
      )}
    </div>
  );
}
