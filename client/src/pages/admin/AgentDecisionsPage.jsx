import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, CheckCircle2, ClipboardList, Edit3, MessageSquare, PhoneCall, RefreshCw, Save, ShieldAlert, UserRound, XCircle } from "lucide-react";
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

function percent(value) {
  const number = Number(value || 0);
  return `${Math.round(number * 100)}%`;
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

function Field({ label, value }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div>
      <div style={{ fontSize: 11, color: D.muted, fontWeight: 800 }}>{label}</div>
      <div style={{ fontSize: 13, color: D.text, lineHeight: 1.35 }}>{String(value)}</div>
    </div>
  );
}

function Panel({ icon: Icon, title, children }) {
  return (
    <section style={{ display: "grid", gap: 10, border: `1px solid ${D.border}`, borderRadius: 8, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: D.muted, fontWeight: 850 }}>
        {Icon && <Icon size={16} />}
        {title}
      </div>
      {children}
    </section>
  );
}

export default function AgentDecisionsPage() {
  const [status, setStatus] = useState("pending_review");
  const [data, setData] = useState({ decisions: [], metrics: null });
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [correctionNote, setCorrectionNote] = useState("");
  const [correctedActions, setCorrectedActions] = useState("");
  const [idealReply, setIdealReply] = useState("");
  const [actualReply, setActualReply] = useState("");
  const [replyReviewNote, setReplyReviewNote] = useState("");
  const [replyScenarioLabel, setReplyScenarioLabel] = useState("");

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

  useEffect(() => {
    if (!selected?.id) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    adminFetch(`/admin/agent-decisions/${selected.id}/context`)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((err) => {
        if (!cancelled) setDetail({ error: err.message });
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [selected?.id]);

  useEffect(() => {
    const training = detail?.replyTraining;
    const humanReply = detail?.context?.actualHumanReply?.body || "";
    setActualReply(training?.actualHumanReply || humanReply || "");
    setIdealReply(training?.outboundBody || selected?.suggestedMessage || humanReply || "");
    setReplyReviewNote(training?.reviewNote || "");
    setReplyScenarioLabel(training?.scenarioLabel || "");
  }, [detail?.replyTraining?.id, detail?.context?.actualHumanReply?.id, selected?.id, selected?.suggestedMessage]);

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

  const saveReplyTraining = useCallback(async (decision, replyVerdict) => {
    if (!decision) return;
    setBusyId(`${decision.id}:reply`);
    setError("");
    setNotice("");
    try {
      const finalReply = replyVerdict === "accepted"
        ? (idealReply.trim() || decision.suggestedMessage || "")
        : replyVerdict === "no_reply_needed"
          ? ""
          : idealReply;
      const next = await adminFetch(`/admin/agent-decisions/${decision.id}/reply-training`, {
        method: "POST",
        body: JSON.stringify({
          replyVerdict,
          finalReply,
          actualReply,
          reviewNote: replyReviewNote,
          scenarioLabel: replyScenarioLabel,
        }),
      });
      setDetail((current) => ({ ...(current || {}), replyTraining: next.replyTraining }));
      setNotice(`Reply training ${statusLabel(replyVerdict).toLowerCase()} saved.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }, [actualReply, idealReply, replyReviewNote, replyScenarioLabel]);

  const metrics = data.metrics || {};
  const replyMetrics = metrics.replyTraining || {};
  const replyVerdicts = replyMetrics.verdicts || {};
  const replyRates = replyMetrics.rates || {};

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

        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10 }}>
          {[
            ["Pending", metrics.pending || 0],
            ["Accepted", metrics.accepted || 0],
            ["Corrected", metrics.corrected || 0],
            ["Dismissed", metrics.dismissed || 0],
            ["Reply Examples", metrics.replyTraining?.reviewed || 0],
          ].map(([label, value]) => (
            <div key={label} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 12, color: D.muted, fontWeight: 750 }}>{label}</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: D.heading }}>{value}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1.2fr 1fr", gap: 12, alignItems: "start" }}>
          <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 14, display: "grid", gap: 10 }}>
            <div style={{ fontSize: 12, color: D.muted, fontWeight: 850 }}>Reply Quality</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
              {[
                ["Accept", replyVerdicts.accepted || 0, replyRates.accepted, D.green],
                ["Edit", replyVerdicts.edited || 0, replyRates.edited, D.blue],
                ["Reject", replyVerdicts.rejected || 0, replyRates.rejected, D.red],
                ["No Reply", replyVerdicts.noReplyNeeded || 0, replyRates.noReplyNeeded, D.amber],
              ].map(([label, count, rate, color]) => (
                <div key={label} style={{ border: `1px solid ${D.border}`, borderRadius: 8, padding: 10 }}>
                  <div style={{ color: D.muted, fontSize: 11, fontWeight: 800 }}>{label}</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <strong style={{ color, fontSize: 22 }}>{count}</strong>
                    <span style={{ color: D.muted, fontSize: 12 }}>{percent(rate)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 14, display: "grid", gap: 10 }}>
            <div style={{ fontSize: 12, color: D.muted, fontWeight: 850 }}>By Workflow</div>
            {replyMetrics.byWorkflow?.length ? (
              <div style={{ display: "grid", gap: 8 }}>
                {replyMetrics.byWorkflow.map((row) => (
                  <div key={row.workflow} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", gap: 10, alignItems: "center", fontSize: 13 }}>
                    <div style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 750 }}>{row.workflow}</div>
                    <span style={{ color: D.muted }}>{row.reviewed} reviewed</span>
                    <span style={{ color: row.rejectedRate > 0.15 ? D.red : D.green, fontWeight: 800 }}>{percent(row.acceptanceRate)} accept</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: D.muted, fontSize: 13 }}>No reviewed reply examples yet.</div>
            )}
          </div>

          <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 14, display: "grid", gap: 10 }}>
            <div style={{ fontSize: 12, color: D.muted, fontWeight: 850 }}>Top Scenarios</div>
            {replyMetrics.byScenario?.length ? (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {replyMetrics.byScenario.map((row) => (
                  <Chip key={row.scenarioLabel}>{actionLabel(row.scenarioLabel)} · {row.count}</Chip>
                ))}
              </div>
            ) : (
              <div style={{ color: D.muted, fontSize: 13 }}>No scenario labels yet.</div>
            )}
          </div>
        </div>

        {replyMetrics.recentRejected?.length ? (
          <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 14, display: "grid", gap: 10 }}>
            <div style={{ fontSize: 12, color: D.muted, fontWeight: 850 }}>Recent Rejected Drafts</div>
            <div style={{ display: "grid", gap: 8 }}>
              {replyMetrics.recentRejected.map((row) => (
                <div key={row.id} style={{ display: "grid", gap: 4, borderTop: `1px solid ${D.border}`, paddingTop: 8 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12, color: D.muted, fontWeight: 800 }}>
                    <Chip tone="red">Rejected</Chip>
                    <span>{row.customerName || "Unknown customer"}</span>
                    <span>{row.workflow}</span>
                    {row.scenarioLabel && <span>{actionLabel(row.scenarioLabel)}</span>}
                    <span>{timeLabel(row.reviewedAt)}</span>
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.35 }}>{row.inboundBody || "-"}</div>
                  {row.reviewNote && <div style={{ color: D.muted, fontSize: 13, lineHeight: 1.35 }}>{row.reviewNote}</div>}
                </div>
              ))}
            </div>
          </div>
        ) : null}

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

                <Panel icon={MessageSquare} title="Conversation Context">
                  {detailLoading ? (
                    <div style={{ color: D.muted }}>Loading thread...</div>
                  ) : detail?.context?.smsThread?.length ? (
                    <div style={{ display: "grid", gap: 8 }}>
                      {detail.context.smsThread.map((msg) => (
                        <div key={msg.id} style={{
                          display: "grid",
                          gap: 4,
                          padding: 10,
                          borderRadius: 8,
                          background: msg.isTrigger ? "#FEF3C7" : D.bg,
                          border: `1px solid ${msg.isTrigger ? "#F59E0B" : D.border}`,
                        }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: D.muted, fontWeight: 800 }}>
                            <span>{msg.direction === "inbound" ? "Customer" : "Waves"}</span>
                            <span>{timeLabel(msg.createdAt)}</span>
                            {msg.type && <span>{msg.type}</span>}
                            {msg.isTrigger && <Chip tone="amber">Trigger</Chip>}
                          </div>
                          <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{msg.body || "-"}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ color: D.muted }}>No recent SMS thread found.</div>
                  )}
                </Panel>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <Panel icon={UserRound} title="Customer / Lead / Estimate">
                    {detail?.error ? (
                      <div style={{ color: D.red }}>{detail.error}</div>
                    ) : (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                        <Field label="Customer" value={[detail?.context?.customer?.first_name, detail?.context?.customer?.last_name].filter(Boolean).join(" ") || selected.customerName} />
                        <Field label="Phone" value={detail?.context?.customer?.phone || selected.customerPhone || selected.sourceFromPhone} />
                        <Field label="Address" value={detail?.context?.customer?.address_line1 || detail?.context?.estimate?.address} />
                        <Field label="City" value={detail?.context?.customer?.city} />
                        <Field label="WaveGuard" value={detail?.context?.customer?.waveguard_tier || detail?.context?.estimate?.waveguard_tier} />
                        <Field label="Lead Status" value={detail?.context?.lead?.status || selected.leadStatus} />
                        <Field label="Estimate Status" value={detail?.context?.estimate?.status || selected.estimateStatus} />
                        <Field label="Service Interest" value={detail?.context?.lead?.service_interest || detail?.context?.estimate?.service_interest} />
                      </div>
                    )}
                  </Panel>

                  <Panel icon={PhoneCall} title="Recent Calls">
                    {detailLoading ? (
                      <div style={{ color: D.muted }}>Loading calls...</div>
                    ) : detail?.context?.calls?.length ? (
                      <div style={{ display: "grid", gap: 8 }}>
                        {detail.context.calls.map((call) => (
                          <div key={call.id} style={{ display: "grid", gap: 4, borderBottom: `1px solid ${D.border}`, paddingBottom: 8 }}>
                            <div style={{ display: "flex", gap: 8, color: D.muted, fontSize: 12, fontWeight: 800 }}>
                              <span>{call.direction || "call"}</span>
                              <span>{timeLabel(call.createdAt)}</span>
                              {call.outcome && <span>{call.outcome}</span>}
                            </div>
                            <div style={{ fontSize: 13, lineHeight: 1.4 }}>{call.synopsis || call.transcription || call.notes || "-"}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ color: D.muted }}>No recent calls found.</div>
                    )}
                  </Panel>
                </div>

                <Panel icon={ClipboardList} title="Recent Service Context">
                  {detailLoading ? (
                    <div style={{ color: D.muted }}>Loading services...</div>
                  ) : detail?.context?.services?.length ? (
                    <div style={{ display: "grid", gap: 8 }}>
                      {detail.context.services.map((service) => (
                        <div key={service.id} style={{ display: "grid", gap: 4, borderBottom: `1px solid ${D.border}`, paddingBottom: 8 }}>
                          <div style={{ display: "flex", gap: 8, color: D.muted, fontSize: 12, fontWeight: 800 }}>
                            <span>{service.serviceType}</span>
                            <span>{service.serviceDate || timeLabel(service.createdAt)}</span>
                            <span>{service.status}</span>
                          </div>
                          <div style={{ fontSize: 13, lineHeight: 1.4 }}>{service.technicianNotes || "-"}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ color: D.muted }}>No recent service records found.</div>
                  )}
                </Panel>

                <section style={{ display: "grid", gap: 8 }}>
                  <div style={{ fontSize: 12, color: D.muted, fontWeight: 800 }}>Suggested Reply</div>
                  <div style={{ background: D.bg, borderRadius: 8, padding: 12, lineHeight: 1.45 }}>{selected.suggestedMessage || "-"}</div>
                </section>

                <Panel icon={MessageSquare} title="Reply Training">
                  <div style={{ display: "grid", gap: 10 }}>
                    {detail?.replyTraining && (
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <Chip tone="green">Saved</Chip>
                        {detail.replyTraining.replyVerdict && <Chip tone={detail.replyTraining.replyVerdict === "rejected" ? "red" : detail.replyTraining.replyVerdict === "accepted" ? "green" : "blue"}>{statusLabel(detail.replyTraining.replyVerdict)}</Chip>}
                        {detail.replyTraining.scenarioLabel && <Chip>{actionLabel(detail.replyTraining.scenarioLabel)}</Chip>}
                        <span style={{ color: D.muted, fontSize: 12 }}>
                          {detail.replyTraining.reviewedBy ? `Reviewed by ${detail.replyTraining.reviewedBy}` : "Reviewed"}
                          {detail.replyTraining.reviewedAt ? ` · ${timeLabel(detail.replyTraining.reviewedAt)}` : ""}
                        </span>
                      </div>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <section style={{ display: "grid", gap: 6 }}>
                        <div style={{ fontSize: 11, color: D.muted, fontWeight: 800 }}>Actual Human Reply</div>
                        <textarea
                          value={actualReply}
                          onChange={(event) => setActualReply(event.target.value)}
                          rows={5}
                          placeholder="If you replied, paste or adjust the actual reply here."
                          style={{ width: "100%", resize: "vertical", border: `1px solid ${D.border}`, borderRadius: 8, padding: 10, font: "inherit", boxSizing: "border-box" }}
                        />
                      </section>
                      <section style={{ display: "grid", gap: 6 }}>
                        <div style={{ fontSize: 11, color: D.muted, fontWeight: 800 }}>Final / Rewrite Reply</div>
                        <textarea
                          value={idealReply}
                          onChange={(event) => setIdealReply(event.target.value)}
                          rows={5}
                          placeholder="Accepted draft, edited version, or your replacement reply."
                          style={{ width: "100%", resize: "vertical", border: `1px solid ${D.border}`, borderRadius: 8, padding: 10, font: "inherit", boxSizing: "border-box" }}
                        />
                      </section>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 260px) 1fr", gap: 10 }}>
                      <input
                        value={replyScenarioLabel}
                        onChange={(event) => setReplyScenarioLabel(event.target.value)}
                        placeholder="scenario, e.g. scheduling"
                        style={{ width: "100%", border: `1px solid ${D.border}`, borderRadius: 8, padding: "0 10px", font: "inherit", minHeight: 38, boxSizing: "border-box" }}
                      />
                      <input
                        value={replyReviewNote}
                        onChange={(event) => setReplyReviewNote(event.target.value)}
                        placeholder="What should the agent learn from this reply?"
                        style={{ width: "100%", border: `1px solid ${D.border}`, borderRadius: 8, padding: "0 10px", font: "inherit", minHeight: 38, boxSizing: "border-box" }}
                      />
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        disabled={!!busyId || !(idealReply.trim() || selected.suggestedMessage)}
                        onClick={() => saveReplyTraining(selected, "accepted")}
                        style={actionButton(D.green)}
                      >
                        <CheckCircle2 size={16} />
                        Accept Draft
                      </button>
                      <button
                        type="button"
                        disabled={!!busyId || !idealReply.trim()}
                        onClick={() => saveReplyTraining(selected, "edited")}
                        style={actionButton(D.blue)}
                      >
                        <Edit3 size={16} />
                        Edit & Save
                      </button>
                      <button
                        type="button"
                        disabled={!!busyId || !idealReply.trim()}
                        onClick={() => saveReplyTraining(selected, "rejected")}
                        style={actionButton(D.red)}
                      >
                        <XCircle size={16} />
                        Reject & Rewrite
                      </button>
                      <button
                        type="button"
                        disabled={!!busyId}
                        onClick={() => saveReplyTraining(selected, "no_reply_needed")}
                        style={actionButton(D.amber)}
                      >
                        <Save size={16} />
                        No Reply Needed
                      </button>
                    </div>
                  </div>
                </Panel>

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
