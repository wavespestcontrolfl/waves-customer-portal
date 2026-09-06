import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Route, RefreshCw, Play, ChevronRight } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { adminFetch } from "../../utils/admin-fetch";
import { formatETDateOnly, formatETDateTime } from "../../lib/timezone";

// This embedded page keeps its Tier-2 inline style system.
const D = {
  bg: "#F4F4F5", card: "#FFFFFF", border: "#E4E4E7", heading: "#09090B",
  text: "#27272A", muted: "#71717A", red: "#991B1B",
};
const panelStyle = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, minWidth: 0, overflow: "hidden" };
const sectionStyle = { padding: "12px 14px", borderBottom: `1px solid ${D.border}` };
const linkStyle = { color: D.heading, textDecoration: "underline", overflowWrap: "anywhere" };
const ATTENTION = new Set(["failed", "completed_with_errors"]);
const LABELS = { dry_run: "Dry-run", apply: "Apply", completed_with_errors: "Completed with errors", no_change: "No change" };
const label = (value) => LABELS[value] || String(value || "Unknown").replace(/_/g, " ");
const shortId = (id) => String(id || "Unavailable").slice(0, 8);
const fmt = (value) => value ? formatETDateTime(value, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
const dateOnly = (value) => String(value || "").slice(0, 10);

function Chip({ children, alert = false }) {
  return <span style={{ display: "inline-flex", padding: "2px 8px", borderRadius: 6, background: alert ? "#FEE2E2" : D.bg, color: alert ? D.red : D.text, fontSize: 14, fontWeight: 500 }}>{children}</span>;
}

function HeaderButton({ onClick, disabled = false, primary = false, icon: Icon, children }) {
  return <button type="button" onClick={onClick} disabled={disabled} style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: 40, padding: "0 12px", borderRadius: 8, fontSize: 14, fontWeight: 500, fontFamily: "inherit", cursor: disabled ? "default" : "pointer", background: primary ? D.heading : D.card, color: primary ? D.card : D.text, border: `1px solid ${D.border}`, opacity: disabled ? 0.6 : 1 }}>
    {Icon && <Icon size={16} aria-hidden="true" />}{children}
  </button>;
}

function ErrorNotice({ children }) {
  return <div role="alert" style={{ background: "#FEE2E2", color: D.red, padding: 12, borderRadius: 8, margin: "12px 0" }}>{children}</div>;
}

function Policy({ config }) {
  if (!config) return <p>Operating policy unavailable.</p>;
  return <div style={{ display: "grid", gap: 6 }}>
    <span>{config.routeTiersEnabled
      ? "Tiered routing: evaluates visits from 7 days out, with reminder freezes and a five-day destination floor."
      : `Evaluates visits more than ${config.lockWindowDays} days out.`}</span>
    <span>Looks ahead {config.lookaheadDays} days · Up to {config.maxChangesPerRun} appointment changes per run.</span>
    <span>Apply permission: {config.applyAllowed ? "enabled" : "disabled"}{config.applyBlocked ? " — requested apply mode was reduced to dry-run" : ""}.</span>
  </div>;
}

function Placement({ title, date, start, end, technician, status }) {
  return <div style={{ background: D.bg, borderRadius: 6, padding: 10 }}>
    <div style={{ fontWeight: 500 }}>{title}</div>
    <div>{formatETDateOnly(date) || "No placement recorded"} {start && `${String(start).slice(0, 5)}–${String(end || "—").slice(0, 5)} ET`}</div>
    <div>Technician: {shortId(technician)} · {label(status)}</div>
  </div>;
}

