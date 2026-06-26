import { useCallback, useEffect, useState } from "react";
import { ChartCard, EmptyState, CHART_PRIMARY } from "./charts";

// Self-contained AI chart builder + pinned widgets. Gated behind the
// `dashboard-ai-charts` feature flag by the caller. The model only proposes SQL;
// the server runs everything through the read-only sandbox.

const API_BASE = import.meta.env.VITE_API_URL || "/api";
async function aiFetch(path, opts = {}) {
  const token = localStorage.getItem("waves_admin_token");
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const fmtNum = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? "—");
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

// Generic, monochrome renderer for an AI chart spec + result rows.
function AiChart({ chartType, spec, rows, fields }) {
  if (!rows || rows.length === 0) return <EmptyState>No rows returned</EmptyState>;
  const cols = fields && fields.length ? fields : Object.keys(rows[0]);
  const xKey = spec?.x && cols.includes(spec.x) ? spec.x : cols[0];
  const yKey = (spec?.y || []).find((k) => cols.includes(k)) || cols.find((c) => c !== xKey) || cols[0];

  if (chartType === "kpi") {
    const v = rows[0][yKey] ?? rows[0][cols[0]];
    return (
      <div className="py-4">
        <div className="text-28 u-nums text-ink-primary">{fmtNum(v)}</div>
        {spec?.explanation && <div className="text-12 text-ink-tertiary mt-1">{spec.explanation}</div>}
      </div>
    );
  }

  if (chartType === "table") {
    return (
      <div className="overflow-x-auto">
        <table className="min-w-full text-12">
          <thead>
            <tr>{cols.map((c) => <th key={c} className="text-left u-label text-ink-tertiary pr-4 pb-1">{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.slice(0, 50).map((r, i) => (
              <tr key={i} className="border-t border-hairline border-zinc-100">
                {cols.map((c) => <td key={c} className="pr-4 py-1 u-nums text-ink-secondary">{typeof r[c] === "number" ? fmtNum(r[c]) : String(r[c] ?? "—")}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (chartType === "line") {
    const pts = rows.map((r) => Number(r[yKey])).filter((n) => Number.isFinite(n));
    if (pts.length < 2) return <AiChart chartType="bar" spec={spec} rows={rows} fields={fields} />;
    const max = Math.max(...pts), min = Math.min(...pts, 0);
    const W = 560, H = 160, pad = 4;
    const span = max - min || 1;
    const path = pts.map((v, i) => `${(i / (pts.length - 1)) * (W - pad * 2) + pad},${H - pad - ((v - min) / span) * (H - pad * 2)}`).join(" ");
    return (
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: H }}>
          <polyline points={path} fill="none" stroke={CHART_PRIMARY} strokeWidth="2" />
        </svg>
        <div className="flex justify-between text-11 text-ink-tertiary">
          <span>{String(rows[0][xKey] ?? "")}</span>
          <span>{String(rows[rows.length - 1][xKey] ?? "")}</span>
        </div>
      </div>
    );
  }

  // bar (and donut → rendered as a share/bar breakdown — same single-series story)
  const bars = rows.slice(0, 12).map((r) => ({ label: String(r[xKey] ?? "—"), value: Number(r[yKey]) || 0 }));
  const max = Math.max(...bars.map((b) => b.value), 1);
  return (
    <ul className="space-y-2">
      {bars.map((b, i) => (
        <li key={i}>
          <div className="flex items-baseline justify-between text-12 mb-1">
            <span className="text-ink-secondary truncate pr-2">{b.label}</span>
            <span className="u-nums text-ink-primary">{fmtNum(b.value)}</span>
          </div>
          <div className="h-2 bg-surface-sunken rounded-sm overflow-hidden">
            <div className="h-full" style={{ width: `${(b.value / max) * 100}%`, background: CHART_PRIMARY }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function AiChartsPanel() {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null); // { spec, rows, fields }
  const [error, setError] = useState(null);
  const [widgets, setWidgets] = useState([]);
  const [pinning, setPinning] = useState(false);

  const loadWidgets = useCallback(async () => {
    try {
      const data = await aiFetch("/admin/dashboard/widgets");
      setWidgets(data.widgets || []);
    } catch (e) {
      // a failed list shouldn't break the panel — just show none
      console.error("[ai-charts] load widgets", e);
    }
  }, []);

  useEffect(() => { loadWidgets(); }, [loadWidgets]);

  const onGenerate = async () => {
    const p = prompt.trim();
    if (!p || busy) return;
    setBusy(true); setError(null); setPreview(null);
    try {
      const data = await aiFetch("/admin/dashboard/ai-chart/preview", { method: "POST", body: JSON.stringify({ prompt: p }) });
      setPreview(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const onPin = async () => {
    if (!preview?.spec || pinning) return;
    setPinning(true);
    try {
      await aiFetch("/admin/dashboard/widgets", {
        method: "POST",
        body: JSON.stringify({ title: preview.spec.title, prompt: prompt.trim(), sql: preview.spec.sql, chartSpec: preview.spec }),
      });
      setPreview(null); setPrompt("");
      await loadWidgets();
    } catch (e) {
      setError(e.message);
    } finally {
      setPinning(false);
    }
  };

  const onUnpin = async (id) => {
    try {
      await aiFetch(`/admin/dashboard/widgets/${id}`, { method: "DELETE" });
      setWidgets((w) => w.filter((x) => x.id !== id));
    } catch (e) {
      console.error("[ai-charts] unpin", e);
    }
  };

  return (
    <ChartCard title="Ask for a chart" sub="Describe a metric — the AI builds it from your data">
      <div className="flex gap-2 mb-3">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onGenerate(); }}
          placeholder="e.g. new customers per month by city, last 6 months"
          className="flex-1 h-9 px-3 text-13 border-hairline border-zinc-300 rounded-sm u-focus-ring"
        />
        <button
          type="button"
          onClick={onGenerate}
          disabled={busy || !prompt.trim()}
          className="h-9 px-4 text-12 font-medium rounded-sm bg-zinc-900 text-white disabled:opacity-40 u-focus-ring"
        >
          {busy ? "Building…" : "Generate"}
        </button>
      </div>

      {error && <div className="text-12 text-alert-fg mb-3">{error}</div>}

      {preview && (
        <div className="border-hairline border-zinc-200 rounded-sm p-3 mb-4">
          <div className="flex items-baseline justify-between mb-2">
            <div className="text-13 font-medium text-ink-primary">{preview.spec.title}</div>
            <div className="flex gap-2">
              <button type="button" onClick={onPin} disabled={pinning} className="text-12 text-ink-secondary hover:text-ink-primary u-focus-ring">
                {pinning ? "Pinning…" : "📌 Pin"}
              </button>
              <button type="button" onClick={() => setPreview(null)} className="text-12 text-ink-tertiary hover:text-ink-secondary u-focus-ring">Discard</button>
            </div>
          </div>
          <AiChart chartType={preview.spec.chartType} spec={preview.spec} rows={preview.rows} fields={preview.fields} />
        </div>
      )}

      {widgets.length === 0 && !preview ? (
        <EmptyState>No pinned charts yet — describe one above.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {widgets.map((w) => (
            <div key={w.id} className="border-hairline border-zinc-200 rounded-sm p-3">
              <div className="flex items-baseline justify-between mb-2">
                <div className="text-13 font-medium text-ink-primary truncate pr-2">{w.title}</div>
                <button type="button" onClick={() => onUnpin(w.id)} title="Unpin" aria-label="Unpin" className="text-12 text-ink-tertiary hover:text-alert-fg u-focus-ring">×</button>
              </div>
              {w.error
                ? <EmptyState>{w.error}</EmptyState>
                : <AiChart chartType={w.chartSpec?.chartType} spec={w.chartSpec} rows={w.rows} fields={w.fields} />}
            </div>
          ))}
        </div>
      )}
    </ChartCard>
  );
}
