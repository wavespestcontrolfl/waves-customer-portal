import { useEffect, useState } from "react";
import { FileText, ExternalLink } from "lucide-react";

// Inventory's inline zinc system; this panel does not introduce UI primitives.
const D = { ink: "#18181B", muted: "#52525B", border: "#E4E4E7", wash: "#F4F4F5", red: "#A32D2D" };
const button = { minHeight: 44, padding: "9px 13px", border: `1px solid ${D.border}`, borderRadius: 5, background: "#FFFFFF", color: D.ink, fontSize: 14, fontWeight: 500, cursor: "pointer" };
const FIELD_LABELS = { minTempF: ["Minimum temperature", "°F"], maxTempF: ["Maximum temperature", "°F"], maxWindMph: ["Maximum wind", "mph"], rainFreeHours: ["Rain-free interval", "hours"] };

async function request(productId, action = "", body) {
  const response = await fetch(`${import.meta.env.VITE_API_URL || "/api"}/admin/inventory/${productId}/label-review${action}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Label review could not be loaded.");
  return data;
}

function Evidence({ entry }) {
  return <div style={{ display: "grid", gap: 10 }}>
    <div style={{ padding: 12, background: D.wash, borderRadius: 5 }}>
      <div>{entry.source.productName} · EPA {entry.source.registration}</div>
      <div style={{ color: D.muted, marginTop: 4 }}>Label accepted {entry.source.acceptedDate || "date unavailable"}</div>
      <a href={entry.source.url} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: D.ink, minHeight: 44 }}>Open source PDF <ExternalLink size={15} /></a>
    </div>
    {Object.entries(FIELD_LABELS).map(([key, [label, unit]]) => {
      const fact = entry.facts[key];
      return <div key={key} style={{ padding: 12, border: `1px solid ${D.border}`, borderRadius: 5, overflowWrap: "anywhere" }}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}><span>{label}</span><strong style={{ fontWeight: 500 }}>{fact.status === "limit" ? `${fact.value} ${unit}` : fact.status === "conditional" ? "CONDITIONAL" : "NOT STATED"}</strong></div>
        {fact.quote && <blockquote style={{ margin: "10px 0", paddingLeft: 10, borderLeft: `2px solid ${D.border}`, color: D.muted }}>{fact.quote}</blockquote>}
        {fact.note && <p style={{ margin: "8px 0", color: D.muted }}>{fact.note}</p>}
        {fact.page && <a href={`${entry.source.url}#page=${fact.page}`} target="_blank" rel="noopener noreferrer" style={{ color: D.ink, display: "inline-block", minHeight: 32 }}>Source page {fact.page}</a>}
      </div>;
    })}
  </div>;
}

export default function ProductLabelReview({ product }) {
  const [review, setReview] = useState(null);
  const [activeCurrent, setActiveCurrent] = useState(false);
  const [activeReason, setActiveReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setConfirmed(false); setError(""); setNotice("");
    request(product.id).then((data) => { if (!cancelled) { setReview(data.review); setActiveCurrent(data.activeCurrent === true); setActiveReason(data.activeReason || ""); } })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [product]);

  async function act(action, body) {
    setBusy(true); setError(""); setNotice("");
    try {
      await request(product.id, action, body);
      const data = await request(product.id);
      setReview(data.review); setActiveCurrent(data.activeCurrent === true); setActiveReason(data.activeReason || ""); setConfirmed(false);
      setNotice(action === "/extract" ? "Candidate ready for source review." : "Review saved. Reopen the Job Card to use the current evidence.");
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const draft = review?.draft;
  const active = review?.active;
  const disabled = busy || loading;
  // Inventory's table can be wider than the phone viewport. Keep the review
  // and its confirmation controls within the page and expanded-row gutters.
  return <section aria-label="Label weather review" style={{ maxWidth: "calc(100vw - 64px)", boxSizing: "border-box", overflowWrap: "anywhere", background: "#FFFFFF", border: `1px solid ${D.border}`, borderRadius: 6, padding: 16, margin: "16px 0", color: D.ink, fontSize: 14, lineHeight: 1.6 }}>
    <h3 style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 16, fontWeight: 500, margin: "0 0 8px" }}><FileText size={18} /> Label weather evidence</h3>
    <p style={{ margin: "0 0 12px", color: D.muted }}>Read the EPA label, check the source pages, then approve weather facts for the Job Card. This review does not verify mixing rates.</p>
    {loading && <p role="status">Loading label review…</p>}
    {error && <p role="alert" style={{ color: D.red }}>{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {active && <details style={{ margin: "12px 0", borderBottom: `1px solid ${D.border}`, paddingBottom: 12 }}>
      <summary style={{ minHeight: 44, cursor: "pointer" }}>Current weather review · {active.status === "approved" ? (activeCurrent ? "APPROVED" : "INACTIVE · REVIEW REQUIRED") : "REVOKED"}</summary>
      {active.status === "approved" && !activeCurrent && <p role="status">{activeReason}. Discard any outdated candidate before reading the label again.</p>}
      <Evidence entry={active} />
      <p style={{ color: D.muted }}>Reviewed {new Date(active.reviewedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} ET</p>
      {active.status === "approved" && <button disabled={disabled} style={button} onClick={() => act("/revoke", { reviewId: active.id })}>REVOKE WEATHER REVIEW</button>}
    </details>}
    {draft ? <div>
      <h4 style={{ fontSize: 14, fontWeight: 500, margin: "14px 0" }}>CANDIDATE · NOT YET ACTIVE</h4>
      <p style={{ color: D.muted }}>Catalog: {product.name} · {product.formulation || "formulation not recorded"} · EPA {product.epaRegNumber || "not recorded"}</p>
      <Evidence entry={draft} />
      <label style={{ display: "flex", gap: 10, alignItems: "flex-start", margin: "16px 0", cursor: "pointer" }}>
        <input type="checkbox" checked={confirmed} disabled={disabled} onChange={(e) => setConfirmed(e.target.checked)} style={{ minWidth: 20, height: 20, marginTop: 3, accentColor: D.ink }} />
        <span>I matched the exact product and formulation and checked each fact against the source pages. Conditional and missing limits remain unresolved.</span>
      </label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button disabled={disabled || !confirmed} style={{ ...button, background: D.ink, color: "#FFFFFF", opacity: disabled || !confirmed ? 0.5 : 1 }} onClick={() => act("/decision", { candidateId: draft.id, decision: "approve", identityConfirmed: true })}>APPROVE WEATHER FACTS</button>
        <button disabled={disabled} style={button} onClick={() => act("/decision", { candidateId: draft.id, decision: "reject" })}>REJECT CANDIDATE</button>
      </div>
    </div> : <button disabled={disabled} style={button} onClick={() => act("/extract", {})}>{busy ? "READING LABEL…" : "FIND & READ EPA LABEL"}</button>}
    <p style={{ color: D.muted, margin: "14px 0 0" }}>No numeric limit in the source is not a clearance to apply. Missing and conditional evidence can still produce UNKNOWN.</p>
  </section>;
}
