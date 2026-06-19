import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Play, ChevronRight } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { adminFetch } from "../../utils/admin-fetch";

// Light neutral palette — mirrors the read-only admin pages (AgentDecisionsPage).
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

const ACTION_TONE = {
  changed: "green",
  recommended: "blue",
  no_change: "neutral",
  skipped: "amber",
  failed: "red",
};

const RUN_TONE = {
  completed: "green",
  completed_with_errors: "amber",
  running: "blue",
  failed: "red",
};

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
      display: "inline-flex", alignItems: "center", minHeight: 22, padding: "0 8px",
      borderRadius: 6, background: colors.bg, color: colors.fg, fontSize: 12,
      fontWeight: 700, whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
}

function fmt(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch { return String(ts); }
}

export default function AutoDispatchPage() {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminFetch(`/admin/auto-dispatch/runs?limit=50`);
      setRuns((data && data.runs) || []);
    } catch (err) {
      setError(err.message || "Failed to load runs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let active = true;
    setDetailLoading(true);
    adminFetch(`/admin/auto-dispatch/runs/${selected}`)
      .then((d) => { if (active) setDetail(d); })
      .catch(() => { if (active) setDetail(null); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [selected]);

  const triggerDryRun = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      await adminFetch(`/admin/auto-dispatch/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "dry_run" }),
      });
      await loadRuns();
    } catch (err) {
      setError(err.message || "Run failed");
    } finally {
      setRunning(false);
    }
  }, [loadRuns]);

  return (
    <div style={{ background: D.bg, minHeight: "100%", padding: 16 }}>
      <AdminCommandHeader
        title="Auto-Dispatch"
        actions={[
          { key: "refresh", label: "Refresh", size: "sm", variant: "ghost", icon: RefreshCw, onClick: loadRuns },
          { key: "dryrun", label: running ? "Running…" : "Run dry-run", size: "sm", icon: Play, disabled: running, onClick: triggerDryRun },
        ]}
      />

      <p style={{ color: D.muted, fontSize: 13, margin: "8px 2px 16px" }}>
        Optimizes future recurring visits more than 14 days out. Runs daily; this view shows each run and
        every per-visit decision. The scheduled job stays in dry-run mode until apply is enabled.
      </p>

      {error && (
        <div style={{ background: "#FEE2E2", color: D.red, padding: "8px 12px", borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          {error}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 1fr) minmax(360px, 1.4fr)", gap: 16 }}>
        {/* Runs list */}
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", borderBottom: `1px solid ${D.border}`, fontWeight: 700, color: D.heading, fontSize: 13 }}>
            Recent runs
          </div>
          {loading ? (
            <div style={{ padding: 24, color: D.muted, fontSize: 13 }}>Loading…</div>
          ) : runs.length === 0 ? (
            <div style={{ padding: 24, color: D.muted, fontSize: 13 }}>No runs yet. Trigger a dry-run to start.</div>
          ) : runs.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelected(r.id)}
              style={{
                width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 10,
                padding: "10px 14px", borderBottom: `1px solid ${D.border}`, background: selected === r.id ? D.bg : D.card,
                cursor: "pointer", border: "none", borderLeft: selected === r.id ? `3px solid ${D.blue}` : "3px solid transparent",
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <Chip tone={RUN_TONE[r.status] || "neutral"}>{r.status}</Chip>
                  <Chip tone={r.mode === "apply" ? "amber" : "neutral"}>{r.mode}</Chip>
                </div>
                <div style={{ color: D.text, fontSize: 12 }}>
                  {fmt(r.started_at)} · eval {r.total_evaluated} · rec {r.total_recommended} · chg {r.total_changed} · skip {r.total_skipped} · fail {r.total_failed}
                </div>
              </div>
              <ChevronRight size={16} color={D.muted} />
            </button>
          ))}
        </div>

        {/* Run detail */}
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", borderBottom: `1px solid ${D.border}`, fontWeight: 700, color: D.heading, fontSize: 13 }}>
            Decisions
          </div>
          {!selected ? (
            <div style={{ padding: 24, color: D.muted, fontSize: 13 }}>Select a run to see its decisions.</div>
          ) : detailLoading ? (
            <div style={{ padding: 24, color: D.muted, fontSize: 13 }}>Loading…</div>
          ) : !detail || !detail.logs || detail.logs.length === 0 ? (
            <div style={{ padding: 24, color: D.muted, fontSize: 13 }}>No decision rows for this run.</div>
          ) : (
            <div style={{ maxHeight: 560, overflowY: "auto" }}>
              {detail.logs.map((log) => (
                <div key={log.id} style={{ padding: "10px 14px", borderBottom: `1px solid ${D.border}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <Chip tone={ACTION_TONE[log.action] || "neutral"}>{log.action}</Chip>
                    <span style={{ color: D.muted, fontSize: 12 }}>{log.reason_code}</span>
                    {log.score_improvement != null && (
                      <span style={{ color: D.green, fontSize: 12, fontWeight: 700 }}>+{Number(log.score_improvement).toFixed(1)}</span>
                    )}
                  </div>
                  <div style={{ color: D.text, fontSize: 12 }}>{log.reason_description}</div>
                  {(log.new_scheduled_date || log.old_scheduled_date) && (
                    <div style={{ color: D.muted, fontSize: 12, marginTop: 4 }}>
                      {log.old_scheduled_date || "—"} {log.old_window_start || ""}
                      {log.new_scheduled_date ? ` →  ${log.new_scheduled_date} ${log.new_window_start || ""}` : ""}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
