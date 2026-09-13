import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Clock,
  RefreshCw,
  Timer,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  UiSurface,
  cn,
} from "../../components/ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

const TOOL_HEALTH_WINDOWS = [
  { key: 1, label: "1h", Icon: Timer },
  { key: 24, label: "24h", Icon: Clock },
  { key: 24 * 7, label: "7d", Icon: CalendarDays },
];

function statusLabel(status) {
  if (status === "critical") return "Critical";
  if (status === "warning") return "Degraded";
  if (status === "idle") return "Idle";
  return "Healthy";
}

function statusTone(status) {
  if (status === "critical") return "alert";
  if (status === "ok") return "strong";
  return "neutral";
}

function pct(n) {
  return `${Math.round((n || 0) * 100)}%`;
}

function formatRelative(iso) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
  return `${Math.round(diff / 86400_000)}d ago`;
}

export default function ToolHealthPage() {
  const [data, setData] = useState(null);
  const [hours, setHours] = useState(24);
  const [err, setErr] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [adminUser, setAdminUser] = useState(null);

  const load = useCallback(() => {
    adminFetch(`/admin/tool-health?hours=${hours}`)
      .then((d) => {
        setData(d);
        setErr(null);
      })
      .catch((e) => setErr(e.message));
  }, [hours]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    adminFetch("/admin/auth/me")
      .then((user) => setAdminUser(user))
      .catch(() => setAdminUser(null));
  }, []);

  return (
    <UiSurface
      density="comfortable"
      className="mx-auto max-w-[1300px] text-ui-body text-ink-primary"
    >
      <AdminCommandHeader
        variant="workspace"
        title="Tool health"
        icon={Activity}
        sections={TOOL_HEALTH_WINDOWS}
        activeKey={hours}
        onSectionChange={setHours}
        action={{ label: "Refresh", icon: RefreshCw, variant: "ghost", onClick: load }}
        navGridClassName="grid-cols-3"
      />

      {err ? (
        <ActionFeedback error onRetry={load} className="min-h-20">
          Failed to load: {err}
        </ActionFeedback>
      ) : !data ? (
        <ActionFeedback className="min-h-20">Loading tool health...</ActionFeedback>
      ) : (
        <ToolHealthContent
          data={data}
          adminUser={adminUser}
          expanded={expanded}
          setExpanded={setExpanded}
        />
      )}
    </UiSurface>
  );
}

