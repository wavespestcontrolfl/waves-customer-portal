// client/src/components/admin/CustomerRequestsPanel.jsx
// Compact "open service requests" surface for the Customer 360 Services tab.
//
// The dedicated /admin/requests triage page was removed — incoming requests
// now surface as an admin notification that deep-links to this customer, and
// THIS panel is where staff mark a request handled (resolved). Resolving is
// also what releases the estimate add-on dedup index
// (uniq_service_requests_open_estimate_requested_service), so a customer can
// re-request the same add-on after the office follows up.
//
// Renders nothing unless the customer has open (non-resolved) requests, so it
// stays out of the way on the common case.
import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui";
import { adminFetch } from "../../lib/adminFetch";

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function CustomerRequestsPanel({ customerId }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    if (!customerId) return;
    setLoading(true);
    setError("");
    try {
      const res = await adminFetch(
        `/admin/requests?customerId=${encodeURIComponent(customerId)}&openOnly=true&limit=50`
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // Server already excludes terminal statuses (resolved/closed/cancelled)
      // via openOnly before paginating; this filter is a defensive backstop so
      // a stale build can't surface an already-handled row here.
      const rows = (data.requests || []).filter(
        (r) => !["resolved", "closed", "cancelled"].includes(r.status)
      );
      setRequests(rows);
    } catch (e) {
      setError(e?.message || "Could not load requests");
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    load();
  }, [load]);

  const markHandled = useCallback(async (id) => {
    setBusyId(id);
    setError("");
    try {
      const res = await adminFetch(`/admin/requests/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "resolved" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setRequests((prev) => prev.filter((r) => r.id !== id));
    } catch (e) {
      setError(e?.message || "Could not update request");
    } finally {
      setBusyId("");
    }
  }, []);

  // Stay invisible while loading or when there's nothing to triage.
  if (loading || (!requests.length && !error)) return null;

  return (
    <div className="mt-5">
      <div className="text-11 uppercase tracking-label font-medium text-ink-tertiary mb-1.5">
        Service Requests ({requests.length})
      </div>
      {error && <div className="text-13 text-alert-fg mb-1.5">{error}</div>}
      <div className="flex flex-col gap-1.5">
        {requests.map((r) => (
          <div key={r.id} className="border-hairline border-zinc-200 rounded-sm px-3 py-2 text-13">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-zinc-900">{r.subject}</div>
                <div className="text-11 uppercase tracking-label text-ink-tertiary mt-0.5">
                  {(r.category || "").replace(/_/g, " ")}
                  {r.createdAt ? ` · ${fmtDate(r.createdAt)}` : ""}
                  {r.urgency === "urgent" ? " · Urgent" : ""}
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => markHandled(r.id)}
                disabled={busyId === r.id}
              >
                {busyId === r.id ? "Saving" : "Mark handled"}
              </Button>
            </div>
            {r.description && (
              <div className="text-ink-secondary mt-1.5 whitespace-pre-wrap">{r.description}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
