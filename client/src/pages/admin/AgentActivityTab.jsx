import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { Badge, Button, Card, Select, cn } from "../../components/ui";
import { adminFetch } from "../../utils/admin-fetch";
import { etDateString, formatETDate, formatETTime } from "../../lib/timezone";

// Agents → Activity: one timeline of agent runs, parked drafts and cron
// jobs, from GET /admin/agents/activity (server/services/agent-activity.js).
// Read-only in this PR; the Review affordance links to the surface that owns
// the decision. Dark behind GATE_AGENT_ACTIVITY — the endpoint answers
// { available: false } and this tab explains itself instead of rendering.

const WINDOWS = [
  { hours: 24, label: "Last 24 hours" },
  { hours: 72, label: "Last 3 days" },
  { hours: 168, label: "Last 7 days" },
];

// Status → chip tone + label. Only failed / blocked use alert-fg (genuine
// alerts); everything else stays monochrome.
const STATUS_META = {
  running: { label: "Running", tone: "strong" },
  awaiting_review: { label: "Awaiting review", tone: "strong" },
  blocked: { label: "Blocked", tone: "alert" },
  failed: { label: "Failed", tone: "alert" },
  completed: { label: "Completed", tone: "neutral" },
  skipped: { label: "Skipped", tone: "neutral" },
};
const STATUS_ORDER = ["running", "awaiting_review", "blocked", "failed", "completed", "skipped"];

// Wall-clock in Eastern (client/src/lib/timezone.js), never the browser zone.
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return formatETTime(d);
}

// Day label only when the event is not ET-today.
function fmtDay(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (etDateString(d) === etDateString()) return "";
  return formatETDate(d, { month: "short", day: "numeric" });
}

function fmtMs(ms) {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

function StepRow({ step }) {
  const glyph =
    step.status === "done"
      ? "✓"
      : step.status === "blocked"
        ? "!"
        : step.status === "running"
          ? "…"
          : "○";
  return (
    <li className="flex items-start gap-2 text-13">
      <span
        aria-hidden
        className={cn(
          "w-4 flex-shrink-0 text-center u-nums",
          step.status === "blocked" ? "text-alert-fg" : step.status === "not_started" ? "text-ink-disabled" : "text-zinc-900",
        )}
      >
        {glyph}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn(step.status === "not_started" ? "text-ink-tertiary" : "text-zinc-900")}>
          {step.label}
        </span>
        {step.detail && (
          <span className={cn("block text-12 leading-normal", step.status === "blocked" ? "text-alert-fg" : "text-ink-secondary")}>
            {step.detail}
          </span>
        )}
      </span>
      {step.ms != null && <span className="u-nums text-12 text-ink-tertiary">{fmtMs(step.ms)}</span>}
    </li>
  );
}

