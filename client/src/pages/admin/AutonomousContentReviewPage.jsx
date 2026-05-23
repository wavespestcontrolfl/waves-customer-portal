import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  FileText,
  RefreshCw,
  Search,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  heading: "#09090B",
  text: "#27272A",
  muted: "#71717A",
  green: "#15803D",
  amber: "#A16207",
  red: "#991B1B",
  accent: "#18181B",
};
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
  }).then(async (r) => {
    if (!r.ok) {
      let message = `${r.status} ${r.statusText}`;
      try {
        const data = await r.clone().json();
        message = data?.error || message;
      } catch {
        /* keep default */
      }
      throw new Error(message);
    }
    return r.json();
  });
}

function formatDate(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function Chip({ children, tone = "neutral" }) {
  const colors = {
    green: { bg: "#DCFCE7", fg: D.green },
    amber: { bg: "#FEF3C7", fg: D.amber },
    red: { bg: "#FEE2E2", fg: D.red },
    neutral: { bg: D.bg, fg: D.text },
  }[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 24,
        padding: "0 8px",
        borderRadius: 6,
        background: colors.bg,
        color: colors.fg,
        fontSize: 12,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function Kpi({ label, value, tone }) {
  const color = tone === "red" ? D.red : tone === "amber" ? D.amber : tone === "green" ? D.green : D.heading;
  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 16 }}>
      <div style={{ fontSize: 12, color: D.muted, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 24, color, fontWeight: 800, fontFamily: MONO, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function gateTone(summary) {
  if (!summary) return "neutral";
  if ((summary.hard_failures || []).length > 0 || summary.quality_ok === false) return "red";
  if ((summary.soft_failures || []).length > 0 || summary.uniqueness_ok === false) return "amber";
  return "green";
}

export default function AutonomousContentReviewPage() {
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await adminFetch("/admin/content/autonomous/review?status=pending_review&limit=50");
      setData(next);
      setSelectedId((current) => next.items?.some((item) => item.id === current) ? current : next.items?.[0]?.id || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setDetail(null);
    setDetailLoading(true);
    adminFetch(`/admin/content/autonomous/review/${selectedId}`)
      .then((next) => setDetail(next.item))
      .catch((err) => setError(err.message))
      .finally(() => setDetailLoading(false));
  }, [selectedId]);

  const items = data?.items || [];
  const selected = detail || items.find((item) => item.id === selectedId) || null;
  const counts = data?.counts || {};
  const gateSummary = selected?.run?.gate_summary;
  const hardFailures = gateSummary?.hard_failures || [];
  const softFailures = gateSummary?.soft_failures || [];
  const pendingCount = counts.pending_review || 0;
  const shadowCount = useMemo(() => items.filter((item) => item.run?.shadow_mode).length, [items]);

  return (
    <div style={{ minHeight: "100%", background: D.bg, padding: 24 }}>
      <AdminCommandHeader
        title="Autonomous Content Review"
        icon={Bot}
        actions={[{ key: "refresh", label: "Refresh", icon: RefreshCw, onClick: load, disabled: loading, variant: "secondary" }]}
      />

      {error && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: D.red, background: "#FEE2E2", border: `1px solid ${D.red}33`, borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <AlertTriangle size={16} strokeWidth={2} />
          <span style={{ fontSize: 13, fontWeight: 650 }}>{error}</span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
        <Kpi label="Pending Review" value={pendingCount} tone={pendingCount > 0 ? "amber" : "green"} />
        <Kpi label="Shadow Rows" value={shadowCount} />
        <Kpi label="Done" value={counts.done || 0} tone="green" />
        <Kpi label="Skipped" value={counts.skipped || 0} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(360px, 100%), 1fr))", gap: 16, alignItems: "start" }}>
        <section style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "14px 16px", borderBottom: `1px solid ${D.border}`, display: "flex", alignItems: "center", gap: 8 }}>
            <Search size={16} strokeWidth={2} />
            <div style={{ fontSize: 14, fontWeight: 800, color: D.heading }}>Queue</div>
          </div>
          {loading ? (
            <div style={{ padding: 32, color: D.muted, textAlign: "center" }}>Loading...</div>
          ) : items.length === 0 ? (
            <div style={{ padding: 32, color: D.muted, textAlign: "center" }}>No pending review rows.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 780 }}>
                <thead>
                  <tr>
                    {["Opportunity", "Action", "Score", "Gate", "Reason", "Updated"].map((h) => (
                      <th key={h} style={{ textAlign: "left", padding: "10px 12px", color: D.muted, fontSize: 12, fontWeight: 800, borderBottom: `1px solid ${D.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const active = item.id === selectedId;
                    const summary = item.run?.gate_summary;
                    return (
                      <tr
                        key={item.id}
                        onClick={() => setSelectedId(item.id)}
                        style={{ cursor: "pointer", background: active ? "#F8FAFC" : D.card }}
                      >
                        <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, verticalAlign: "top" }}>
                          <div style={{ color: D.heading, fontWeight: 750, fontSize: 13 }}>{item.target_keyword || item.query || item.target_url || "Untitled"}</div>
                          <div style={{ color: D.muted, fontSize: 12, marginTop: 4 }}>{[item.city, item.service, item.bucket].filter(Boolean).join(" / ")}</div>
                        </td>
                        <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, verticalAlign: "top" }}><Chip>{item.action_type}</Chip></td>
                        <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, fontFamily: MONO, fontSize: 13 }}>{item.final_score ?? item.score ?? "—"}</td>
                        <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}` }}>
                          <Chip tone={gateTone(summary)}>{summary?.quality_ok === true ? "Passed" : "Review"}</Chip>
                        </td>
                        <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, color: D.text, fontSize: 12 }}>{item.skip_reason || "—"}</td>
                        <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, color: D.muted, fontSize: 12 }}>{formatDate(item.updated_at || item.completed_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "14px 16px", borderBottom: `1px solid ${D.border}`, display: "flex", alignItems: "center", gap: 8 }}>
            <FileText size={16} strokeWidth={2} />
            <div style={{ fontSize: 14, fontWeight: 800, color: D.heading }}>Review Detail</div>
          </div>
          {!selected ? (
            <div style={{ padding: 24, color: D.muted, textAlign: "center" }}>Select a row.</div>
          ) : (
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, opacity: detailLoading ? 0.65 : 1 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 850, color: D.heading, lineHeight: 1.25 }}>{selected.draft?.title || selected.target_keyword || "Untitled review"}</div>
                <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <Chip>{selected.status}</Chip>
                  <Chip>{selected.action_type}</Chip>
                  {selected.run?.shadow_mode && <Chip tone="amber">shadow</Chip>}
                </div>
              </div>

              <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
                <Row label="Target" value={selected.target_url || "—"} />
                <Row label="Keyword" value={selected.target_keyword || "—"} />
                <Row label="Reason" value={selected.skip_reason || "—"} />
                <Row label="Run" value={selected.run?.outcome || "—"} />
              </div>

              <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 800, color: D.heading, marginBottom: 8 }}>
                  {hardFailures.length === 0 ? <CheckCircle2 size={16} color={D.green} /> : <AlertTriangle size={16} color={D.red} />}
                  Gate Summary
                </div>
                <div style={{ fontSize: 12, color: D.text, lineHeight: 1.6 }}>
                  Score: {gateSummary?.quality_score ?? "—"} / {gateSummary?.quality_min_score ?? "—"}
                  <br />
                  Hard: {hardFailures.length ? hardFailures.join(", ") : "none"}
                  <br />
                  Soft: {softFailures.length ? softFailures.join(", ") : "none"}
                </div>
              </div>

              {selected.draft?.meta_description && (
                <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 12 }}>
                  <div style={{ fontSize: 12, color: D.muted, fontWeight: 800, marginBottom: 4 }}>Meta</div>
                  <div style={{ fontSize: 13, color: D.text, lineHeight: 1.45 }}>{selected.draft.meta_description}</div>
                </div>
              )}

              {selected.draft?.body_preview && (
                <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 12 }}>
                  <div style={{ fontSize: 12, color: D.muted, fontWeight: 800, marginBottom: 4 }}>Draft Preview</div>
                  <div style={{ fontSize: 13, color: D.text, lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: 360, overflowY: "auto" }}>
                    {selected.draft.body || selected.draft.body_preview}
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "92px minmax(0, 1fr)", gap: 8 }}>
      <div style={{ color: D.muted, fontWeight: 750 }}>{label}</div>
      <div style={{ color: D.text, wordBreak: "break-word" }}>{value}</div>
    </div>
  );
}
