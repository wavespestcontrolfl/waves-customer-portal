import { useEffect, useState, useCallback } from "react";

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

const M = {
  bg: "#fafafa", card: "#ffffff", ink: "#111111", muted: "#6b7280",
  line: "#e5e5e5", red: "#c8102e", wash: "#f5f5f5",
};

function fmtIn(v) {
  return v == null ? "—" : `${v}″`;
}
function fmtDate(v) {
  if (!v) return "—";
  try { return new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
  catch { return "—"; }
}

// Tech-facing QA: dual-model gauge OCR that diverged from the manual reading
// (discrepancy) or couldn't be read (ocr_failed). Manual entry is the truth —
// "Confirm" only clears the flag; it never changes the height.
export default function TurfHeightReviewPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [resolving, setResolving] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    adminFetch("/admin/turf-height/review")
      .then((r) => r.json())
      .then((d) => { setItems(d.items || []); setError(null); })
      .catch(() => setError("Failed to load the review queue."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function resolve(id) {
    setResolving(id);
    try {
      const r = await adminFetch(`/admin/turf-height/${id}/resolve`, {
        method: "PATCH",
        body: JSON.stringify({ status: "verified" }),
      });
      if (r.ok) setItems((prev) => prev.filter((it) => it.id !== id));
    } finally {
      setResolving(null);
    }
  }

  return (
    <div style={{ background: M.bg, minHeight: "100%", padding: 24, fontFamily: "'Roboto', Arial, sans-serif", color: M.ink }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Turf height — review</h1>
        <button type="button" onClick={load} style={{ border: `1px solid ${M.line}`, background: M.card, borderRadius: 8, padding: "6px 12px", fontSize: 13, cursor: "pointer" }}>Refresh</button>
      </div>
      <p style={{ color: M.muted, fontSize: 13, marginTop: 0, marginBottom: 18 }}>
        Readings where the gauge-photo OCR diverged from the tech's entry, or couldn't be read. The manual reading is the record — confirming just clears the flag.
      </p>

      {loading && <div style={{ color: M.muted }}>Loading…</div>}
      {error && <div style={{ color: M.red }}>{error}</div>}
      {!loading && !error && items.length === 0 && (
        <div style={{ background: M.card, border: `1px solid ${M.line}`, borderRadius: 12, padding: 28, textAlign: "center", color: M.muted }}>
          Nothing to review — every captured reading agrees with its gauge photo. 🌱
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {items.map((it) => (
          <div key={it.id} style={{ background: M.card, border: `1px solid ${it.verificationStatus === "discrepancy" ? M.red : M.line}`, borderRadius: 12, padding: 16, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            {it.gaugePhotoUrl
              ? <img src={it.gaugePhotoUrl} alt="Gauge" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: `1px solid ${M.line}` }} />
              : <div style={{ width: 72, height: 72, borderRadius: 8, background: M.wash, border: `1px solid ${M.line}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: M.muted }}>No photo</div>}
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontWeight: 600 }}>{it.customerName || "Customer"}</div>
              <div style={{ fontSize: 12, color: M.muted }}>{fmtDate(it.measuredAt)} · {it.grassType?.replace(/_/g, " ") || "—"} · ideal {it.band.min}–{it.band.max}″</div>
            </div>
            <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 11, color: M.muted, textTransform: "uppercase", letterSpacing: ".04em" }}>Tech</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{fmtIn(it.manualHeightIn)}</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 11, color: M.muted, textTransform: "uppercase", letterSpacing: ".04em" }}>OCR</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: it.verificationStatus === "ocr_failed" ? M.muted : M.red }}>
                  {it.verificationStatus === "ocr_failed" ? "unread" : fmtIn(it.ocrHeightIn)}
                </div>
                {it.ocrConfidence != null && it.verificationStatus !== "ocr_failed" && (
                  <div style={{ fontSize: 11, color: M.muted }}>{Math.round(it.ocrConfidence * 100)}% conf</div>
                )}
              </div>
            </div>
            <button type="button" disabled={resolving === it.id} onClick={() => resolve(it.id)}
              style={{ background: M.ink, color: "#fff", border: "none", borderRadius: 999, padding: "8px 16px", fontSize: 13, fontWeight: 500, cursor: "pointer", opacity: resolving === it.id ? 0.6 : 1 }}>
              {resolving === it.id ? "…" : "Confirm reading"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
