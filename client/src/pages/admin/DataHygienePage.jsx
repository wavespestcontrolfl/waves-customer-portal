import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, DatabaseZap, Eye, EyeOff, Play, RefreshCw, RotateCcw, ShieldAlert, XCircle } from "lucide-react";
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

const STATUSES = ["pending", "approved", "reverted", "rejected", "stale", "all"];

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

function fieldLabel(value) {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function valueText(value) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "object" && value.masked) return `${value.masked} (${value.length} chars)`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function statusTone(status) {
  if (status === "approved") return "green";
  if (status === "reverted") return "blue";
  if (status === "rejected" || status === "stale") return "red";
  return "amber";
}

function confidence(value) {
  if (value === null || value === undefined) return "-";
  return `${Math.round(Number(value) * 100)}%`;
}

function percent(value) {
  if (value === null || value === undefined) return "-";
  return `${Math.round(Number(value) * 100)}%`;
}

export default function DataHygienePage({ embedded = false } = {}) {
  const [status, setStatus] = useState("pending");
  const [data, setData] = useState({ proposals: [] });
  const [metrics, setMetrics] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [revealingId, setRevealingId] = useState("");
  const [revealed, setRevealed] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [next, nextMetrics] = await Promise.all([
        adminFetch(`/admin/data-hygiene/proposals?status=${encodeURIComponent(status)}&limit=100`),
        adminFetch("/admin/data-hygiene/metrics?days=30"),
      ]);
      setData(next);
      setMetrics(nextMetrics);
      setSelectedId((current) => (
        next.proposals?.some((p) => p.id === current) ? current : next.proposals?.[0]?.id || null
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
    () => data.proposals?.find((p) => p.id === selectedId) || data.proposals?.[0] || null,
    [data.proposals, selectedId]
  );

  useEffect(() => {
    setRevealed(null);
  }, [selectedId]);

  useEffect(() => {
    if (!revealed) return undefined;
    const timer = setTimeout(() => setRevealed(null), 60000);
    return () => clearTimeout(timer);
  }, [revealed]);

  const runScan = useCallback(async (mode) => {
    setScanning(true);
    setNotice("");
    setError("");
    try {
      const result = await adminFetch("/admin/data-hygiene/scan", {
        method: "POST",
        body: JSON.stringify({ mode, phases: ["extraction"] }),
      });
      setNotice(`Scan ${result.status}: run ${result.run_id || "-"}`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setScanning(false);
    }
  }, [load]);

  const approve = useCallback(async (proposal) => {
    if (!proposal) return;
    setBusyId(proposal.id);
    setError("");
    try {
      await adminFetch(`/admin/data-hygiene/proposals/${proposal.id}/approve`, { method: "POST", body: "{}" });
      setNotice("Proposal approved and applied.");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }, [load]);

  const reject = useCallback(async (proposal, reason = "other") => {
    if (!proposal) return;
    setBusyId(proposal.id);
    setError("");
    try {
      await adminFetch(`/admin/data-hygiene/proposals/${proposal.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      setNotice("Proposal rejected.");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }, [load]);

  const revert = useCallback(async (proposal) => {
    if (!proposal) return;
    if (!window.confirm("Revert this approved change and restore the previous value?")) return;
    setBusyId(proposal.id);
    setError("");
    try {
      await adminFetch(`/admin/data-hygiene/proposals/${proposal.id}/revert`, {
        method: "POST",
        body: "{}",
      });
      setNotice("Proposal reverted.");
      await load();
    } catch (err) {
      setError(err.status === 409 ? "Cannot revert because the live value changed after approval." : err.message);
    } finally {
      setBusyId("");
    }
  }, [load]);

  const reveal = useCallback(async (proposal) => {
    if (!proposal) return;
    if (revealed?.proposalId === proposal.id) {
      setRevealed(null);
      return;
    }
    setRevealingId(proposal.id);
    setError("");
    try {
      const result = await adminFetch(`/admin/data-hygiene/proposals/${proposal.id}/reveal`, {
        method: "POST",
        body: "{}",
      });
      setRevealed(result);
      setNotice("Sensitive value revealed. This access was audited.");
    } catch (err) {
      setError(err.message);
    } finally {
      setRevealingId("");
    }
  }, [revealed]);

  const pendingCount = data.proposals?.filter((p) => p.status === "pending").length || 0;

  return (
    <div style={{ minHeight: "100%", background: D.bg, color: D.text }}>
      {!embedded && (
        <AdminCommandHeader
          eyebrow="System"
          title="Data Hygiene"
          description="Review proposed cleanup from customer communications before it updates live property data."
          icon={DatabaseZap}
        />
      )}

      <div style={{ padding: 20, display: "grid", gap: 14 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                style={{
                  minHeight: 34,
                  padding: "0 12px",
                  borderRadius: 6,
                  border: `1px solid ${status === s ? D.heading : D.border}`,
                  background: status === s ? D.heading : D.card,
                  color: status === s ? "#fff" : D.text,
                  fontSize: 13,
                  fontWeight: 750,
                  cursor: "pointer",
                }}
              >
                {fieldLabel(s)}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="inline-flex items-center gap-2 h-9 px-3 rounded-sm border-hairline border-zinc-300 bg-white text-13 font-medium text-zinc-900" onClick={() => runScan("dry_run")} disabled={scanning}>
              <Play size={14} /> Dry Run
            </button>
            <button className="inline-flex items-center gap-2 h-9 px-3 rounded-sm border-hairline border-zinc-900 bg-zinc-900 text-13 font-medium text-white" onClick={() => runScan("manual")} disabled={scanning}>
              <RefreshCw size={14} /> Create Proposals
            </button>
          </div>
        </div>

        {error && <div style={{ border: `1px solid #FCA5A5`, background: "#FEF2F2", color: D.red, padding: 12, borderRadius: 8, fontSize: 13 }}>{error}</div>}
        {notice && <div style={{ border: `1px solid #BBF7D0`, background: "#F0FDF4", color: D.green, padding: 12, borderRadius: 8, fontSize: 13 }}>{notice}</div>}

        <MetricsPanel metrics={metrics} />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 14 }}>
          <section style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
            <div style={{ padding: 14, borderBottom: `1px solid ${D.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 850, color: D.heading }}>Proposals</div>
                <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{pendingCount} pending in current view</div>
              </div>
              <button type="button" onClick={load} disabled={loading} style={{ border: `1px solid ${D.border}`, background: D.card, borderRadius: 6, width: 34, height: 34, cursor: "pointer" }} aria-label="Refresh">
                <RefreshCw size={15} />
              </button>
            </div>
            <div style={{ maxHeight: "calc(100vh - 260px)", overflow: "auto" }}>
              {loading ? (
                <div style={{ padding: 18, color: D.muted, fontSize: 13 }}>Loading...</div>
              ) : data.proposals?.length ? data.proposals.map((proposal) => (
                <button
                  key={proposal.id}
                  type="button"
                  onClick={() => setSelectedId(proposal.id)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: proposal.id === selected?.id ? "#FAFAFA" : D.card,
                    border: "none",
                    borderBottom: `1px solid ${D.border}`,
                    padding: 14,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ fontSize: 13, fontWeight: 850, color: D.heading, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {proposal.customer?.name || proposal.customer?.phone || "Unknown customer"}
                    </div>
                    <Chip tone={statusTone(proposal.status)}>{proposal.status}</Chip>
                  </div>
                  <div style={{ fontSize: 12, color: D.muted, marginTop: 6 }}>{fieldLabel(proposal.field)} · {confidence(proposal.confidence)}</div>
                  <div style={{ fontSize: 12, color: D.text, marginTop: 6, overflowWrap: "anywhere" }}>{valueText(proposal.proposedValue)}</div>
                </button>
              )) : (
                <div style={{ padding: 18, color: D.muted, fontSize: 13 }}>No proposals found.</div>
              )}
            </div>
          </section>

          <section style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 16, minHeight: 360 }}>
            {selected ? (
              <div style={{ display: "grid", gap: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start" }}>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 850, color: D.heading }}>{fieldLabel(selected.field)}</div>
                    <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>{selected.customer?.name || selected.scopeId}</div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    {selected.isSensitive && <Chip tone="amber"><ShieldAlert size={13} style={{ marginRight: 4 }} /> Sensitive</Chip>}
                    <Chip tone={statusTone(selected.status)}>{selected.status}</Chip>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <Info label="Current" value={valueText(selected.currentValue)} />
                  <Info label="Proposed" value={valueText(selected.proposedValue)} />
                  <Info label="Source" value={selected.source} />
                  <Info label="Confidence" value={confidence(selected.confidence)} />
                </div>

                {selected.isSensitive && (
                  <div style={{ border: `1px solid ${D.border}`, borderRadius: 8, padding: 12, background: "#FFFBEB" }}>
                    <div style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 850, color: D.amber }}>Sensitive value</div>
                        <div style={{ fontSize: 12, color: D.muted, marginTop: 3 }}>
                          Reveal decrypts the vault value and writes an audit event.
                        </div>
                      </div>
                      <button
                        className="inline-flex items-center gap-2 h-9 px-3 rounded-sm border-hairline border-amber-700 bg-white text-13 font-medium text-amber-800"
                        onClick={() => reveal(selected)}
                        disabled={revealingId === selected.id}
                      >
                        {revealed?.proposalId === selected.id ? <EyeOff size={14} /> : <Eye size={14} />}
                        {revealed?.proposalId === selected.id ? "Hide" : "Reveal"}
                      </button>
                    </div>
                    {revealed?.proposalId === selected.id && (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
                        <Info label="Raw Current" value={valueText(revealed.currentValue)} />
                        <Info label="Raw Proposed" value={valueText(revealed.proposedValue)} />
                      </div>
                    )}
                  </div>
                )}

                <div style={{ border: `1px solid ${D.border}`, borderRadius: 8, padding: 12, background: "#FAFAFA" }}>
                  <div style={{ fontSize: 11, color: D.muted, fontWeight: 850, textTransform: "uppercase" }}>Evidence</div>
                  <div style={{ fontSize: 13, color: D.text, lineHeight: 1.5, marginTop: 8 }}>
                    {selected.evidence?.source_excerpt || "No excerpt available."}
                  </div>
                  <div style={{ fontSize: 12, color: D.muted, marginTop: 8 }}>
                    {selected.evidence?.channel || "-"} · {selected.evidence?.matched_label || "-"}
                  </div>
                </div>

                {selected.status === "pending" && (
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button className="inline-flex items-center gap-2 h-9 px-3 rounded-sm border-hairline border-zinc-300 bg-white text-13 font-medium text-zinc-900" onClick={() => reject(selected, "bad_parse")} disabled={busyId === selected.id}>
                      <XCircle size={14} /> Reject
                    </button>
                    <button className="inline-flex items-center gap-2 h-9 px-3 rounded-sm border-hairline border-zinc-900 bg-zinc-900 text-13 font-medium text-white" onClick={() => approve(selected)} disabled={busyId === selected.id}>
                      <CheckCircle2 size={14} /> Approve
                    </button>
                  </div>
                )}
                {selected.status === "approved" && (
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button className="inline-flex items-center gap-2 h-9 px-3 rounded-sm border-hairline border-zinc-300 bg-white text-13 font-medium text-zinc-900" onClick={() => revert(selected)} disabled={busyId === selected.id}>
                      <RotateCcw size={14} /> Revert
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ color: D.muted, fontSize: 13 }}>Select a proposal.</div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function MetricsPanel({ metrics }) {
  const topField = metrics?.byField?.[0];
  const topLabel = metrics?.byMatchedLabel?.[0];
  const topVersion = metrics?.byExtractorVersion?.[0];
  const rejected = metrics?.statusCounts?.rejected || 0;
  const approved = metrics?.statusCounts?.approved || 0;

  return (
    <section style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
      <div style={{ padding: 14, borderBottom: `1px solid ${D.border}`, display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 850, color: D.heading }}>Quality Signals</div>
          <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>Last {metrics?.days || 30} days</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <Chip tone="green">{approved} approved</Chip>
          <Chip tone={rejected ? "red" : "neutral"}>{rejected} rejected</Chip>
        </div>
      </div>
      <div style={{ padding: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 12 }}>
        <MetricCard title="Noisiest field" bucket={topField} />
        <MetricCard title="Noisiest label" bucket={topLabel} />
        <MetricCard title="Extractor" bucket={topVersion} />
      </div>
      <div style={{ padding: "0 14px 14px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 12 }}>
        <MetricTable title="By field" rows={metrics?.byField || []} keyLabel="Field" />
        <MetricTable title="By label" rows={metrics?.byMatchedLabel || []} keyLabel="Label" />
      </div>
      <div style={{ padding: "0 14px 14px" }}>
        <div style={{ border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: 12, borderBottom: `1px solid ${D.border}`, fontSize: 13, fontWeight: 850, color: D.heading }}>Rejected excerpts</div>
          {metrics?.topRejected?.length ? metrics.topRejected.map((row) => (
            <div key={row.id} style={{ padding: 12, borderBottom: `1px solid ${D.border}`, display: "grid", gap: 6 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <Chip tone="red">{fieldLabel(row.field)}</Chip>
                <span style={{ fontSize: 12, color: D.muted }}>{row.matchedLabel || "unknown"} · {row.extractorVersion || "unknown"} · {row.rejectReason || "rejected"}</span>
              </div>
              <div style={{ fontSize: 13, color: D.text, lineHeight: 1.45, overflowWrap: "anywhere" }}>
                {row.sourceExcerpt || "No excerpt available."}
              </div>
            </div>
          )) : (
            <div style={{ padding: 12, color: D.muted, fontSize: 13 }}>No rejected excerpts in this window.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function MetricCard({ title, bucket }) {
  return (
    <div style={{ border: `1px solid ${D.border}`, borderRadius: 8, padding: 12, minHeight: 92 }}>
      <div style={{ fontSize: 11, color: D.muted, fontWeight: 850, textTransform: "uppercase" }}>{title}</div>
      <div style={{ fontSize: 16, fontWeight: 850, color: D.heading, marginTop: 8, overflowWrap: "anywhere" }}>{bucket?.key ? fieldLabel(bucket.key) : "-"}</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8, fontSize: 12, color: D.muted }}>
        <span>{bucket?.total || 0} total</span>
        <span>{percent(bucket?.rejectionRate)} rejected</span>
      </div>
    </div>
  );
}

function MetricTable({ title, rows, keyLabel }) {
  return (
    <div style={{ border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
      <div style={{ padding: 12, borderBottom: `1px solid ${D.border}`, fontSize: 13, fontWeight: 850, color: D.heading }}>{title}</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ color: D.muted, textAlign: "left" }}>
              <th style={{ padding: 10, fontWeight: 850 }}>{keyLabel}</th>
              <th style={{ padding: 10, fontWeight: 850 }}>Total</th>
              <th style={{ padding: 10, fontWeight: 850 }}>Approved</th>
              <th style={{ padding: 10, fontWeight: 850 }}>Rejected</th>
              <th style={{ padding: 10, fontWeight: 850 }}>Reject %</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 6).map((row) => (
              <tr key={row.key} style={{ borderTop: `1px solid ${D.border}` }}>
                <td style={{ padding: 10, color: D.heading, fontWeight: 750, overflowWrap: "anywhere" }}>{fieldLabel(row.key)}</td>
                <td style={{ padding: 10 }}>{row.total}</td>
                <td style={{ padding: 10 }}>{row.approved}</td>
                <td style={{ padding: 10 }}>{row.rejected}</td>
                <td style={{ padding: 10 }}>{percent(row.rejectionRate)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={5} style={{ padding: 12, color: D.muted }}>No metrics yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div style={{ border: `1px solid ${D.border}`, borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 11, color: D.muted, fontWeight: 850, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 13, color: D.text, marginTop: 6, overflowWrap: "anywhere" }}>{value || "-"}</div>
    </div>
  );
}