function ToolHealthContent({ data, adminUser, expanded, setExpanded }) {
  const { overallStatus, summary, agents, contexts, pdfRenderer, recentErrors, alerts } =
    data;

  return (
    <div className="space-y-5">
      <Card className={overallStatus === "critical" ? "border-alert-fg" : undefined}>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Overall status</CardTitle>
          <Badge tone={statusTone(overallStatus)} dot>
            {statusLabel(overallStatus)}
          </Badge>
        </CardHeader>
        <CardBody>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <Metric label="Total calls" value={summary.total.toLocaleString()} />
            <Metric label="Success rate" value={pct(1 - summary.errorRate)} />
            <Metric label="Failures" value={summary.failed.toLocaleString()} alert={summary.failed > 0} />
            <Metric label="Circuit trips" value={summary.circuitOpenCount} alert={summary.circuitOpenCount > 0} />
            <Metric
              label="Avg duration"
              value={summary.avgDurationMs ? `${summary.avgDurationMs}ms` : "—"}
            />
          </dl>
        </CardBody>
      </Card>

      {adminUser?.role === "admin" && (
        <p className="text-ui-body text-ink-secondary">
          Credential health and provider configuration are in{" "}
          <Link
            to="/admin/settings?tab=integrations"
            className="inline-flex min-h-11 items-center rounded-xs font-medium text-zinc-900 underline underline-offset-2 u-focus-ring"
          >
            Settings → Integrations
          </Link>
          .
        </p>
      )}

      {pdfRenderer && (
        <Card>
          <CardHeader>
            <CardTitle>PDF render success rate</CardTitle>
          </CardHeader>
          <CardBody>
            <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Metric
                label="Success rate"
                value={pdfRenderer.successRate == null ? "—" : pct(pdfRenderer.successRate)}
              />
              <Metric label="Succeeded" value={pdfRenderer.succeeded || 0} />
              <Metric
                label="Terminal failures"
                value={pdfRenderer.terminalFailed || 0}
                alert={pdfRenderer.terminalFailed > 0}
              />
              <Metric
                label="P95 latency"
                value={pdfRenderer.p95LatencyMs ? `${pdfRenderer.p95LatencyMs}ms` : "—"}
              />
            </dl>
          </CardBody>
        </Card>
      )}

      {alerts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Active alerts</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            {alerts.map((alert, index) => (
              <div
                key={index}
                className={cn(
                  "rounded-md border-hairline p-4",
                  alert.severity === "critical"
                    ? "border-alert-fg bg-alert-bg"
                    : "border-zinc-300 bg-zinc-50",
                )}
              >
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <p className="font-medium text-zinc-900">{alert.title}</p>
                  <Badge tone={alert.severity === "critical" ? "alert" : "neutral"}>
                    {alert.severity === "critical" ? "Critical" : "Warning"}
                  </Badge>
                </div>
                <p className="text-ui-body text-ink-secondary">{alert.detail}</p>
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      <section aria-labelledby="agent-health-heading">
        <h2 id="agent-health-heading" className="mb-3 text-18 leading-[1.35] font-medium text-zinc-900">
          Agent health
        </h2>
        {agents.length === 0 ? (
          <Card>
            <CardBody className="py-8 text-center text-ink-secondary">
              No agent activity in the selected window.
            </CardBody>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {agents.map((agent) => (
              <Card key={agent.source} className={agent.status === "critical" ? "border-alert-fg" : undefined}>
                <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle>{agent.label}</CardTitle>
                  <Badge tone={statusTone(agent.status)} dot>
                    {statusLabel(agent.status)}
                  </Badge>
                </CardHeader>
                <CardBody>
                  <dl className="grid grid-cols-3 gap-3">
                    <Metric label="Calls" value={agent.total} />
                    <Metric label="Errors" value={agent.failed} alert={agent.failed > 0} />
                    <Metric
                      label="Avg"
                      value={agent.avgDurationMs ? `${agent.avgDurationMs}ms` : "—"}
                    />
                  </dl>
                  <p className="mt-3 text-ui-caption text-ink-secondary">
                    Last call {formatRelative(agent.lastCallAt)}
                  </p>
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="contexts-heading">
        <h2 id="contexts-heading" className="mb-3 text-18 leading-[1.35] font-medium text-zinc-900">
          Tools by context
        </h2>
        {contexts.length === 0 ? (
          <Card>
            <CardBody className="py-8 text-center text-ink-secondary">
              No tool activity in the selected window.
            </CardBody>
          </Card>
        ) : (
          <div className="space-y-3">
            {contexts.map((context, index) => (
              <ContextCard
                key={context.context}
                context={context}
                panelId={`tool-context-${index}`}
                isOpen={expanded[context.context] !== undefined ? expanded[context.context] : context.failed > 0}
                onToggle={() =>
                  setExpanded((current) => ({
                    ...current,
                    [context.context]: !(current[context.context] !== undefined
                      ? current[context.context]
                      : context.failed > 0),
                  }))
                }
              />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="recent-errors-heading">
        <div className="mb-3 flex items-center gap-2">
          <h2 id="recent-errors-heading" className="text-18 leading-[1.35] font-medium text-zinc-900">
            Recent errors
          </h2>
          {recentErrors.length > 0 && <Badge tone="neutral">{recentErrors.length}</Badge>}
        </div>
        <Card>
          {recentErrors.length === 0 ? (
            <CardBody className="py-8 text-center text-ink-secondary">
              No errors in the selected window.
            </CardBody>
          ) : (
            <div className="divide-y divide-zinc-200">
              {recentErrors.map((error) => (
                <RecentErrorRow key={error.id} err={error} />
              ))}
            </div>
          )}
        </Card>
      </section>

      <p className="pb-5 text-center text-ui-caption text-ink-secondary">
        Updated {formatRelative(data.generatedAt)} · auto-refreshes every 30s
      </p>
    </div>
  );
}

function Metric({ label, value, alert = false }) {
  return (
    <div>
      <dt className="text-ui-caption text-ink-secondary">{label}</dt>
      <dd className={cn("mt-1 text-22 leading-[1.3] font-medium u-nums", alert && "text-alert-fg")}>
        {value}
      </dd>
    </div>
  );
}

function ContextCard({ context, panelId, isOpen, onToggle }) {
  const status = context.failed > 0
    ? context.errorRate >= 0.2 ? "critical" : "warning"
    : "ok";
  const ExpandIcon = isOpen ? ChevronDown : ChevronRight;

  return (
    <Card className={status === "critical" ? "border-alert-fg" : undefined}>
      <CardHeader className="p-0">
        <Button
          variant="ghost"
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={onToggle}
          className="h-auto min-h-14 w-full justify-start rounded-none px-4 py-3 text-left"
        >
          <ExpandIcon size={18} strokeWidth={1.8} aria-hidden className="shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block break-words text-ui-body font-medium text-zinc-900">
              {context.context}
            </span>
            <span className="mt-1 block text-ui-caption font-normal text-ink-secondary u-nums">
              {context.toolsUsed} tools · {context.total} calls · {context.failed} failed ({pct(context.errorRate)})
            </span>
          </span>
          <Badge tone={statusTone(status)} dot className="shrink-0">
            {statusLabel(status)}
          </Badge>
        </Button>
      </CardHeader>
      {isOpen && (
        <CardBody id={panelId} className="p-0">
          <Table layout="records" aria-label={`${context.context} tool health`}>
            <THead>
              <TR>
                <TH>Tool</TH>
                <TH>Source</TH>
                <TH>Calls</TH>
                <TH>Failed</TH>
                <TH>Error rate</TH>
                <TH>Avg</TH>
              </TR>
            </THead>
            <TBody>
              {context.tools
                .slice()
                .sort((a, b) => b.failed - a.failed || b.total - a.total)
                .map((tool) => (
                  <TR key={`${tool.toolName}-${tool.source}`}>
                    <TD data-label="Tool" className="font-medium">{tool.toolName}</TD>
                    <TD data-label="Source" className="text-ink-secondary">{tool.source}</TD>
                    <TD data-label="Calls" nums>{tool.total}</TD>
                    <TD data-label="Failed" nums className={tool.failed > 0 ? "text-alert-fg" : "text-ink-secondary"}>
                      {tool.failed}
                    </TD>
                    <TD data-label="Error rate" nums className={tool.errorRate > 0 ? "text-alert-fg" : "text-ink-secondary"}>
                      {pct(tool.errorRate)}
                    </TD>
                    <TD data-label="Avg" nums>{tool.avgDurationMs ? `${tool.avgDurationMs}ms` : "—"}</TD>
                  </TR>
                ))}
            </TBody>
          </Table>
        </CardBody>
      )}
    </Card>
  );
}

function RecentErrorRow({ err }) {
  const [open, setOpen] = useState(false);
  const msg = err.errorMessage || "(no message)";
  const canExpand = msg.length > 120 || msg.includes("\n");
  const content = (
    <>
      <span className="text-ui-caption text-ink-secondary u-nums">
        {formatRelative(err.at)}
      </span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-zinc-900">{err.toolName}</span>
          {err.circuitOpen && (
            <Badge tone="alert" title="Circuit breaker is open" className="shrink-0">
              Open
            </Badge>
          )}
        </span>
        <span className="block truncate text-ui-caption text-ink-secondary">
          {err.context || err.source}
        </span>
      </span>
      <span
        className={cn(
          "whitespace-pre-wrap break-words text-ui-body text-zinc-700",
          canExpand && !open && "max-h-11 overflow-hidden",
        )}
      >
        {msg}
      </span>
    </>
  );
  const rowClassName = "grid w-full grid-cols-1 gap-2 px-4 py-3 text-left min-[720px]:grid-cols-[80px_170px_minmax(0,1fr)] min-[720px]:gap-3";

  if (!canExpand) return <div className={rowClassName}>{content}</div>;

  return (
    <Button
      variant="ghost"
      aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
      className={cn(rowClassName, "h-auto min-h-11 items-start justify-start rounded-none")}
    >
      {content}
    </Button>
  );
}
