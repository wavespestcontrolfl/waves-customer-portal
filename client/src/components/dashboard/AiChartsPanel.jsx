import { useCallback, useEffect, useRef, useState } from "react";
import { ChartCard, EmptyState, CHART_PRIMARY } from "./charts";
import DictationButton from "../tech/DictationButton";

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];
// FileReader → { data: base64 (no data: prefix), mimeType, name, preview: dataURL }
const readImage = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result || "");
      resolve({ data: url.split(",")[1] || "", mimeType: file.type, name: file.name, preview: url });
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });

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

// Format a value per the spec's yFormat so axes/labels read right (currency,
// percent — fraction×100, count, hours, rating, or plain number).
const fmtVal = (v, fmt = "number") => {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? "—");
  switch (fmt) {
    case "currency":
      return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 });
    case "percent":
      return `${(n * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
    case "hours":
      return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}h`;
    case "rating":
      return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}★`;
    case "count":
      return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    default:
      return Math.abs(n) >= 1000
        ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
        : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
};

// Monochrome zinc ramp for multi-series charts (single series keeps CHART_PRIMARY).
const SERIES_SHADES = ["#18181B", "#71717A", "#A1A1AA", "#3F3F46", "#D4D4D8", "#52525B"];
const shade = (i) => SERIES_SHADES[i % SERIES_SHADES.length];

// Numeric coercion that keeps SQL NULLs as NaN (Number(null)===0 would otherwise
// turn a NULL bucket into a floor point). A real 0 stays a finite 0.
const num = (v) => (v == null || v === "" ? NaN : Number(v));

// Legend for multi-series charts — a swatch + the column alias per series.
function Legend({ keys }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 mb-2 text-11 text-ink-tertiary">
      {keys.map((k, i) => (
        <span key={k} className="inline-flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: shade(i) }} />
          {k}
        </span>
      ))}
    </div>
  );
}

// Generic, monochrome renderer for an AI chart spec + result rows.
function AiChart({ chartType, spec, rows, fields }) {
  if (!rows || rows.length === 0) return <EmptyState>No rows returned</EmptyState>;
  const cols = fields && fields.length ? fields : Object.keys(rows[0]);
  const xKey = spec?.x && cols.includes(spec.x) ? spec.x : cols[0];
  const yKey = (spec?.y || []).find((k) => cols.includes(k)) || cols.find((c) => c !== xKey) || cols[0];
  const fmt = spec?.yFormat || "number";
  const yCols = new Set((spec?.y || []).filter((k) => cols.includes(k)));

  if (chartType === "kpi") {
    const v = rows[0][yKey] ?? rows[0][cols[0]];
    return (
      <div className="py-4">
        <div className="text-28 u-nums text-ink-primary">{fmtVal(v, fmt)}</div>
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
                {cols.map((c) => <td key={c} className="pr-4 py-1 u-nums text-ink-secondary">{typeof r[c] === "number" ? fmtVal(r[c], yCols.has(c) ? fmt : "number") : String(r[c] ?? "—")}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (chartType === "line") {
    // One polyline per y column (multi-series); single series keeps CHART_PRIMARY.
    const yKeys = [...yCols].length ? [...yCols] : [yKey];
    const series = yKeys.map((k) => rows.map((r) => num(r[k])));
    const allVals = series.flat().filter((n) => Number.isFinite(n));
    // A line needs ≥2 x-positions that carry data. Count x-positions where SOME
    // series is finite — a single bucket (even multi-series) falls back to bars
    // rather than drawing invisible one-point polylines.
    const finiteX = rows.filter((_, i) => series.some((s) => Number.isFinite(s[i]))).length;
    if (finiteX < 2) return <AiChart chartType="bar" spec={spec} rows={rows} fields={fields} />;
    const max = Math.max(...allVals), min = Math.min(...allVals, 0);
    const W = 600, H = 180, padL = 56, padR = 8, padT = 10, padB = 22;
    const span = max - min || 1;
    const n = rows.length;
    const xAt = (i) => padL + (n > 1 ? i / (n - 1) : 0.5) * (W - padL - padR);
    const yAt = (v) => padT + (1 - (v - min) / span) * (H - padT - padB);
    const ticks = [max, (max + min) / 2, min];
    const xIdx = n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : [0, n - 1];
    // Split each series into contiguous runs of finite points, so a NULL bucket
    // (e.g. a NULLIF rate with no leads that month) reads as a GAP — not a drop
    // to the floor. Isolated finite points render as a dot rather than vanishing.
    const segmentsOf = (s) => {
      const segs = []; let cur = [];
      s.forEach((v, i) => {
        if (Number.isFinite(v)) cur.push([xAt(i), yAt(v)]);
        else if (cur.length) { segs.push(cur); cur = []; }
      });
      if (cur.length) segs.push(cur);
      return segs;
    };
    return (
      <div className="overflow-x-auto">
        {yKeys.length > 1 && <Legend keys={yKeys} />}
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: H }}>
          {ticks.map((t, i) => (
            <g key={`t${i}`}>
              <line x1={padL} x2={W - padR} y1={yAt(t)} y2={yAt(t)} stroke="#E4E4E7" strokeWidth="1" />
              <text x={padL - 6} y={yAt(t) + 3} textAnchor="end" fontSize="10" fill="#A1A1AA">{fmtVal(t, fmt)}</text>
            </g>
          ))}
          {series.map((s, si) => {
            const color = yKeys.length > 1 ? shade(si) : CHART_PRIMARY;
            return segmentsOf(s).map((seg, gi) => (
              seg.length > 1
                ? <polyline key={`s${si}-${gi}`} points={seg.map((p) => p.join(",")).join(" ")} fill="none" stroke={color} strokeWidth="2" />
                : <circle key={`s${si}-${gi}`} cx={seg[0][0]} cy={seg[0][1]} r="2.5" fill={color} />
            ));
          })}
          {xIdx.map((idx, j) => (
            <text key={`x${j}`} x={xAt(idx)} y={H - 6} textAnchor={j === 0 ? "start" : j === xIdx.length - 1 ? "end" : "middle"} fontSize="10" fill="#A1A1AA">{String(rows[idx][xKey] ?? "")}</text>
          ))}
        </svg>
      </div>
    );
  }

  // bar (and donut → rendered as a share/bar breakdown).
  // Scale by absolute magnitude so negative metrics (net change, churn deltas)
  // get a valid, proportional width; the signed value stays in the label.
  const barKeys = [...yCols].length ? [...yCols] : [yKey];
  const cats = rows.slice(0, 12);
  const absMax = Math.max(...cats.flatMap((r) => barKeys.map((k) => Math.abs(Number(r[k]) || 0))), 1);

  if (barKeys.length <= 1) {
    return (
      <ul className="space-y-2">
        {cats.map((r, i) => {
          const value = Number(r[yKey]) || 0;
          return (
            <li key={i}>
              <div className="flex items-baseline justify-between text-12 mb-1">
                <span className="text-ink-secondary truncate pr-2">{String(r[xKey] ?? "—")}</span>
                <span className="u-nums text-ink-primary">{fmtVal(value, fmt)}</span>
              </div>
              <div className="h-2 bg-surface-sunken rounded-sm overflow-hidden">
                <div className="h-full" style={{ width: `${Math.min(100, (Math.abs(value) / absMax) * 100)}%`, background: CHART_PRIMARY, opacity: value < 0 ? 0.5 : 1 }} />
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  // Multi-series → grouped bars per category, one sub-bar per series.
  return (
    <div>
      <Legend keys={barKeys} />
      <ul className="space-y-3">
        {cats.map((r, i) => (
          <li key={i}>
            <div className="text-12 text-ink-secondary truncate mb-1">{String(r[xKey] ?? "—")}</div>
            {barKeys.map((k, ki) => {
              const v = Number(r[k]) || 0;
              return (
                <div key={k} className="flex items-center gap-2 mb-1">
                  <div className="h-2 flex-1 bg-surface-sunken rounded-sm overflow-hidden">
                    <div className="h-full" style={{ width: `${Math.min(100, (Math.abs(v) / absMax) * 100)}%`, background: shade(ki), opacity: v < 0 ? 0.5 : 1 }} />
                  </div>
                  <span className="u-nums text-ink-primary text-11" style={{ minWidth: 56, textAlign: "right" }}>{fmtVal(v, fmt)}</span>
                </div>
              );
            })}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function AiChartsPanel() {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null); // { spec, rows, fields }
  const [error, setError] = useState(null);
  const [widgets, setWidgets] = useState([]);
  const [pinning, setPinning] = useState(false);
  const [images, setImages] = useState([]); // [{ data, mimeType, name, preview }]
  const fileInputRef = useRef(null);

  const addImages = async (fileList) => {
    const remaining = MAX_IMAGES - images.length;
    if (remaining <= 0) return;
    // Cap to the open slots BEFORE reading, so a big shift-select can't read
    // many ×5MB files just to drop all but a few.
    const files = Array.from(fileList || [])
      .filter((f) => ALLOWED_IMAGE_MIME.includes(f.type) && f.size <= MAX_IMAGE_BYTES)
      .slice(0, remaining);
    if (!files.length) return;
    const read = await Promise.all(files.map(readImage));
    setImages((prev) => [...prev, ...read].slice(0, MAX_IMAGES));
  };
  const removeImage = (i) => setImages((prev) => prev.filter((_, idx) => idx !== i));

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
    if ((!p && !images.length) || busy) return;
    setBusy(true); setError(null); setPreview(null);
    try {
      const data = await aiFetch("/admin/dashboard/ai-chart/preview", {
        method: "POST",
        body: JSON.stringify({ prompt: p, images: images.map((im) => ({ data: im.data, mimeType: im.mimeType })) }),
      });
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
      setPreview(null); setPrompt(""); setImages([]);
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
      <div className="flex items-center gap-2 mb-2">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onGenerate(); }}
          placeholder="e.g. new customers per month by city, last 6 months — or attach an image"
          className="flex-1 h-9 px-3 text-13 border-hairline border-zinc-300 rounded-sm u-focus-ring"
        />
        <DictationButton
          onAppend={(t) => setPrompt((p) => (p ? `${p} ${t}` : t))}
          palette={{ accent: "#18181B", muted: "#A1A1AA", red: "#C8312F", card: "#FFFFFF" }}
          title="Dictate"
          size={36}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_IMAGE_MIME.join(",")}
          multiple
          className="hidden"
          onChange={(e) => { addImages(e.target.files); e.target.value = ""; }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={images.length >= MAX_IMAGES}
          title="Attach a reference image"
          aria-label="Attach a reference image"
          className="h-9 w-9 inline-flex items-center justify-center border-hairline border-zinc-300 rounded-sm text-ink-secondary hover:bg-zinc-50 disabled:opacity-40 u-focus-ring shrink-0"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onGenerate}
          disabled={busy || (!prompt.trim() && !images.length)}
          className="h-9 px-4 text-12 font-medium rounded-sm bg-zinc-900 text-white disabled:opacity-40 u-focus-ring shrink-0"
        >
          {busy ? "Building…" : "Generate"}
        </button>
      </div>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {images.map((im, i) => (
            <div key={i} className="relative">
              <img src={im.preview} alt={im.name} className="h-14 w-14 object-cover rounded-sm border-hairline border-zinc-200" />
              <button
                type="button"
                onClick={() => removeImage(i)}
                aria-label={`Remove ${im.name}`}
                className="absolute -top-1.5 -right-1.5 h-4 w-4 inline-flex items-center justify-center rounded-full bg-zinc-900 text-white text-[10px] u-focus-ring"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

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
                <button type="button" onClick={() => onUnpin(w.id)} title="Unpin" aria-label="Unpin" className="text-12 text-ink-tertiary hover:text-ink-primary u-focus-ring">×</button>
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