function Decision({ log, onRefresh }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const customerName = [log.customer_first_name, log.customer_last_name].filter(Boolean).join(" ") || `Customer ${shortId(log.customer_id)}`;
  const metrics = log.route_metrics_snapshot || {};
  const constraints = log.constraints_checked || {};
  const prefs = log.portal_preferences_snapshot || {};
  const evidence = [
    ["Original score", log.old_score], ["Candidate score", log.new_score],
    ["Required improvement", constraints.threshold],
    ["Original detour (minutes)", metrics.current_detour_minutes],
    ["Candidate detour (minutes)", metrics.candidate_detour_minutes],
    ["Capability", constraints.capability_level],
    ["Preferred day", prefs.preferred_day], ["Preferred time", prefs.preferred_time],
    ["Blackout start", prefs.blackout_start], ["Blackout end", prefs.blackout_end],
  ].filter(([, value]) => value != null);
  const changeProtection = async (control, field, value) => {
    setSaving(true);
    setError(null);
    try {
      await adminFetch(`/admin/auto-dispatch/services/${encodeURIComponent(log.current_visit_id)}/${control}`, {
        method: "PATCH", body: JSON.stringify({ [field]: value }),
      });
      onRefresh();
    } catch (err) { setError(err.message || "Unable to update visit protection"); }
    finally { setSaving(false); }
  };
  return <article style={{ ...sectionStyle, overflowWrap: "anywhere" }}>
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <Chip alert={log.action === "failed"}>{label(log.action)}</Chip>
      <span>{log.service_type || "Appointment"} · {shortId(log.scheduled_service_id)}</span>
    </div>
    <div style={{ marginTop: 8 }}>
      {log.customer_id ? <Link style={linkStyle} to={`/admin/customers?customerId=${encodeURIComponent(log.customer_id)}`}>{customerName}</Link> : customerName}
    </div>
    <p style={{ margin: "8px 0" }}>{log.reason_description || label(log.reason_code)}</p>
    {log.score_improvement != null && <p style={{ margin: "8px 0" }}>Score improvement: {Number(log.score_improvement).toFixed(1)}</p>}
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
      <Placement title="Before" date={log.old_scheduled_date} start={log.old_window_start} end={log.old_window_end} technician={log.old_technician_id} status={log.old_status} />
      {log.new_scheduled_date && <Placement title={log.action === "changed" ? "Applied placement" : "Candidate placement"} date={log.new_scheduled_date} start={log.new_window_start} end={log.new_window_end} technician={log.new_technician_id} status={log.new_status} />}
    </div>
    {log.current_scheduled_date && <p><Link style={linkStyle} to={`/admin/dispatch?tab=schedule&date=${dateOnly(log.current_scheduled_date)}&appointment=${encodeURIComponent(log.current_visit_id)}`}>Open appointment · {formatETDateOnly(log.current_scheduled_date)}</Link></p>}
    <details style={{ marginTop: 12 }}>
      <summary style={{ cursor: "pointer", minHeight: 32 }}>Decision details and visit controls</summary>
      <p>Decision: {label(log.reason_code)}</p>
      <dl style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 8 }}>
        {evidence.map(([name, value]) => <div key={name}><dt style={{ color: D.muted }}>{name}</dt><dd style={{ margin: 0 }}>{String(value)}</dd></div>)}
      </dl>
      {log.error_message && <ErrorNotice>{log.error_message}</ErrorNotice>}
      {log.current_visit_id && <fieldset disabled={saving} style={{ border: `1px solid ${D.border}`, borderRadius: 8, margin: "12px 0", padding: 12 }}>
        <legend>Current visit protection</legend>
        <p style={{ marginTop: 0 }}>Applies to this occurrence. These controls also protect it from route reordering.</p>
        <div style={{ display: "grid", gap: 12 }}>
          <label style={{ display: "flex", gap: 8 }}><input type="checkbox" checked={log.auto_dispatch_locked === true} onChange={(e) => changeProtection("lock", "locked", e.target.checked)} />Lock this visit from automation</label>
          <label style={{ display: "flex", gap: 8 }}><input type="checkbox" checked={log.auto_dispatch_excluded === true} onChange={(e) => changeProtection("exclusion", "excluded", e.target.checked)} />Exclude this visit until re-included</label>
        </div>
      </fieldset>}
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </details>
  </article>;
}

function RunDetails({ selected, state, onRefresh }) {
  if (!selected) return <p style={sectionStyle}>Select a run to see its decisions.</p>;
  if (state.loading) return <p style={sectionStyle}>Loading decisions…</p>;
  if (state.error) return <div style={sectionStyle}><ErrorNotice>{state.error}</ErrorNotice><HeaderButton onClick={onRefresh}>Retry decisions</HeaderButton></div>;
  if (!state.data) return null;
  const { run, logs } = state.data;
  return <>
    <div style={sectionStyle}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}><Chip alert={ATTENTION.has(run.status)}>{label(run.status)}</Chip><Chip>{label(run.mode)}</Chip></div>
      <p>{fmt(run.started_at)} ET · {run.triggered_by || "Unknown trigger"} · Run {shortId(run.id)}</p>
      {run.status === "running" && <p>This run is in progress. Refresh to load its latest decisions.</p>}
      {ATTENTION.has(run.status) && <ErrorNotice>{run.error_message || "This run needs attention. Review the failed decisions below."}</ErrorNotice>}
      <details><summary style={{ cursor: "pointer" }}>Policy recorded for this run</summary><div style={{ marginTop: 10 }}><Policy config={run.config_snapshot} /></div></details>
    </div>
    {logs.length === 0 ? <p style={sectionStyle}>No decision rows were recorded for this run.</p> : logs.map((log) => <Decision key={log.id} log={log} onRefresh={onRefresh} />)}
  </>;
}

