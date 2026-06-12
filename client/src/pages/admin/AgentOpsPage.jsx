import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  Bot,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  DollarSign,
  ExternalLink,
  Megaphone,
  MessageSquare,
  RefreshCw,
  Route as RouteIcon,
  Search,
  Star,
  TrendingUp,
} from "lucide-react";
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
  zinc: "#18181B",
};

const AGENT_ICONS = {
  lead_conversion: MessageSquare,
  seo_geo: Search,
  ads: Megaphone,
  reviews: Star,
  website_cro: TrendingUp,
  dispatch: RouteIcon,
  pricing: DollarSign,
};

function statusTone(status) {
  if (status === "blocked") return { bg: "#FEE2E2", fg: D.red, label: "Blocked", pulse: true };
  if (status === "needs_review") return { bg: "#FEF3C7", fg: D.amber, label: "Needs review", pulse: true };
  if (status === "active") return { bg: "#DBEAFE", fg: D.blue, label: "Active", pulse: true };
  return { bg: D.bg, fg: D.muted, label: "Idle" };
}

function priorityTone(priority) {
  if (priority === "critical" || priority === "high") return { bg: "#FEE2E2", fg: D.red, label: priority === "critical" ? "Critical" : "High" };
  if (priority === "medium") return { bg: "#FEF3C7", fg: D.amber, label: "Medium" };
  return { bg: D.bg, fg: D.muted, label: "Low" };
}

function sourceTone(status) {
  if (status === "ok") return { bg: "#DCFCE7", fg: D.green, Icon: CheckCircle2, label: "OK" };
  if (status === "missing") return { bg: D.bg, fg: D.muted, Icon: CircleDashed, label: "Missing" };
  return { bg: "#FEE2E2", fg: D.red, Icon: AlertTriangle, label: "Error" };
}

function Chip({ children, tone }) {
  return (
    <span
      className={tone.pulse ? "agent-status-pulse" : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 24,
        padding: "0 8px",
        borderRadius: 6,
        background: tone.bg,
        color: tone.fg,
        fontSize: 12,
        fontWeight: 750,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
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

function numberLabel(value) {
  return Number(value || 0).toLocaleString();
}

function valueLabel(value, suffix = "") {
  if (value === null || value === undefined) return "-";
  return `${numberLabel(value)}${suffix}`;
}

function AgentCard({ agent, active, onSelect }) {
  const Icon = AGENT_ICONS[agent.id] || Bot;
  const tone = statusTone(agent.status);
  return (
    <button
      type="button"
      onClick={() => onSelect(active ? "all" : agent.id)}
      style={{
        textAlign: "left",
        background: D.card,
        border: `1px solid ${active ? D.heading : D.border}`,
        borderRadius: 8,
        padding: 14,
        minHeight: 154,
        cursor: "pointer",
        boxShadow: active ? "0 0 0 1px #09090B inset" : "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: 6, background: D.zinc, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Icon size={17} strokeWidth={1.9} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 850, color: D.heading, overflowWrap: "anywhere" }}>{agent.name}</div>
          <div style={{ marginTop: 4 }}><Chip tone={tone}>{tone.label}</Chip></div>
        </div>
      </div>
      <div style={{ fontSize: 13, color: D.text, fontWeight: 800, marginBottom: 6 }}>{agent.headline}</div>
      <div style={{ fontSize: 12, color: D.muted, lineHeight: 1.45, minHeight: 34 }}>{agent.description}</div>
      <div style={{ display: "flex", gap: 10, marginTop: 12, color: D.muted, fontSize: 12, flexWrap: "wrap" }}>
        <span><strong style={{ color: D.heading }}>{numberLabel(agent.openTasks)}</strong> open</span>
        <span><strong style={{ color: D.heading }}>{numberLabel(agent.highPriority)}</strong> high</span>
      </div>
    </button>
  );
}

function Kpi({ label, value, tone = D.heading }) {
  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 750, color: D.muted }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 28, fontWeight: 850, color: tone, lineHeight: 1 }}>{numberLabel(value)}</div>
    </div>
  );
}

function ActionButton({ item, action, pending, onAction }) {
  const isPrimary = action.variant === "primary";
  const isGhost = action.variant === "ghost";
  const style = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 30,
    padding: "0 10px",
    borderRadius: 6,
    border: isPrimary ? `1px solid ${D.heading}` : `1px solid ${isGhost ? "transparent" : D.border}`,
    background: isPrimary ? D.heading : D.card,
    color: isPrimary ? "#fff" : D.heading,
    fontSize: 12,
    fontWeight: 800,
    textDecoration: "none",
    cursor: pending ? "wait" : "pointer",
    opacity: pending ? 0.65 : 1,
    whiteSpace: "nowrap",
  };

  if (action.type === "link") {
    return (
      <Link to={action.url} style={style}>
        {action.label}
      </Link>
    );
  }

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => onAction(item, action)}
      style={style}
    >
      {pending ? "Working..." : action.label}
    </button>
  );
}

