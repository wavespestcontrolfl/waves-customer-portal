import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge, Card, CardBody, cn } from "../../components/ui";
import { adminFetch } from "../../utils/admin-fetch";

/**
 * Agents hub → "Queue" tab (GATE_ADMIN_OPS_QUEUE). One read-only view of
 * every long-running lane's persisted state: pending (machinery working),
 * parked (waiting on a human or stuck), failed (needs a look). No actions
 * live here — each lane keeps its own approval path; rows link out where a
 * surface exists.
 *
 * Tier 1 V2: components/ui + zinc ramp. `alert` badge tone is reserved for
 * failed rows — a genuine alert, never decoration.
 */

const STATUS_LABEL = { pending: "Pending", parked: "Parked", failed: "Failed" };

function statusTone(status) {
  if (status === "failed") return "alert";
  if (status === "parked") return "strong";
  return "neutral";
}

function ago(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function StatTile({ label, value, tone }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 border-hairline border-zinc-200 rounded-md bg-white min-w-[120px]">
      <span className="text-13 uppercase tracking-label text-ink-tertiary">{label}</span>
      <span className={cn("text-24 font-medium tabular-nums", tone === "alert" && value > 0 ? "text-alert-fg" : "text-ink-primary")}>
        {value}
      </span>
    </div>
  );
}

export default function AgentQueueTab({ embedded = false } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openLanes, setOpenLanes] = useState(() => new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await adminFetch("/admin/agents/queue");
      setData(next);
    } catch (e) {
      setError(e?.message || "Could not load the queue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleLane = (key) =>
    setOpenLanes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const lanes = data?.lanes || [];
  const totals = data?.totals || { pending: 0, parked: 0, failed: 0 };

  return (
    <div className={cn("flex flex-col gap-4", embedded ? "px-4 md:px-6 py-4" : "p-6")} aria-label="Ops queue">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          <StatTile label="Failed" value={totals.failed} tone="alert" />
          <StatTile label="Parked" value={totals.parked} />
          <StatTile label="Pending" value={totals.pending} />
        </div>
        <div className="flex items-center gap-3">
          {data?.generatedAt ? (
            <span className="text-13 text-ink-tertiary">as of {ago(data.generatedAt) || "just now"}</span>
          ) : null}
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-2 h-9 px-3 rounded-sm border-hairline border-zinc-300 bg-white text-13 font-medium text-zinc-900 u-focus-ring disabled:opacity-60"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : undefined} aria-hidden />
            {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      {error ? (
        <div role="alert" className="text-14 text-alert-fg">{error}</div>
      ) : null}

      {!loading && !error && lanes.length === 0 ? (
        <div className="text-14 text-ink-secondary">Nothing is queued, parked, or failing.</div>
      ) : null}

      <div className="flex flex-col gap-3">
        {lanes.map((lane) => {
          const open = openLanes.has(lane.key);
          const quiet = !lane.error && lane.total === 0;
          return (
            <Card key={lane.key} data-lane={lane.key} data-quiet={quiet || undefined}>
              <button
                type="button"
                onClick={() => toggleLane(lane.key)}
                aria-expanded={open}
                className="w-full flex flex-col items-start md:flex-row md:items-center md:justify-between gap-2 md:gap-3 px-4 py-3 text-left u-focus-ring"
              >
                <span className="flex items-center gap-3 min-w-0 max-w-full">
                  <span className="text-14 font-medium text-ink-primary truncate">{lane.label}</span>
                  {lane.error ? (
                    <Badge tone="alert">unavailable</Badge>
                  ) : quiet ? (
                    <span className="text-13 text-ink-tertiary">clear</span>
                  ) : null}
                </span>
                <span className="flex flex-wrap items-center gap-2 shrink-0">
                  {lane.failed > 0 ? <Badge tone="alert" dot>{lane.failed} failed</Badge> : null}
                  {lane.parked > 0 ? <Badge tone="strong" dot>{lane.parked} parked</Badge> : null}
                  {lane.pending > 0 ? <Badge tone="neutral" dot>{lane.pending} pending</Badge> : null}
                  <span aria-hidden className="text-13 text-ink-tertiary w-3 text-center">{open ? "▾" : "▸"}</span>
                </span>
              </button>
              {open ? (
                <CardBody className="pt-0">
                  {lane.error ? (
                    <div className="text-14 text-ink-secondary">This lane could not be read: {lane.error}</div>
                  ) : lane.items.length === 0 ? (
                    <div className="text-14 text-ink-secondary">Nothing here.</div>
                  ) : (
                    <ul className="m-0 p-0 list-none divide-y divide-zinc-200">
                      {lane.items.map((item) => (
                        <li key={item.id} className="flex items-start gap-3 py-2">
                          <Badge tone={statusTone(item.status)} className="shrink-0 mt-0.5">
                            {STATUS_LABEL[item.status] || item.status}
                          </Badge>
                          <div className="min-w-0 flex-1">
                            <div className="text-14 text-ink-primary truncate">
                              {item.href ? (
                                <a href={item.href} className="text-ink-primary underline decoration-zinc-300 underline-offset-2 u-focus-ring">
                                  {item.title}
                                </a>
                              ) : (
                                item.title
                              )}
                            </div>
                            {item.detail ? (
                              <div className="text-13 text-ink-secondary">{item.detail}</div>
                            ) : null}
                          </div>
                          <span className="shrink-0 text-13 text-ink-tertiary tabular-nums">{ago(item.at)}</span>
                        </li>
                      ))}
                      {lane.total > lane.items.length ? (
                        <li className="py-2 text-13 text-ink-tertiary">
                          Showing {lane.items.length} of {lane.total}.
                        </li>
                      ) : null}
                    </ul>
                  )}
                </CardBody>
              ) : null}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
