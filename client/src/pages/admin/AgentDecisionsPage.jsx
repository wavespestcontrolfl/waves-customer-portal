import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, CheckCircle2, Edit3, RefreshCw, ShieldAlert, XCircle } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { adminFetch } from "../../utils/admin-fetch";

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
  blue: "#1D4ED8",
};

const STATUSES = ["pending_review", "accepted", "corrected", "dismissed", "all"];

function Chip({ children, tone = "neutral" }) {
  const colors = {
    green: { bg: "#DCFCE7", fg: D.green },
    amber: { bg: "#FEF3C7", fg: D.amber },
    red: { bg: "#FEE2E2", fg: D.red },
    blue: { bg: "#DBEAFE", fg: D.blue },
    neutral: { bg: D.bg, fg: D.text },
  }[tone] || { bg: D.bg, fg: D.text };
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      minHeight: 24,
      padding: "0 8px",
      borderRadius: 6,
      background: colors.bg,
      color: colors.fg,
      fontSize: 12,
      fontWeight: 750,
      whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
}

function statusLabel(value) {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function statusTone(value) {
  if (value === "accepted") return "green";
  if (value === "corrected") return "blue";
  if (value === "dismissed") return "red";
  return "amber";
}

function actionLabel(value) {
  return String(value || "").replace(/_/g, " ");
}

function confidence(value) {
  if (value === null || value === undefined) return "-";
  return `${Math.round(Number(value) * 100)}%`;
}

function shortId(value) {
  return value ? String(value).slice(0, 8) : "-";
}

function timeLabel(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function TextList({ items = [], empty = "-" }) {
  if (!items.length) return <span style={{ color: D.muted }}>{empty}</span>;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {items.map((item) => <Chip key={item}>{actionLabel(item)}</Chip>)}
    </div>
  );
}

export default function AgentDecisionsPage() {
  const [status, setStatus] = useState("pending_review");
  const [data, setData] = useState({ decisions: [], metrics: null });
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [correctionNote, setCorrectionNote] = useState("");
  const [correctedActions, setCorrectedActions] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await adminFetch(`/admin/agent-decisions?status=${encodeURIComponent(status)}&limit=100`);
      setData(next);
      setSelectedId((current) => (
        next.decisions?.some((d) => d.id === current) ? current : next.decisions?.[0]?.id || null
      ));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const selected = useMemo(
    () => data.decisions?.find((d) => d.id === selectedId) || data.decisions?.[0] || null,
    [data.decisions, selectedId]
  );

  useEffect(() => {
    setCorrectionNote("");
    setCorrectedActions(selected?.recommendedActions?.join("\n") || "");
  }, [selected?.id]);

  const review = useCallback(async (decision, verdict) => {
    if (!decision) return;
    setBusyId(decision.id);
    setError("");
    setNotice("");
    try {
      const body = { verdict };
      if (verdict === "corrected") {
        body.correctedActions = correctedActions
          .split(/\n|,/)
          .map((item) => item.trim())
          .filter(Boolean);
        body.correctionNote = correctionNote;
      } else if (correctionNote.trim()) {
        body.correctionNote = correctionNote;
      }
      await adminFetch(`/admin/agent-decisions/${decision.id}/review`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setNotice(`Decision ${statusLabel(verdict).toLowerCase()}.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }, [correctedActions, correctionNote, load]);

  const metrics = data.metrics || {};

  return (
    <div style={{ minHeight: "100%", background: D.bg, color: D.text }}>
      <AdminCommandHeader
        title="Agent Review"
        subtitle="Shadow decisions from customer communication agents."
        icon={Bot}
      />

      <div style={{ padding: "0 24px 32px", display: "grid", gap: 16 }}>
        {data.missingTable && (
          <div style={{ background: "#FEF3C7", border: `1px solid ${D.amber}`, color: D.amber, borderRadius: 8, padding: 12, display: "flex", gap: 8, alignItems: "center" }}>
            <ShieldAlert size={18} />
            Run the agent_decisions migration before review data can be recorded.
          </div>
        )}

        {(notice || error) && (
          <div style={{
            background: error ? "#FEE2E2" : "#DCFCE7",
            border: `1px solid ${error ? D.red : D.green}`,
            color: error ? D.red : D.green,
            borderRadius: 8,
            padding: 12,
          }}>
            {error || notice}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
          {[
            ["Pending", metrics.pending || 0],
            ["Accepted", metrics.accepted || 0],
            ["Corrected", metrics.corrected || 0],
            ["Dismissed", metrics.dismissed || 0],
          ].map(([label, value]) => (
            <div key={label} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 12, color: D.muted, fontWeight: 750 }}>{label}</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: D.heading }}>{value}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {STATUSES.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setStatus(item)}
              style={{
                height: 36,
                borderRadius: 6,
                border: `1px solid ${status === item ? D.heading : D.border}`,
                background: status === item ? D.heading : D.card,
                color: status === item ? "#fff" : D.text,
                padding: "0 12px",
                fontWeight: 750,
                cursor: "pointer",
              }}
            >
              {statusLabel(item)}
            </button>
          ))}
          <button
            type="button"
            onClick={load}
            disabled={loading}
            style={{ marginLeft: "auto", height: 36, borderRadius: 6, border: `1px solid ${D.border}`, background: D.card, color: D.text, padding: "0 12px", fontWeight: 750, display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
          >
            <RefreshCw size={16} />
            Refresh
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 380px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
          <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
            {loading ? (
              <div style={{ padding: 18, color: D.muted }}>Loading decisions...</div>
            ) : data.decisions?.length ? (
              data.decisions.map((decision) => (
                <button
                  key={decision.id}
                  type="button"
                  onClick={() => setSelectedId(decision.id)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    border: 0,
                    borderBottom: `1px solid ${D.border}`,
                    background: selected?.id === decision.id ? "#F8FAFC" : D.card,
                    padding: 14,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <Chip tone={statusTone(decision.status)}>{statusLabel(decision.status)}</Chip>
                    <span style={{ marginLeft: "auto", color: D.muted, fontSize: 12 }}>{timeLabel(decision.createdAt)}</span>
                  </div>
                  <div style={{ fontWeight: 850, color: D.heading }}>{decision.customerName || "Unknown customer"}</div>
                  <div style={{ color: D.muted, fontSize: 13, marginTop: 2 }}>{statusLabel(decision.detectedIntent)} · {confidence(decision.confidence)}</div>
                  <div style={{ color: D.text, fontSize: 13, marginTop: 8, lineHeight: 1.35 }}>
                    {decision.inboundMessage || "No message body"}
                  </div>
                </button>
              ))
            ) : (
              <div style={{ padding: 18, color: D.muted }}>No decisions found.</div>
            )}
          </div>

          <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 18, minHeight: 480 }}>
            {!selected ? (
              <div style={{ color: D.muted }}>Select a decision to review.</div>
            ) : (
              <div style={{ display: "grid", gap: 18 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Chip tone={statusTone(selected.status)}>{statusLabel(selected.status)}</Chip>
                  <Chip tone="blue">{selected.mode}</Chip>
                  <Chip>{selected.workflow}</Chip>
                  <span style={{ marginLeft: "auto", color: D.muted, fontSize: 12 }}>Decision {shortId(selected.id)}</span>
                </div>

                <section>
                  <h2 style={{ margin: 0, fontSize: 20, color: D.heading }}>{selected.customerName || "Unknown customer"}</h2>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                    <Chip>Intent: {statusLabel(selected.detectedIntent)}</Chip>
                    <Chip>Confidence: {confidence(selected.confidence)}</Chip>
                    {selected.estimateId && <Chip>Estimate {shortId(selected.estimateId)} · {selected.estimateStatus || "-"}</Chip>}
                    {selected.leadId && <Chip>Lead {shortId(selected.leadId)} · {selected.leadStatus || "-"}</Chip>}
                  </div>
                </section>

                <section style={{ display: "grid", gap: 8 }}>
                  <div style={{ fontSize: 12, color: D.muted, fontWeight: 800 }}>Inbound Message</div>
                  <div style={{ background: D.bg, borderRadius: 8, padding: 12, lineHeight: 1.45 }}>{selected.inboundMessage || "-"}</div>
                </section>

                <section style={{ display: "grid", gap: 8 }}>
                  <div style={{ fontSize: 12, color: D.muted, fontWeight: 800 }}>Suggested Reply</div>
                  <div style={{ background: D.bg, borderRadius: 8, padding: 12, lineHeight: 1.45 }}>{selected.suggestedMessage || "-"}</div>
                </section>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <section style={{ display: "grid", gap: 8 }}>
                    <div style={{ fontSize: 12, color: D.muted, fontWeight: 800 }}>Recommended Actions</div>
                    <TextList items={selected.recommendedActions} />
                  </section>
                  <section style={{ display: "grid", gap: 8 }}>
                    <div style={{ fontSize: 12, color: D.muted, fontWeight: 800 }}>Allowed In Future</div>
                    <TextList items={selected.autoActionsAllowed} />
                  </section>
                  <section style={{ display: "grid", gap: 8 }}>
                    <div style={{ fontSize: 12, color: D.muted, fontWeight: 800 }}>Blocked Actions</div>
                    <TextList items={selected.blockedActions} />
                  </section>
                  <section style={{ display: "grid", gap: 8 }}>
                    <div style={{ fontSize: 12, color: D.muted, fontWeight: 800 }}>Safety Flags</div>
                    <TextList items={selected.safetyFlags} />
                  </section>
                </div>

                <section style={{ display: "grid", gap: 8 }}>
                  <div style={{ fontSize: 12, color: D.muted, fontWeight: 800 }}>Reasoning</div>
                  <div style={{ color: D.text, lineHeight: 1.45 }}>{selected.reasoningSummary || "-"}</div>
                </section>

                <section style={{ display: "grid", gap: 10, borderTop: `1px solid ${D.border}`, paddingTop: 16 }}>
                  <div style={{ fontSize: 12, color: D.muted, fontWeight: 800 }}>Correction</div>
                  <textarea
                    value={correctedActions}
                    onChange={(event) => setCorrectedActions(event.target.value)}
                    rows={4}
                    style={{ width: "100%", resize: "vertical", border: `1px solid ${D.border}`, borderRadius: 8, padding: 10, font: "inherit", boxSizing: "border-box" }}
                  />
                  <textarea
                    value={correctionNote}
                    onChange={(event) => setCorrectionNote(event.target.value)}
                    rows={3}
                    placeholder="Why was this accepted, corrected, or dismissed?"
                    style={{ width: "100%", resize: "vertical", border: `1px solid ${D.border}`, borderRadius: 8, padding: 10, font: "inherit", boxSizing: "border-box" }}
                  />
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" disabled={!!busyId} onClick={() => review(selected, "accepted")} style={actionButton(D.green)}>
                      <CheckCircle2 size={16} />
                      Accept
                    </button>
                    <button type="button" disabled={!!busyId} onClick={() => review(selected, "corrected")} style={actionButton(D.blue)}>
                      <Edit3 size={16} />
                      Correct
                    </button>
                    <button type="button" disabled={!!busyId} onClick={() => review(selected, "dismissed")} style={actionButton(D.red)}>
                      <XCircle size={16} />
                      Dismiss
                    </button>
                  </div>
                </section>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function actionButton(color) {
  return {
    height: 38,
    borderRadius: 6,
    border: `1px solid ${color}`,
    background: color,
    color: "#fff",
    padding: "0 12px",
    fontWeight: 800,
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    cursor: "pointer",
  };
}