export default function AutoDispatchPage({ embedded = false }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get("run");
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);
  const [list, setList] = useState({ runs: [], automation: null, loading: true, error: null });
  const [detail, setDetail] = useState({ data: null, loading: false, error: null });
  const [running, setRunning] = useState(false);
  const [runMessage, setRunMessage] = useState(null);
  const [runError, setRunError] = useState(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const selectRun = (id) => setSearchParams((current) => {
    const params = new URLSearchParams(current);
    params.set("run", id);
    return params;
  });

  useEffect(() => {
    let active = true;
    setList((previous) => ({ ...previous, loading: true, error: null }));
    adminFetch("/admin/auto-dispatch/runs?limit=50")
      .then((data) => { if (active) setList({ runs: data.runs, automation: data.automation, loading: false, error: null }); })
      .catch((err) => { if (active) setList({ runs: [], automation: null, loading: false, error: err.message || "Failed to load runs" }); });
    return () => { active = false; };
  }, [refreshKey]);

  useEffect(() => {
    let active = true;
    setDetail({ data: null, loading: !!selected, error: null });
    if (selected) {
      adminFetch(`/admin/auto-dispatch/runs/${encodeURIComponent(selected)}`)
        .then((data) => { if (active) setDetail({ data, loading: false, error: null }); })
        .catch((err) => { if (active) setDetail({ data: null, loading: false, error: err.message || "Failed to load decisions" }); });
    }
    return () => { active = false; };
  }, [selected, refreshKey]);

  const triggerDryRun = async () => {
    setRunning(true);
    setRunError(null);
    setRunMessage(null);
    try {
      const result = await adminFetch("/admin/auto-dispatch/run", { method: "POST", body: JSON.stringify({ mode: "dry_run" }) });
      if (!mounted.current) return;
      if (result.runId) selectRun(result.runId);
      if (result.status !== "completed") setRunError(`Dry-run ${label(result.status)}. Review the selected run for details.`);
      else setRunMessage("Dry-run completed. Its decisions are selected below.");
      refresh();
    } catch (err) { if (mounted.current) setRunError(err.message || "Run failed"); }
    finally { if (mounted.current) setRunning(false); }
  };

  return <div style={{ background: D.bg, minHeight: "100%", padding: 16, color: D.text, fontSize: 14 }}>
    {embedded ? <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500, color: D.heading }}>Auto-Dispatch</h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <HeaderButton onClick={refresh} disabled={list.loading || detail.loading} icon={RefreshCw}>Refresh</HeaderButton>
        <HeaderButton onClick={triggerDryRun} disabled={running} icon={Play} primary>{running ? "Running…" : "Run dry-run"}</HeaderButton>
      </div>
    </div> : <AdminCommandHeader title="Auto-Dispatch" icon={Route} actions={[
      { key: "refresh", label: "Refresh", onClick: refresh, disabled: list.loading || detail.loading, icon: RefreshCw },
      { key: "dryrun", label: running ? "Running…" : "Run dry-run", onClick: triggerDryRun, disabled: running, icon: Play },
    ]} />}
    <p>Supervise recurring appointment optimization. <Link to="/admin/dispatch" style={linkStyle}>Open dispatch board</Link></p>
    <div style={{ ...panelStyle, padding: 14, marginBottom: 16 }}>
      <h3 style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 500 }}>Current operation</h3>
      {list.automation ? <>
        <p style={{ margin: "0 0 8px" }}>Scheduled run: {list.automation.scheduledEnabled ? "enabled · daily at 4:10 a.m. Eastern" : "disabled"} · Configured mode: {label(list.automation.config.mode)}</p>
        <Policy config={list.automation.config} />
      </> : <p>{list.loading ? "Loading operating status…" : "Current operating status unavailable."}</p>}
      <p style={{ marginBottom: 0 }}>A dry-run records recommendations without moving appointments. It also saves audit records and may use Google geocoding to save missing customer coordinates.</p>
    </div>
    {runError && <ErrorNotice>{runError}</ErrorNotice>}
    {runMessage && <p role="status">{runMessage}</p>}
    {list.error && <ErrorNotice>{list.error}</ErrorNotice>}
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(320px,1fr)_minmax(360px,1.4fr)]">
      <section style={panelStyle} aria-label="Recent runs">
        <h3 style={{ ...sectionStyle, margin: 0, fontSize: 14, fontWeight: 500 }}>Recent runs</h3>
        {list.loading && <p style={sectionStyle}>Loading runs…</p>}
        {!list.loading && !list.error && list.runs.length === 0 && <p style={sectionStyle}>No runs yet. Run a dry-run to start.</p>}
        {list.runs.map((run) => <button type="button" key={run.id} onClick={() => selectRun(run.id)} aria-pressed={selected === run.id} style={{ width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", background: selected === run.id ? D.bg : D.card, cursor: "pointer", border: "none", borderBottom: `1px solid ${D.border}`, borderLeft: selected === run.id ? `3px solid ${D.heading}` : "3px solid transparent", fontSize: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 6 }}><Chip alert={ATTENTION.has(run.status)}>{label(run.status)}</Chip><Chip>{label(run.mode)}</Chip></div>
            <div>{fmt(run.started_at)} ET</div>
            <div>{run.total_evaluated} evaluated · {run.total_recommended} recommended · {run.total_changed} changed · {run.total_skipped} skipped · {run.total_failed} failed decisions</div>
          </div><ChevronRight size={16} aria-hidden="true" />
        </button>)}
      </section>
      <section style={panelStyle} aria-label="Run decisions">
        <h3 style={{ ...sectionStyle, margin: 0, fontSize: 14, fontWeight: 500 }}>Decisions</h3>
        <RunDetails selected={selected} state={detail} onRefresh={refresh} />
      </section>
    </div>
  </div>;
}
