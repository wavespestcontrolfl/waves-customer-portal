import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  ExternalLink,
  FileSearch,
  RefreshCw,
  Search,
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
  accent: "#18181B",
};

const MONO = "'JetBrains Mono', monospace";

const STATUS_ORDER = [
  "conflict",
  "db_published_missing_astro",
  "source_missing_since_sync",
  "db_changed_since_sync",
  "astro_changed_since_sync",
  "db_only",
  "astro_only",
  "matched",
];

const STATUS_TONE = {
  conflict: "red",
  db_published_missing_astro: "red",
  source_missing_since_sync: "amber",
  db_changed_since_sync: "amber",
  astro_changed_since_sync: "amber",
  db_only: "amber",
  astro_only: "neutral",
  matched: "green",
};

const LIVE_TONE = {
  live: "green",
  redirected: "blue",
  canonicalized: "blue",
  noindex: "amber",
  missing: "red",
  error: "red",
  blocked: "amber",
};

function labelize(value) {
  return String(value || "unknown")
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function formatDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString(undefined, {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function countSum(counts = {}) {
  return Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
}

function liveHref(row) {
  const url = row?.live_url || row?.canonical_url || row?.canonical_url_normalized;
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `https://www.wavespestcontrol.com${url}`;
  return "";
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch {
      return [value];
    }
  }
  return [String(value)];
}

function Chip({ children, tone = "neutral" }) {
  const colors = {
    green: { bg: "#DCFCE7", fg: D.green },
    amber: { bg: "#FEF3C7", fg: D.amber },
    red: { bg: "#FEE2E2", fg: D.red },
    blue: { bg: "#DBEAFE", fg: D.blue },
    neutral: { bg: D.bg, fg: D.text },
  }[tone] || { bg: D.bg, fg: D.text };
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
        fontWeight: 750,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function Kpi({ label, value, tone = "neutral" }) {
  const color = tone === "red" ? D.red : tone === "amber" ? D.amber : tone === "green" ? D.green : D.heading;
  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 14 }}>
      <div style={{ fontSize: 12, color: D.muted, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 24, color, fontWeight: 850, fontFamily: MONO, marginTop: 4 }}>{Number(value || 0).toLocaleString()}</div>
    </div>
  );
}

function Field({ label, value, mono = false }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: D.muted, fontWeight: 800, textTransform: "uppercase" }}>{label}</div>
      <div style={{ color: D.text, fontSize: 13, fontFamily: mono ? MONO : undefined, overflowWrap: "anywhere", marginTop: 4 }}>
        {value || "-"}
      </div>
    </div>
  );
}

function buildQuery({ status, contentType, source, liveStatus, search }) {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (contentType) params.set("content_type", contentType);
  if (source) params.set("source", source);
  if (liveStatus) params.set("live_status", liveStatus);
  if (search.trim()) params.set("search", search.trim());
  params.set("limit", "100");
  return `/admin/content-registry?${params.toString()}`;
}