function TaskRow({ item, pendingAction, onAction }) {
  const tone = priorityTone(item.priority);
  const hasUrl = !!item.actionUrl;
  const actions = item.actions || [];
  const hasInlineActions = actions.length > 0;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: 12,
        alignItems: "start",
        padding: 14,
        borderBottom: `1px solid ${D.border}`,
        background: D.card,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 7 }}>
          <Chip tone={tone}>{tone.label}</Chip>
          <span style={{ fontSize: 12, color: D.muted }}>{item.sourceLabel}</span>
          {item.impact && <span style={{ fontSize: 12, color: D.muted }}>- {item.impact}</span>}
        </div>
        <div style={{ fontSize: 14, fontWeight: 850, color: D.heading, overflowWrap: "anywhere" }}>{item.title}</div>
        {item.summary && (
          <div style={{ marginTop: 5, fontSize: 13, color: D.text, lineHeight: 1.45, overflowWrap: "anywhere" }}>{item.summary}</div>
        )}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8, fontSize: 12, color: D.muted }}>
          <span>{timeLabel(item.createdAt)}</span>
          {item.dueAt && <span>Due {timeLabel(item.dueAt)}</span>}
          {item.confidence !== null && item.confidence !== undefined && (
            <span>{Math.round(Number(item.confidence) * 100)}% confidence</span>
          )}
        </div>
        {hasInlineActions && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 11 }}>
            {actions.map((action) => {
              const key = `${item.id}:${action.key}`;
              return (
                <ActionButton
                  key={action.key}
                  item={item}
                  action={action}
                  pending={pendingAction === key}
                  onAction={onAction}
                />
              );
            })}
          </div>
        )}
      </div>
      {hasUrl && !hasInlineActions && (
        <Link to={item.actionUrl} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 800, color: D.heading, whiteSpace: "nowrap", textDecoration: "none" }}>
          {item.actionLabel || "Open"}
          <ExternalLink size={14} />
        </Link>
      )}
    </div>
  );
}

function SourceRow({ source }) {
  const tone = sourceTone(source.status);
  const Icon = tone.Icon;
  return (
    <div style={{ display: "flex", gap: 10, padding: "12px 14px", borderBottom: `1px solid ${D.border}`, alignItems: "center" }}>
      <span style={{ width: 28, height: 28, borderRadius: 6, background: tone.bg, color: tone.fg, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon size={15} strokeWidth={2} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: D.heading }}>{source.label}</div>
        <div style={{ fontSize: 12, color: D.muted, overflowWrap: "anywhere" }}>
          {tone.label}{source.count != null ? ` · ${source.count} item${source.count === 1 ? "" : "s"}` : ""}
        </div>
      </div>
    </div>
  );
}

function MetricCell({ label, value, tone = D.heading, suffix = "" }) {
  return (
    <div style={{ border: `1px solid ${D.border}`, borderRadius: 8, padding: 10, minHeight: 72, background: D.card }}>
      <div style={{ fontSize: 11, fontWeight: 750, color: D.muted, lineHeight: 1.25 }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 22, fontWeight: 850, color: tone, lineHeight: 1 }}>{valueLabel(value, suffix)}</div>
    </div>
  );
}

