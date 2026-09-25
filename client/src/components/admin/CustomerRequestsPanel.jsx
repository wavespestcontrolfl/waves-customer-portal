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

function RequestPhotos({ request, detail, onLoad }) {
  const [selectedPhoto, setSelectedPhoto] = useState("");
  if (!detail) {
    return (
      <Button className="mt-2" variant="secondary" size="sm" onClick={() => onLoad(request.id)}>
        Check photos
      </Button>
    );
  }
  if (detail.loading) return <div className="text-12 text-ink-tertiary mt-2">Loading photos…</div>;
  if (detail.error) {
    return (
      <div className="mt-2">
        <div className="text-13 text-alert-fg">{detail.error}</div>
        <Button className="mt-1.5" variant="secondary" size="sm" onClick={() => onLoad(request.id)}>Retry photos</Button>
      </div>
    );
  }
  const unavailableCount = Math.max(0, Number(detail.unavailableCount) || 0);
  return (
    <>
      {unavailableCount > 0 && (
        <div className="mt-2">
          <div className="text-12 text-ink-tertiary">Some attached photos are unavailable.</div>
          <Button className="mt-1.5" variant="secondary" size="sm" onClick={() => onLoad(request.id)}>Retry unavailable photos</Button>
        </div>
      )}
      {!detail.photos?.length && <div className="text-12 text-ink-tertiary mt-2">No request photos are available.</div>}
      {selectedPhoto && (
        <div className="mt-2">
          <img src={selectedPhoto} alt={`Expanded request evidence for ${request.subject}`} className="w-full max-h-[420px] object-contain bg-zinc-50 rounded-sm border-hairline border-zinc-200" />
          <Button className="mt-1.5" variant="secondary" size="sm" onClick={() => setSelectedPhoto("")}>Close photo</Button>
        </div>
      )}
      {detail.photos?.length > 0 && (
        <div className="grid grid-cols-3 gap-2 mt-2" aria-label={`Photos for ${request.subject}`}>
          {detail.photos.map((photo, index) => (
            <button key={index} type="button" onClick={() => setSelectedPhoto(photo)} aria-label={`Expand photo ${index + 1} for ${request.subject}`}>
              <img src={photo} alt={`Photo ${index + 1} for ${request.subject}`} className="w-full aspect-square object-cover rounded-sm border-hairline border-zinc-200" />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export default function CustomerRequestsPanel({ customerId }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [photoDetails, setPhotoDetails] = useState({});

  // Load is owned by this effect so a customer switch aborts the in-flight
  // request and discards any late response. Without this guard, an operator who
  // navigates Customer 360 from A to B while A's fetch is still in flight could
  // see A's open requests under B's profile and resolve the wrong customer's
  // request (releasing the wrong estimate add-on dedup lock). The `loading`
  // render-guard below also hides the panel during the switch, so a stale row
  // can never be clicked.
  useEffect(() => {
    if (!customerId) {
      setRequests([]);
      setPhotoDetails({});
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError("");
    setPhotoDetails({});
    (async () => {
      try {
        const res = await adminFetch(
          `/admin/requests?customerId=${encodeURIComponent(customerId)}&openOnly=true&limit=50`,
          { signal: ac.signal }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (cancelled) return;
        // Server already excludes terminal statuses (resolved/closed/cancelled)
        // via openOnly before paginating; this filter is a defensive backstop so
        // a stale build can't surface an already-handled row here.
        const rows = (data.requests || []).filter(
          (r) => !["resolved", "closed", "cancelled"].includes(r.status)
        );
        setRequests(rows);
      } catch (e) {
        if (cancelled || e?.name === "AbortError") return;
        setError(e?.message || "Could not load requests");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [customerId]);

  const loadPhotos = useCallback(async (requestId) => {
    setPhotoDetails((current) => ({
      ...current,
      [requestId]: { loading: true, photos: [], unavailableCount: 0, error: "" },
    }));
    try {
      const res = await adminFetch(`/admin/requests/${requestId}/photos`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setPhotoDetails((current) => ({
        ...current,
        [requestId]: {
          loading: false,
          photos: Array.isArray(data.photos) ? data.photos : [],
          unavailableCount: Math.max(0, Number(data.unavailableCount) || 0),
          error: "",
        },
      }));
    } catch (e) {
      setPhotoDetails((current) => ({
        ...current,
        [requestId]: { loading: false, photos: [], unavailableCount: 0, error: e?.message || "Could not load photos" },
      }));
    }
  }, []);

  const markHandled = useCallback(async (id) => {
    setBusyId(id);
    setError("");
    try {
      const res = await adminFetch(`/admin/requests/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "resolved" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const updated = data.request;
      const isTerminal =
        updated && ["resolved", "closed", "cancelled"].includes(updated.status);
      if (isTerminal) {
        // Confirmed handled (by us, or by a racing writer who resolved it first).
        setRequests((prev) => prev.filter((r) => r.id !== id));
      } else {
        // Our resolve lost a race: admin-requests returns statusChanged:false
        // with the still-open row. Reflect reality instead of optimistically
        // hiding it (which would falsely imply the dedup lock was released).
        setRequests((prev) =>
          prev.map((r) => (r.id === id ? { ...r, ...(updated || {}) } : r))
        );
        setError("That request changed before you could resolve it — still open.");
      }
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
                {r.property?.address && (
                  <div className="text-12 text-ink-secondary mt-0.5" data-testid="request-property">
                    {r.property.label ? `${r.property.label} · ` : ""}{r.property.address}
                    {r.property.isPrimary ? "" : " (secondary property)"}
                  </div>
                )}
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
            <RequestPhotos request={r} detail={photoDetails[r.id]} onLoad={loadPhotos} />
          </div>
        ))}
      </div>
    </div>
  );
}