export default function ContentRegistryPage({ embedded = false } = {}) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("");
  const [contentType, setContentType] = useState("");
  const [source, setSource] = useState("");
  const [liveStatus, setLiveStatus] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await adminFetch(buildQuery({ status, contentType, source, liveStatus, search }));
      setData(next);
      setSelectedId((current) => (
        next.items?.some((item) => item.id === current) ? current : next.items?.[0]?.id || null
      ));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [status, contentType, source, liveStatus, search]);

  const runSync = useCallback(async () => {
    setSyncing(true);
    setError("");
    setSyncNotice("");
    try {
      const result = await adminFetch("/admin/content-registry/sync", {
        method: "POST",
        body: JSON.stringify({ source: "auto", commit: true }),
      });
      const summary = result.summary || {};
      setSyncNotice(`Sync complete: ${Number(summary.astro_files_scanned || 0).toLocaleString()} Astro files, ${Number(summary.matched_count || 0).toLocaleString()} matched, ${Number(summary.conflict_count || 0).toLocaleString()} conflicts.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSyncing(false);
    }
  }, [load]);

  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  const items = data?.items || [];
  const counts = data?.counts || {};
  const selected = items.find((item) => item.id === selectedId) || null;
  const totalRows = countSum(counts);
  const statusTabs = useMemo(() => (
    STATUS_ORDER.filter((key) => counts[key]).map((key) => ({ key, count: counts[key] }))
  ), [counts]);
  const contentTypes = Object.keys(data?.facets?.content_type || {}).sort();
  const sources = Object.keys(data?.facets?.source || {}).sort();
  const liveStatuses = Object.keys(data?.facets?.live_status || {}).sort();
  const selectedHref = liveHref(selected);
  const mismatchReasons = arrayValue(selected?.mismatch_reasons);

  return (
    <div
      style={{
        minHeight: "100%",
        background: embedded ? "transparent" : D.bg,
        padding: embedded ? 0 : 24,
      }}
    >
      {!embedded && (
        <AdminCommandHeader
          title="Content Registry"
          icon={Database}
          actions={[
            { key: "sync", label: "Sync", icon: RefreshCw, onClick: runSync, disabled: loading || syncing, variant: "primary" },
            { key: "refresh", label: "Refresh", icon: RefreshCw, onClick: load, disabled: loading || syncing, variant: "secondary" },
          ]}
        />
      )}
      {embedded && (
        <div style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
          <button
            type="button"
            onClick={runSync}
            disabled={loading || syncing}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 36, padding: "0 14px", borderRadius: 6, border: `1px solid ${D.heading}`, background: D.heading, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
          >
            <RefreshCw size={14} strokeWidth={2} /> {syncing ? "Syncing..." : "Sync"}
          </button>
          <button
            type="button"
            onClick={load}
            disabled={loading || syncing}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 36, padding: "0 12px", borderRadius: 6, border: `1px solid ${D.border}`, background: D.card, color: D.text, fontSize: 12, fontWeight: 700, cursor: "pointer" }}
          >
            <RefreshCw size={14} strokeWidth={2} /> Refresh
          </button>
        </div>
      )}

      {error && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: D.red, background: "#FEE2E2", border: `1px solid ${D.red}33`, borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <AlertTriangle size={16} strokeWidth={2} />
          <span style={{ fontSize: 13, fontWeight: 700 }}>{error}</span>
        </div>
      )}

      {syncNotice && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: D.green, background: "#DCFCE7", border: `1px solid ${D.green}33`, borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <CheckCircle2 size={16} strokeWidth={2} />
          <span style={{ fontSize: 13, fontWeight: 700 }}>{syncNotice}</span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
        <Kpi label="Registry Rows" value={totalRows || data?.total || 0} />
        <Kpi label="Conflicts" value={counts.conflict || 0} tone={(counts.conflict || 0) > 0 ? "red" : "green"} />
        <Kpi label="DB Missing Astro" value={counts.db_published_missing_astro || 0} tone={(counts.db_published_missing_astro || 0) > 0 ? "red" : "green"} />
        <Kpi label="DB Only" value={counts.db_only || 0} tone={(counts.db_only || 0) > 0 ? "amber" : "green"} />
        <Kpi label="Astro Only" value={counts.astro_only || 0} />
        <Kpi label="Matched" value={counts.matched || 0} tone="green" />
      </div>

      <section style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, marginBottom: 16, overflow: "hidden" }}>
        <div style={{ padding: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(220px, 100%), 1fr))", gap: 10, alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, border: `1px solid ${D.border}`, borderRadius: 6, padding: "0 10px", minHeight: 40, background: "#FAFAFA" }}>
            <Search size={16} strokeWidth={2} color={D.muted} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title, URL, slug, or source path"
              style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", color: D.text, fontSize: 13 }}
            />
          </label>
          <select
            value={contentType}
            onChange={(e) => setContentType(e.target.value)}
            style={{ minHeight: 40, border: `1px solid ${D.border}`, borderRadius: 6, background: "#FAFAFA", color: D.text, padding: "0 10px", fontSize: 13 }}
          >
            <option value="">All content types</option>
            {contentTypes.map((type) => <option key={type} value={type}>{labelize(type)}</option>)}
          </select>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            style={{ minHeight: 40, border: `1px solid ${D.border}`, borderRadius: 6, background: "#FAFAFA", color: D.text, padding: "0 10px", fontSize: 13 }}
          >
            <option value="">All sources</option>
            {sources.map((item) => <option key={item} value={item}>{labelize(item)}</option>)}
          </select>
          <select
            value={liveStatus}
            onChange={(e) => setLiveStatus(e.target.value)}
            style={{ minHeight: 40, border: `1px solid ${D.border}`, borderRadius: 6, background: "#FAFAFA", color: D.text, padding: "0 10px", fontSize: 13 }}
          >
            <option value="">All live statuses</option>
            {liveStatuses.map((item) => <option key={item} value={item}>{labelize(item)}</option>)}
          </select>
        </div>
        <div style={{ borderTop: `1px solid ${D.border}`, padding: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => setStatus("")} style={tabStyle(!status)}>
            All <span style={{ fontFamily: MONO }}>{totalRows.toLocaleString()}</span>
          </button>
          {statusTabs.map((tab) => (
            <button key={tab.key} type="button" onClick={() => setStatus(tab.key)} style={tabStyle(status === tab.key)}>
              {labelize(tab.key)} <span style={{ fontFamily: MONO }}>{Number(tab.count || 0).toLocaleString()}</span>
            </button>
          ))}
        </div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(420px, 100%), 1fr))", gap: 16, alignItems: "start" }}>
        <section style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "12px 14px", borderBottom: `1px solid ${D.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: D.heading, fontWeight: 850, fontSize: 14 }}>
              <FileSearch size={16} strokeWidth={2} />
              Inventory
            </div>
            <div style={{ color: D.muted, fontSize: 12 }}>
              {loading ? "Loading..." : `${Number(data?.total || 0).toLocaleString()} filtered`}
            </div>
          </div>
          {loading && !data ? (
            <div style={{ padding: 32, color: D.muted, textAlign: "center" }}>Loading...</div>
          ) : items.length === 0 ? (
            <div style={{ padding: 32, color: D.muted, textAlign: "center" }}>No registry rows match the current filters.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
                <thead>
                  <tr>
                    {["Content", "Reconciliation", "Type", "Source", "Astro / DB", "Live", "Synced"].map((heading) => (
                      <th key={heading} style={{ textAlign: "left", padding: "10px 12px", color: D.muted, fontSize: 12, fontWeight: 850, borderBottom: `1px solid ${D.border}` }}>
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const active = item.id === selectedId;
                    return (
                      <tr
                        key={item.id}
                        onClick={() => setSelectedId(item.id)}
                        style={{ cursor: "pointer", background: active ? "#F8FAFC" : D.card }}
                      >
                        <td style={cellStyle}>
                          <div style={{ color: D.heading, fontWeight: 800, fontSize: 13, lineHeight: 1.25 }}>{item.title || item.slug || item.canonical_url_normalized || "Untitled"}</div>
                          <div style={{ color: D.muted, fontSize: 12, marginTop: 4, fontFamily: MONO, overflowWrap: "anywhere" }}>{item.canonical_url_normalized || item.live_url || "-"}</div>
                        </td>
                        <td style={cellStyle}><Chip tone={STATUS_TONE[item.reconciliation_status]}>{labelize(item.reconciliation_status)}</Chip></td>
                        <td style={cellStyle}>{labelize(item.content_type)}</td>
                        <td style={cellStyle}>{labelize(item.source)}</td>
                        <td style={cellStyle}>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <Chip tone={item.astro_status === "present" ? "green" : item.astro_status === "missing" ? "red" : "neutral"}>Astro {labelize(item.astro_status)}</Chip>
                            <Chip tone={item.db_status === "present" ? "green" : item.db_status === "missing" ? "amber" : "neutral"}>DB {labelize(item.db_status)}</Chip>
                          </div>
                        </td>
                        <td style={cellStyle}><Chip tone={LIVE_TONE[item.live_status] || "neutral"}>{labelize(item.live_status)}</Chip></td>
                        <td style={{ ...cellStyle, color: D.muted, fontSize: 12 }}>{formatDate(item.last_synced_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "12px 14px", borderBottom: `1px solid ${D.border}`, display: "flex", alignItems: "center", gap: 8 }}>
            <Database size={16} strokeWidth={2} />
            <div style={{ fontSize: 14, fontWeight: 850, color: D.heading }}>Registry Detail</div>
          </div>
          {!selected ? (
            <div style={{ padding: 24, color: D.muted, textAlign: "center" }}>Select a registry row.</div>
          ) : (
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <div style={{ color: D.heading, fontSize: 18, lineHeight: 1.25, fontWeight: 850 }}>{selected.title || selected.slug || "Untitled"}</div>
                <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <Chip tone={STATUS_TONE[selected.reconciliation_status]}>{labelize(selected.reconciliation_status)}</Chip>
                  <Chip tone={LIVE_TONE[selected.live_status] || "neutral"}>{labelize(selected.live_status)}</Chip>
                  <Chip>{labelize(selected.workflow_status)}</Chip>
                  {selected.noindex_detected && <Chip tone="amber">Noindex</Chip>}
                  {selected.match_confidence && <Chip tone="blue">{labelize(selected.match_confidence)}</Chip>}
                </div>
              </div>

              {selectedHref && (
                <a
                  href={selectedHref}
                  target="_blank"
                  rel="noreferrer"
                  style={{ minHeight: 40, borderRadius: 6, border: `1px solid ${D.border}`, color: D.heading, textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13, fontWeight: 800 }}
                >
                  <ExternalLink size={15} strokeWidth={2} />
                  Open Live URL
                </a>
              )}

              <div style={{ display: "grid", gap: 12 }}>
                <Field label="Canonical URL" value={selected.canonical_url_normalized || selected.canonical_url} mono />
                <Field label="Live URL" value={selected.live_url} mono />
                <Field label="HTTP / Live Status" value={[selected.http_status, labelize(selected.live_status)].filter(Boolean).join(" / ")} mono />
                <Field label="Redirect Target" value={selected.redirect_target_url} mono />
                <Field label="Canonical Target" value={selected.canonical_target_url} mono />
                <Field label="Sitemap" value={[labelize(selected.sitemap_status), selected.sitemap_present === true ? "present" : selected.sitemap_present === false ? "missing" : null].filter(Boolean).join(" / ")} />
                <Field label="Astro Source" value={selected.astro_source_path} mono />
                <Field label="DB Blog ID" value={selected.db_blog_id} mono />
                <Field label="Target Keyword" value={selected.target_keyword} />
                <Field label="City / Service" value={[selected.target_city, selected.target_service].filter(Boolean).join(" / ")} />
                <Field label="Author / Reviewer" value={[selected.author, selected.reviewer].filter(Boolean).join(" / ")} />
                <Field label="Published / Updated" value={`${formatDate(selected.published_at)} / ${formatDate(selected.last_updated_at)}`} />
                <Field label="Last Synced" value={formatDate(selected.last_synced_at)} />
              </div>

              {mismatchReasons.length > 0 && (
                <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 14 }}>
                  <div style={{ fontSize: 11, color: D.muted, fontWeight: 850, textTransform: "uppercase", marginBottom: 8 }}>Mismatch Reasons</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {mismatchReasons.map((reason) => <Chip key={reason} tone="amber">{labelize(reason)}</Chip>)}
                  </div>
                </div>
              )}

              <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: selected.astro_status === "present" ? D.green : D.muted, fontSize: 13, fontWeight: 800 }}>
                  <CheckCircle2 size={15} strokeWidth={2} />
                  Astro {labelize(selected.astro_status)}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: selected.db_status === "present" ? D.green : D.muted, fontSize: 13, fontWeight: 800 }}>
                  <CheckCircle2 size={15} strokeWidth={2} />
                  DB {labelize(selected.db_status)}
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>

      {data?.latest_sync_run && (
        <div style={{ marginTop: 16, color: D.muted, fontSize: 12 }}>
          Latest sync: <span style={{ color: D.text, fontWeight: 750 }}>{labelize(data.latest_sync_run.status)}</span> at {formatDate(data.latest_sync_run.completed_at || data.latest_sync_run.started_at)}
          {data.latest_sync_run.astro_repo_sha ? <span style={{ fontFamily: MONO }}> - {data.latest_sync_run.astro_repo_sha.slice(0, 8)}</span> : null}
        </div>
      )}
    </div>
  );
}

const cellStyle = {
  padding: "12px",
  borderBottom: `1px solid ${D.border}`,
  verticalAlign: "top",
  color: D.text,
  fontSize: 13,
};

function tabStyle(active) {
  return {
    minHeight: 34,
    border: `1px solid ${active ? D.accent : D.border}`,
    background: active ? D.accent : D.card,
    color: active ? "#FFFFFF" : D.text,
    borderRadius: 6,
    padding: "0 10px",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    fontWeight: 800,
    cursor: "pointer",
  };
}