function ActivityRow({ item }) {
  const [open, setOpen] = useState(false);
  const meta = STATUS_META[item.status] || STATUS_META.completed;
  const expandable = item.steps?.length > 0 || item.detail;
  const needsAction = item.status === "awaiting_review" && item.link;
  return (
    <li className="border-t border-hairline border-zinc-200 first:border-t-0">
      <div className="flex items-start gap-3 px-3 py-3 md:px-4">
        <div className="w-14 flex-shrink-0 pt-0.5 text-12 text-ink-tertiary u-nums">
          <div>{fmtTime(item.startedAt)}</div>
          {fmtDay(item.startedAt) && <div>{fmtDay(item.startedAt)}</div>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-14 font-medium text-zinc-900">{item.title}</span>
            <Badge tone={meta.tone}>{meta.label}</Badge>
          </div>
          <div className="mt-0.5 text-12 text-ink-secondary">
            {item.agent}
            {item.subtitle ? ` · ${item.subtitle}` : ""}
            {item.stepsTotal > 0 ? ` · ${item.stepsDone} of ${item.stepsTotal} steps` : ""}
            {item.durationMs != null ? ` · ${fmtMs(item.durationMs)}` : ""}
          </div>
          {open && (
            <div className="mt-3 flex flex-col gap-2">
              {item.detail && (
                <div className={cn("text-12 leading-normal", ["failed", "blocked"].includes(item.status) ? "text-alert-fg" : "text-ink-secondary")}>
                  {item.detail}
                </div>
              )}
              {item.steps?.length > 0 && (
                <ol className="flex flex-col gap-1.5">
                  {item.steps.map((step) => (
                    <StepRow key={step.key} step={step} />
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {needsAction && (
            <Link
              to={item.link}
              className="hidden md:inline-flex h-8 items-center rounded-sm border-hairline border-zinc-300 bg-white px-3 text-11 font-medium uppercase tracking-label text-zinc-900 no-underline hover:bg-zinc-50 u-focus-ring"
            >
              Review
            </Link>
          )}
          {expandable && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-label={open ? "Collapse" : "Expand"}
              className="inline-flex h-11 w-11 items-center justify-center rounded-sm text-ink-secondary hover:bg-zinc-100 hover:text-zinc-900 u-focus-ring md:h-8 md:w-8"
            >
              {open ? <ChevronUp size={16} strokeWidth={2} /> : <ChevronDown size={16} strokeWidth={2} />}
            </button>
          )}
        </div>
      </div>
      {needsAction && (
        <div className="px-3 pb-3 md:hidden">
          <Link
            to={item.link}
            className="inline-flex h-11 items-center rounded-sm border-hairline border-zinc-300 bg-white px-4 text-12 font-medium uppercase tracking-label text-zinc-900 no-underline u-focus-ring"
          >
            Review
          </Link>
        </div>
      )}
    </li>
  );
}

export default function AgentActivityTab() {
  const [hours, setHours] = useState(24);
  const [status, setStatus] = useState("all");
  const [agent, setAgent] = useState("all");
  const [feed, setFeed] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await adminFetch(`/admin/agents/activity?hours=${hours}`);
      setFeed(next);
    } catch (e) {
      setError(e?.message || "Failed to load activity");
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    load();
  }, [load]);

  const items = useMemo(() => {
    const all = feed?.items || [];
    return all.filter(
      (item) => (status === "all" || item.status === status) && (agent === "all" || item.agent === agent),
    );
  }, [feed, status, agent]);

  const summary = feed?.summary;

  return (
    <div className="flex flex-col gap-3 pb-6">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-11 u-label text-ink-secondary">
          Window
          <Select size="sm" value={hours} onChange={(e) => setHours(Number(e.target.value))} className="w-40">
            {WINDOWS.map((w) => (
              <option key={w.hours} value={w.hours}>
                {w.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-11 u-label text-ink-secondary">
          Status
          <Select size="sm" value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
            <option value="all">All statuses</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_META[s].label}
                {summary ? ` (${summary[s] || 0})` : ""}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-11 u-label text-ink-secondary">
          Agent
          <Select size="sm" value={agent} onChange={(e) => setAgent(e.target.value)} className="w-44">
            <option value="all">All agents</option>
            {(feed?.agents || []).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </label>
        <Button size="sm" variant="secondary" onClick={load} disabled={loading} className="gap-2">
          <RefreshCw size={13} strokeWidth={2} className={loading ? "animate-spin" : undefined} aria-hidden />
          {loading ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      {feed?.unavailableSources?.length > 0 && (
        <div className="text-12 text-alert-fg" role="alert">
          Not migrated on this deployment, so not shown: {feed.unavailableSources.join(", ")}.
        </div>
      )}
      {summary && feed?.available && (
        <div className="text-12 text-ink-secondary">
          <span className="font-medium text-zinc-900 u-nums">{summary.total}</span> runs in the window
          {STATUS_ORDER.filter((s) => summary[s]).map((s) => (
            <span key={s}>
              {" · "}
              <span className="u-nums">{summary[s]}</span> {STATUS_META[s].label.toLowerCase()}
            </span>
          ))}
          {summary.healthyJobs > 0 && (
            <span>
              {" · "}
              <span className="u-nums">{summary.healthyJobs}</span> scheduled jobs healthy (not listed)
            </span>
          )}
        </div>
      )}

      <Card className="overflow-hidden">
        {loading && !feed ? (
          <div className="p-5 text-13 text-ink-secondary" role="status">
            Loading activity…
          </div>
        ) : error ? (
          <div className="p-5 text-13 text-alert-fg" role="alert">
            {error}
          </div>
        ) : feed && feed.available === false ? (
          <div className="p-5 text-13 text-ink-secondary">
            The Activity feed is not enabled on this deployment. Set{" "}
            <code className="text-12">GATE_AGENT_ACTIVITY=true</code> to turn it on.
          </div>
        ) : items.length === 0 ? (
          <div className="p-5 text-13 text-ink-secondary">No activity matches these filters.</div>
        ) : (
          <ol>
            {items.map((item) => (
              <ActivityRow key={item.id} item={item} />
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
