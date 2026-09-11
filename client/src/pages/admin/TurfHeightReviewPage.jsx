import { useEffect, useState, useCallback, useRef } from "react";
import { formatETDate } from "../../lib/timezone";
import { Ruler, RefreshCw } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";

import { UiSurface, Button, Card, CardBody, ActionFeedback } from "../../components/ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      ...(options.headers || {}),
    },
  });
}

function fmtIn(v) {
  return v == null ? "—" : `${v}″`;
}
function fmtDate(v) {
  if (!v) return "—";
  // The portal is Eastern Time end-to-end — pin display to ET so a late-evening
  // service never renders on the wrong calendar day in another browser timezone.
  try { return formatETDate(v, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return "—"; }
}

// Tech-facing QA: dual-model gauge OCR that diverged from the manual reading
// (discrepancy) or couldn't be read (ocr_failed). Manual entry is the truth —
// "Confirm" only clears the flag; it never changes the height.
export default function TurfHeightReviewPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [resolving, setResolving] = useState(new Set());
  const pendingConfirmations = useRef(new Set());
  // Per-row confirm failures: two rows confirmed back-to-back must not let
  // one success wipe the other's failure (UI audit F0558, Codex r2).
  const [rowErrors, setRowErrors] = useState({});

  const load = useCallback(() => {
    setLoading(true);
    adminFetch("/admin/turf-height/review")
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { setItems(d.items || []); setError(null); })
      .catch(() => setError("Failed to load the review queue — the query may be broken, not empty."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function resolve(id) {
    if (pendingConfirmations.current.has(id)) return;
    pendingConfirmations.current.add(id);
    setResolving(new Set(pendingConfirmations.current));
    try {
      const r = await adminFetch(`/admin/turf-height/${id}/resolve`, {
        method: "PATCH",
        body: JSON.stringify({ status: "verified" }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        setRowErrors((prev) => ({ ...prev, [id]: b.error || `Could not confirm reading (HTTP ${r.status})` }));
        return;
      }
      setRowErrors((prev) => { const next = { ...prev }; delete next[id]; return next; });
      setItems((prev) => prev.filter((it) => it.id !== id));
    } catch {
      // UI audit F0558: a rejected PATCH used to escape the click handler
      // unhandled while the row silently stayed put.
      setRowErrors((prev) => ({ ...prev, [id]: "Could not confirm reading — check your connection and try again." }));
    } finally {
      pendingConfirmations.current.delete(id);
      setResolving(new Set(pendingConfirmations.current));
    }
  }

  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1300px] text-ui-body text-ink-primary">
      <AdminCommandHeader
        variant="workspace"
        title="Turf height review"
        icon={Ruler}
        actions={[{ key: "refresh", label: "Refresh", variant: "ghost", icon: RefreshCw, onClick: load }]}
      />
      <p className="mb-5 text-ui-body text-ink-secondary">
        Readings where the gauge-photo OCR diverged from the tech's entry, or couldn't be read. The manual reading is the record — confirming just clears the flag.
      </p>

      {loading && <ActionFeedback className="min-h-16 mb-3">Loading…</ActionFeedback>}
      {error && <ActionFeedback error className="mb-3">{error}</ActionFeedback>}
      {!loading && !error && items.length === 0 && (
        <Card><CardBody className="py-8 text-center text-ui-body text-ink-secondary">
          Nothing to review — every captured reading agrees with its gauge photo.
        </CardBody></Card>
      )}

      <div className="flex flex-col gap-3">
        {items.map((it) => (
          <Card key={it.id} className={it.verificationStatus === "discrepancy" ? "!border-alert-fg" : undefined}>
            <CardBody className="flex flex-wrap items-center gap-4">
              {it.gaugePhotoUrl
                ? <img src={it.gaugePhotoUrl} alt="Gauge" className="h-[72px] w-[72px] shrink-0 rounded-md border-hairline border-zinc-200 object-cover" />
                : <div className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-md border-hairline border-zinc-200 bg-zinc-50 text-ui-caption text-ink-secondary">No photo</div>}
              <div className="min-w-0 flex-1 basis-44 break-words">
                <h2 className="text-ui-body font-medium">{it.customerName || "Customer"}</h2>
                <div className="text-ui-caption text-ink-secondary u-nums">{fmtDate(it.measuredAt)} · {it.grassType?.replace(/_/g, " ") || "—"} · ideal {it.band.min}–{it.band.max}″</div>
              </div>
              <dl className="flex items-start gap-5 u-nums">
                <div className="text-center">
                  <dt className="text-ui-caption text-ink-secondary">Tech</dt>
                  <dd className="text-18 leading-[1.35] font-medium">{fmtIn(it.manualHeightIn)}</dd>
                </div>
                <div className="text-center">
                  <dt className="text-ui-caption text-ink-secondary">OCR</dt>
                  <dd className={`text-18 leading-[1.35] font-medium ${it.verificationStatus === "ocr_failed" ? "text-ink-secondary" : "text-alert-fg"}`}>
                    {it.verificationStatus === "ocr_failed" ? "unread" : fmtIn(it.ocrHeightIn)}
                  </dd>
                  {it.ocrConfidence != null && it.verificationStatus !== "ocr_failed" && (
                    <dd className="text-ui-caption text-ink-secondary">{Math.round(it.ocrConfidence * 100)}% conf</dd>
                  )}
                </div>
              </dl>
              <Button variant="secondary" loading={resolving.has(it.id)} onClick={() => resolve(it.id)} className="w-full sm:w-auto sm:ml-auto">
                Confirm reading
              </Button>
              {rowErrors[it.id] && (
                <ActionFeedback error className="basis-full">{rowErrors[it.id]}</ActionFeedback>
              )}
            </CardBody>
          </Card>
        ))}
      </div>
    </UiSurface>
  );
}