function LeadConversionPanel({ details }) {
  const metrics = details?.metrics || {};
  return (
    <section style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${D.border}`, display: "flex", alignItems: "center", gap: 9 }}>
        <CalendarClock size={16} color={D.heading} />
        <div style={{ fontSize: 15, fontWeight: 850, color: D.heading }}>Lead Conversion</div>
      </div>
      <div className="lead-agent-metrics" style={{ padding: 12 }}>
        <MetricCell label="New" value={metrics.newLeads} tone={metrics.newLeads ? D.red : D.heading} />
        <MetricCell label="Unanswered" value={metrics.unanswered} tone={metrics.unanswered ? D.red : D.heading} />
        <MetricCell label="Missed Calls" value={metrics.missedCalls} tone={metrics.missedCalls ? D.red : D.heading} />
        <MetricCell label="Due Follow-ups" value={metrics.overdueFollowUps} tone={metrics.overdueFollowUps ? D.amber : D.heading} />
        <MetricCell label="Avg Response" value={metrics.avgResponseMinutes} suffix="m" />
        <MetricCell label="Booked 30d" value={metrics.booked30d} tone={D.green} />
      </div>
      <div style={{ display: "grid", gap: 6, padding: "0 14px 14px", color: D.muted, fontSize: 12, lineHeight: 1.45 }}>
        <div><strong style={{ color: D.heading }}>{valueLabel(metrics.staleSpeedToLead)}</strong> leads are beyond the 15-minute speed-to-lead target.</div>
        <div><strong style={{ color: D.heading }}>{valueLabel(metrics.draftsQueued7d)}</strong> lead-agent drafts queued in the last 7 days.</div>
      </div>
    </section>
  );
}

export default function AgentOpsPage({ embedded = false, setRefreshHandler } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeAction, setNoticeAction] = useState(null);
  const [pendingAction, setPendingAction] = useState("");
  const [activeAgent, setActiveAgent] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await adminFetch("/admin/agents/overview");
      setData(next);
    } catch (err) {
      setError(err.message || "Failed to load agent ops.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // When embedded under AgentsHubPage, the hub header owns the Refresh
  // pill — register our load() (and busy state) with it.
  useEffect(() => {
    if (!setRefreshHandler) return undefined;
    setRefreshHandler(load, loading);
    return () => setRefreshHandler(null);
  }, [setRefreshHandler, load, loading]);

  const tasks = useMemo(() => {
    const all = data?.tasks || [];
    if (activeAgent === "all") return all;
    return all.filter((item) => item.agentId === activeAgent);
  }, [activeAgent, data?.tasks]);

  const activeAgentName = data?.agents?.find((agent) => agent.id === activeAgent)?.shortName || "All Agents";
  const showLeadPanel = activeAgent === "all" || activeAgent === "lead_conversion";

  const runTaskAction = useCallback(async (item, action) => {
    if (!action?.endpoint) return;
    const body = { ...(action.body || {}) };
    if (body.status === "dismissed") {
      const note = window.prompt("Dismiss note (optional)", "");
      if (note === null) return;
      if (note.trim()) body.note = note.trim();
    }
    const key = `${item.id}:${action.key}`;
    setPendingAction(key);
    setError("");
    setNotice("");
    setNoticeAction(null);
    try {
      const result = await adminFetch(action.endpoint, {
        method: action.method || "POST",
        body: JSON.stringify(body),
      });
      setNotice(result?.message || `${action.label} complete.`);
      setNoticeAction(result?.actionUrl ? { url: result.actionUrl, label: result.actionLabel || "Open" } : null);
      await load();
    } catch (err) {
      setError(err.message || `${action.label} failed.`);
    } finally {
      setPendingAction("");
    }
  }, [load]);

  return (
    <div style={{ minHeight: "100%", background: D.bg, color: D.text }}>
      <style>{`
        .agent-ops-wrap { padding: 0 24px 32px; display: grid; gap: 16px; }
        .agent-ops-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
        .agent-ops-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
        .agent-ops-main { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
        .lead-agent-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
        .agent-status-pulse { animation: agent-status-pulse 2.6s ease-in-out infinite; }
        @keyframes agent-status-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
        @media (prefers-reduced-motion: reduce) {
          .agent-status-pulse { animation: none; }
        }
        @media (max-width: 1180px) {
          .agent-ops-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .agent-ops-main { grid-template-columns: 1fr; }
        }
        @media (max-width: 720px) {
          .agent-ops-wrap { padding: 0 14px 96px; }
          .agent-ops-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .agent-ops-grid { grid-template-columns: 1fr; }
        }
      `}</style>

      {!embedded && (
        <AdminCommandHeader
          title="Agent Ops"
          icon={Bot}
          actions={[
            { key: "refresh", label: loading ? "Refreshing" : "Refresh", icon: RefreshCw, onClick: load, disabled: loading, variant: "secondary" },
          ]}
        />
      )}

      <div className="agent-ops-wrap">
        {error && (
          <div style={{ background: "#FEE2E2", border: `1px solid ${D.red}`, color: D.red, borderRadius: 8, padding: 12, fontSize: 13, fontWeight: 750 }}>
            {error}
          </div>
        )}
        {notice && (
          <div style={{ background: "#DCFCE7", border: `1px solid ${D.green}`, color: D.green, borderRadius: 8, padding: 12, fontSize: 13, fontWeight: 750, display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
            <span>{notice}</span>
            {noticeAction?.url && (
              <Link to={noticeAction.url} style={{ color: D.green, textDecoration: "underline", whiteSpace: "nowrap" }}>
                {noticeAction.label}
              </Link>
            )}
          </div>
        )}

        <div className="agent-ops-kpis">
          <Kpi label="Active Agents" value={data?.summary?.activeAgents || 0} />
          <Kpi label="Needs Approval" value={data?.summary?.needsApproval || 0} tone={D.amber} />
          <Kpi label="High Priority" value={data?.summary?.highPriority || 0} tone={D.red} />
          <Kpi label="Open Tasks" value={data?.summary?.openTasks || 0} />
        </div>

        <div className="agent-ops-grid">
          {(data?.agents || []).map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              active={activeAgent === agent.id}
              onSelect={setActiveAgent}
            />
          ))}
          {loading && !data && Array.from({ length: 4 }).map((_, idx) => (
            <div key={idx} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 14, minHeight: 154, color: D.muted }}>
              Loading agent...
            </div>
          ))}
        </div>

        <div className="agent-ops-main">
          <section style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: `1px solid ${D.border}` }}>
              <div style={{ fontSize: 15, fontWeight: 850, color: D.heading }}>{activeAgentName} Task Feed</div>
              {activeAgent !== "all" && (
                <button
                  type="button"
                  onClick={() => setActiveAgent("all")}
                  style={{ marginLeft: "auto", height: 30, borderRadius: 6, border: `1px solid ${D.border}`, background: D.card, color: D.text, fontSize: 12, fontWeight: 750, padding: "0 10px", cursor: "pointer" }}
                >
                  Show All
                </button>
              )}
            </div>
            {loading && !data ? (
              <div style={{ padding: 18, color: D.muted, fontSize: 13 }}>Loading tasks...</div>
            ) : tasks.length ? (
              tasks.map((item) => (
                <TaskRow
                  key={item.id}
                  item={item}
                  pendingAction={pendingAction}
                  onAction={runTaskAction}
                />
              ))
            ) : (
              <div style={{ padding: 24, color: D.muted, fontSize: 13 }}>No open agent work.</div>
            )}
          </section>

          <aside style={{ display: "grid", gap: 16 }}>
            {showLeadPanel && <LeadConversionPanel details={data?.agentDetails?.lead_conversion} />}
            <section style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
              <div style={{ padding: "14px 16px", borderBottom: `1px solid ${D.border}`, fontSize: 15, fontWeight: 850, color: D.heading }}>Source Health</div>
              {(data?.sources || []).length ? (
                data.sources.map((source) => <SourceRow key={source.id} source={source} />)
              ) : (
                <div style={{ padding: 18, color: D.muted, fontSize: 13 }}>No source status loaded.</div>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
