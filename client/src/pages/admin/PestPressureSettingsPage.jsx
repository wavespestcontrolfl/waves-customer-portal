import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  Save,
  RotateCcw,
  Sparkles,
} from "lucide-react";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

// V2 monochrome palette — matches client/src/pages/admin/SettingsPage.jsx.
const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  teal: "#18181B",
  green: "#15803D",
  amber: "#A16207",
  red: "#991B1B",
  text: "#27272A",
  muted: "#71717A",
  white: "#FFFFFF",
  heading: "#09090B",
  inputBorder: "#D4D4D8",
  subtle: "#FAFAFA",
};

function adminFetch(path, init = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  }).then(async (r) => {
    if (r.status === 401) {
      window.location.href = "/admin/login";
      throw new Error("Session expired");
    }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(body.error || `HTTP ${r.status}`);
      err.status = r.status;
      err.body = body;
      throw err;
    }
    return body;
  });
}

function Card({ children, style }) {
  return (
    <div
      style={{
        background: D.card,
        border: `1px solid ${D.border}`,
        borderRadius: 12,
        padding: 24,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function SectionHeading({ icon: Icon, label, description }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {Icon ? <Icon size={16} color={D.heading} /> : null}
        <h2 style={{ fontSize: 16, fontWeight: 600, color: D.heading, margin: 0 }}>{label}</h2>
      </div>
      {description ? (
        <p style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>{description}</p>
      ) : null}
    </div>
  );
}

function Toggle({ checked, onChange, label, description }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 0",
        borderBottom: `1px solid ${D.border}`,
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{label}</div>
        {description ? (
          <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{description}</div>
        ) : null}
      </div>
      <div
        role="switch"
        aria-checked={checked}
        tabIndex={0}
        onClick={() => onChange(!checked)}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            onChange(!checked);
          }
        }}
        style={{
          width: 44,
          height: 24,
          borderRadius: 12,
          padding: 2,
          cursor: "pointer",
          background: checked ? D.teal : D.border,
          transition: "background 0.2s",
        }}
      >
        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            background: D.white,
            transform: checked ? "translateX(20px)" : "translateX(0)",
            transition: "transform 0.2s",
            boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
          }}
        />
      </div>
    </div>
  );
}

function NumberField({ value, onChange, min, max, step = 0.1, suffix, label }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: D.muted }}>
      {label}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const next = e.target.value === "" ? "" : Number(e.target.value);
            onChange(next);
          }}
          style={{
            flex: 1,
            padding: "8px 10px",
            border: `1px solid ${D.inputBorder}`,
            borderRadius: 6,
            fontSize: 14,
            color: D.text,
            background: D.white,
          }}
        />
        {suffix ? <span style={{ fontSize: 12, color: D.muted }}>{suffix}</span> : null}
      </div>
    </label>
  );
}

function TextField({ value, onChange, label }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: D.muted }}>
      {label}
      <input
        type="text"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: "8px 10px",
          border: `1px solid ${D.inputBorder}`,
          borderRadius: 6,
          fontSize: 14,
          color: D.text,
          background: D.white,
        }}
      />
    </label>
  );
}

function TextArea({ value, onChange, label, rows = 4 }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: D.muted }}>
      {label}
      <textarea
        value={value || ""}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: "8px 10px",
          border: `1px solid ${D.inputBorder}`,
          borderRadius: 6,
          fontSize: 14,
          color: D.text,
          background: D.white,
          fontFamily: "inherit",
          resize: "vertical",
        }}
      />
    </label>
  );
}

function Select({ value, onChange, label, options }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: D.muted }}>
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: "8px 10px",
          border: `1px solid ${D.inputBorder}`,
          borderRadius: 6,
          fontSize: 14,
          color: D.text,
          background: D.white,
        }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </label>
  );
}

function Pill({ tone = "neutral", children }) {
  const toneColors = {
    success: { bg: "#DCFCE7", text: "#15803D" },
    warning: { bg: "#FEF3C7", text: "#92400E" },
    error: { bg: "#FEE2E2", text: "#991B1B" },
    neutral: { bg: "#F4F4F5", text: "#52525B" },
  };
  const c = toneColors[tone] || toneColors.neutral;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: c.bg,
        color: c.text,
      }}
    >
      {children}
    </span>
  );
}

const COMPONENT_LABELS = {
  client: "Client-reported activity",
  technician: "Technician-observed activity",
  reService: "Re-service / callback impact",
  recurring: "Recurring issue rating",
  risk: "Risk factor / conducive condition rating",
};

const MISSING_DATA_OPTIONS = [
  { value: "recalculate_available_components", label: "Recalculate using available components" },
  { value: "treat_missing_as_zero", label: "Treat missing inputs as zero" },
  { value: "require_minimum", label: "Require minimum data before displaying score" },
];

function weightsTotal(weights) {
  return Object.values(weights || {}).reduce((s, v) => s + (Number(v) || 0), 0);
}

function labelsCoverageError(labels) {
  if (!Array.isArray(labels) || labels.length === 0) return "Add at least one label.";
  const sorted = labels.slice().sort((a, b) => a.min - b.min);
  if (sorted[0].min > 0) return "Lowest label must start at 0.0.";
  if (sorted[sorted.length - 1].max < 5) return "Highest label must end at 5.0.";
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].min - sorted[i - 1].max > 0.15) return `Gap between “${sorted[i - 1].name}” and “${sorted[i].name}”.`;
    if (sorted[i].min <= sorted[i - 1].max - 0.01) return `Overlap between “${sorted[i - 1].name}” and “${sorted[i].name}”.`;
  }
  return null;
}

export default function PestPressureSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [saveMessage, setSaveMessage] = useState(null);
  const [previewInputs, setPreviewInputs] = useState({
    clientRating: 2,
    technicianRating: 3,
    reServiceImpact: 1,
    recurringIssueRating: 0,
    riskFactorRating: 1,
    previousScore: 1.0,
  });
  const [previewResult, setPreviewResult] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    adminFetch("/admin/pest-pressure/config")
      .then((body) => {
        setConfig(body.config);
        setDefaults(body.defaults);
        setLoading(false);
      })
      .catch((err) => {
        setSaveError(err.message);
        setLoading(false);
      });
  }, []);

  const setField = useCallback((path, value) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      const segs = path.split(".");
      let cursor = next;
      for (let i = 0; i < segs.length - 1; i += 1) {
        cursor[segs[i]] = { ...(cursor[segs[i]] || {}) };
        cursor = cursor[segs[i]];
      }
      cursor[segs[segs.length - 1]] = value;
      return next;
    });
    setSaveMessage(null);
  }, []);

  const setLabel = useCallback((index, patch) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const labels = prev.labels.slice();
      labels[index] = { ...labels[index], ...patch };
      return { ...prev, labels };
    });
    setSaveMessage(null);
  }, []);

  const weightTotal = useMemo(() => (config ? weightsTotal(config.weights) : 0), [config]);
  const weightValid = Math.abs(weightTotal - 100) < 0.01;
  const labelError = useMemo(() => (config ? labelsCoverageError(config.labels) : null), [config]);
  const trendInvalid = config
    ? !(config.trendThresholds.improvingAtOrBelow < 0
      && config.trendThresholds.stableBand >= 0
      && config.trendThresholds.increasingFrom > 0
      && config.trendThresholds.significantIncreaseFrom > config.trendThresholds.increasingFrom)
    : false;

  const canSave = config && weightValid && !labelError && !trendInvalid;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const body = await adminFetch("/admin/pest-pressure/config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      setConfig(body.config);
      setSaveMessage(
        body.changedFields && body.changedFields.length > 0
          ? `Saved. ${body.changedFields.length} field${body.changedFields.length === 1 ? "" : "s"} updated.`
          : "Saved. No fields changed.",
      );
    } catch (err) {
      setSaveError(err.body?.errors ? JSON.stringify(err.body.errors) : err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleRestoreDefaults = () => {
    if (!defaults) return;
    if (!window.confirm("Restore all Pest Pressure settings to defaults? Unsaved changes will be lost. You will still need to click Save to commit.")) return;
    setConfig({ ...defaults });
    setSaveMessage(null);
  };

  const runPreview = useCallback(async () => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const body = await adminFetch("/admin/pest-pressure/preview", {
        method: "POST",
        body: JSON.stringify({ inputs: previewInputs, config }),
      });
      setPreviewResult(body.result);
    } catch (err) {
      setPreviewError(err.message);
      setPreviewResult(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [previewInputs, config]);

  if (loading) {
    return <div style={{ padding: 40, color: D.muted, textAlign: "center" }}>Loading Pest Pressure settings…</div>;
  }
  if (!config) {
    return (
      <div style={{ padding: 40, color: D.red, textAlign: "center" }}>
        Could not load settings. {saveError || ""}
      </div>
    );
  }

  return (
    <div style={{ background: D.bg, minHeight: "100vh", padding: 24 }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: D.heading, margin: 0 }}>Pest Pressure</h1>
            <p style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>
              Configure the 0–5 Pest Pressure score that appears on customer service reports.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={handleRestoreDefaults}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "8px 14px", borderRadius: 6, border: `1px solid ${D.inputBorder}`,
                background: D.white, color: D.text, fontSize: 13, fontWeight: 500, cursor: "pointer",
              }}
            >
              <RotateCcw size={14} /> Restore defaults
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave || saving}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "8px 14px", borderRadius: 6, border: 0,
                background: canSave ? D.teal : D.border, color: D.white,
                fontSize: 13, fontWeight: 600,
                cursor: canSave && !saving ? "pointer" : "not-allowed",
                opacity: saving ? 0.7 : 1,
              }}
            >
              <Save size={14} /> {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </header>

        {saveError ? (
          <Card style={{ background: "#FEF2F2", borderColor: "#FECACA" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <AlertTriangle size={16} color={D.red} />
              <div style={{ color: D.red, fontSize: 13 }}>{saveError}</div>
            </div>
          </Card>
        ) : null}
        {saveMessage ? (
          <Card style={{ background: "#F0FDF4", borderColor: "#BBF7D0" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <CheckCircle2 size={16} color={D.green} />
              <div style={{ color: D.green, fontSize: 13 }}>{saveMessage}</div>
            </div>
          </Card>
        ) : null}

        {/* A. General */}
        <Card>
          <SectionHeading
            label="General"
            description="Enable the feature, control customer-facing visibility, and pick how the score behaves when inputs are missing."
          />
          <Toggle
            label="Enable Pest Pressure"
            description="Master switch. When off, no scores are calculated and the customer report omits the section."
            checked={config.enabled}
            onChange={(v) => setField("enabled", v)}
          />
          <Toggle
            label="Show on customer service reports"
            description="When off, scores are still calculated and stored for admin use but hidden from customers."
            checked={config.showOnCustomerReport}
            onChange={(v) => setField("showOnCustomerReport", v)}
          />
          <Toggle
            label='Show "How we calculate Pest Pressure"'
            description="Includes the customer-facing explanation paragraph under the score card."
            checked={config.showHowCalculated}
            onChange={(v) => setField("showHowCalculated", v)}
          />
          <Toggle
            label="Show component breakdown to customers"
            description="Default off. When on, customers see the individual component values that fed their score."
            checked={config.showComponentBreakdownToCustomer}
            onChange={(v) => setField("showComponentBreakdownToCustomer", v)}
          />
          <div style={{ marginTop: 16 }}>
            <Select
              label="Missing data behavior"
              value={config.missingDataBehavior}
              onChange={(v) => setField("missingDataBehavior", v)}
              options={MISSING_DATA_OPTIONS}
            />
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 16, flexWrap: "wrap" }}>
            <Toggle
              label="Allow manual override (admins)"
              checked={config.allowManualOverride}
              onChange={(v) => setField("allowManualOverride", v)}
            />
            <Toggle
              label="Allow techs to enter client rating on behalf"
              checked={config.allowTechnicianClientRatingEntry}
              onChange={(v) => setField("allowTechnicianClientRatingEntry", v)}
            />
          </div>
        </Card>

        {/* B. Score Formula */}
        <Card>
          <SectionHeading
            label="Score formula"
            description="Component weights as percentages. Must total 100."
          />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {Object.keys(COMPONENT_LABELS).map((key) => (
              <NumberField
                key={key}
                label={COMPONENT_LABELS[key]}
                value={config.weights[key]}
                onChange={(v) => setField(`weights.${key}`, v)}
                min={0}
                max={100}
                step={1}
                suffix="%"
              />
            ))}
          </div>
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
            <Pill tone={weightValid ? "success" : "error"}>
              Total: {weightTotal.toFixed(0)}%
            </Pill>
            {!weightValid ? (
              <span style={{ fontSize: 12, color: D.red }}>Weights must total 100%.</span>
            ) : null}
          </div>
        </Card>

        {/* C. Score Labels */}
        <Card>
          <SectionHeading
            label="Score labels"
            description="Editable bands for the 0–5 score. Ranges must cover 0–5 with no gaps or overlaps."
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {config.labels.map((row, idx) => (
              <div
                key={row.key || idx}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.2fr 0.6fr 0.6fr 2fr",
                  gap: 12,
                  alignItems: "end",
                  paddingBottom: 12,
                  borderBottom: idx === config.labels.length - 1 ? "none" : `1px solid ${D.border}`,
                }}
              >
                <TextField
                  label={`Name (${row.key})`}
                  value={row.name}
                  onChange={(v) => setLabel(idx, { name: v })}
                />
                <NumberField label="Min" value={row.min} onChange={(v) => setLabel(idx, { min: v })} min={0} max={5} step={0.1} />
                <NumberField label="Max" value={row.max} onChange={(v) => setLabel(idx, { max: v })} min={0} max={5} step={0.1} />
                <TextField label="Description" value={row.description} onChange={(v) => setLabel(idx, { description: v })} />
              </div>
            ))}
          </div>
          {labelError ? (
            <div style={{ marginTop: 12, fontSize: 12, color: D.red }}>{labelError}</div>
          ) : (
            <div style={{ marginTop: 12 }}>
              <Pill tone="success">Coverage 0.0 – 5.0 valid</Pill>
            </div>
          )}
        </Card>

        {/* D. Trend Settings */}
        <Card>
          <SectionHeading
            label="Trend thresholds"
            description="Defaults: improving ≤ −0.5; stable within ±0.4; increasing from +0.5; significant from +1.0."
          />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <NumberField
              label="Improving at or below (negative)"
              value={config.trendThresholds.improvingAtOrBelow}
              onChange={(v) => setField("trendThresholds.improvingAtOrBelow", v)}
              min={-5} max={0} step={0.1}
            />
            <NumberField
              label="Stable band (± from zero)"
              value={config.trendThresholds.stableBand}
              onChange={(v) => setField("trendThresholds.stableBand", v)}
              min={0} max={2} step={0.1}
            />
            <NumberField
              label="Increasing from"
              value={config.trendThresholds.increasingFrom}
              onChange={(v) => setField("trendThresholds.increasingFrom", v)}
              min={0} max={5} step={0.1}
            />
            <NumberField
              label="Significant increase from"
              value={config.trendThresholds.significantIncreaseFrom}
              onChange={(v) => setField("trendThresholds.significantIncreaseFrom", v)}
              min={0} max={5} step={0.1}
            />
          </div>
          {trendInvalid ? (
            <div style={{ marginTop: 12, fontSize: 12, color: D.red }}>
              Trend thresholds must be: improving &lt; 0; stable ≥ 0; increasing &gt; 0; significant &gt; increasing.
            </div>
          ) : null}
        </Card>

        {/* E. Service Frequency Windows */}
        <Card>
          <SectionHeading
            label="Service frequency windows"
            description="Review window in days for each service frequency."
          />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
            <NumberField label="Monthly" value={config.serviceFrequencyWindows.monthly} onChange={(v) => setField("serviceFrequencyWindows.monthly", v)} min={1} step={1} suffix="days" />
            <NumberField label="Bi-monthly" value={config.serviceFrequencyWindows.bimonthly} onChange={(v) => setField("serviceFrequencyWindows.bimonthly", v)} min={1} step={1} suffix="days" />
            <NumberField label="Quarterly" value={config.serviceFrequencyWindows.quarterly} onChange={(v) => setField("serviceFrequencyWindows.quarterly", v)} min={1} step={1} suffix="days" />
            <NumberField label="Fallback (custom)" value={config.serviceFrequencyWindows.fallbackDays} onChange={(v) => setField("serviceFrequencyWindows.fallbackDays", v)} min={1} step={1} suffix="days" />
          </div>
        </Card>

        {/* F. Client Questions */}
        <Card>
          <SectionHeading
            label="Client rating prompt text"
            description="Shown to customers (or to techs entering on behalf) when capturing the client-reported activity rating."
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <TextField label="Monthly" value={config.clientQuestionText.monthly} onChange={(v) => setField("clientQuestionText.monthly", v)} />
            <TextField label="Bi-monthly" value={config.clientQuestionText.bimonthly} onChange={(v) => setField("clientQuestionText.bimonthly", v)} />
            <TextField label="Quarterly" value={config.clientQuestionText.quarterly} onChange={(v) => setField("clientQuestionText.quarterly", v)} />
            <TextField label="Custom / unknown" value={config.clientQuestionText.custom} onChange={(v) => setField("clientQuestionText.custom", v)} />
          </div>
          <div style={{ marginTop: 16 }}>
            <TextArea
              label="Customer-facing explanation"
              rows={6}
              value={config.customerExplanationText}
              onChange={(v) => setField("customerExplanationText", v)}
            />
          </div>
        </Card>

        {/* G. Preview */}
        <Card>
          <SectionHeading
            icon={Sparkles}
            label="Preview"
            description="Run the engine with sample inputs and your current (unsaved) settings."
          />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
            {Object.entries({
              clientRating: "Client rating",
              technicianRating: "Technician rating",
              reServiceImpact: "Re-service impact",
              recurringIssueRating: "Recurring issue",
              riskFactorRating: "Risk factor",
              previousScore: "Previous score",
            }).map(([k, label]) => (
              <NumberField
                key={k}
                label={label}
                value={previewInputs[k] === null ? "" : previewInputs[k]}
                onChange={(v) => setPreviewInputs((p) => ({ ...p, [k]: v === "" ? null : v }))}
                min={0} max={5} step={0.1}
              />
            ))}
          </div>
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              onClick={runPreview}
              disabled={previewLoading}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "8px 14px", borderRadius: 6, border: `1px solid ${D.inputBorder}`,
                background: D.white, color: D.text, fontSize: 13, fontWeight: 500, cursor: "pointer",
              }}
            >
              <Eye size={14} /> {previewLoading ? "Running…" : "Run preview"}
            </button>
          </div>
          {previewError ? (
            <div style={{ marginTop: 12, fontSize: 13, color: D.red }}>{previewError}</div>
          ) : null}
          {previewResult ? (
            <div style={{ marginTop: 16, padding: 16, background: D.subtle, borderRadius: 8 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                <div style={{ fontSize: 32, fontWeight: 700, color: D.heading, fontFamily: "'JetBrains Mono', monospace" }}>
                  {previewResult.score === null ? "—" : previewResult.score.toFixed(1)}
                </div>
                <div style={{ fontSize: 14, color: D.muted }}>/ 5</div>
                {previewResult.label ? (
                  <Pill tone="neutral">{previewResult.label.name}</Pill>
                ) : null}
                <Pill tone={previewResult.dataCompleteness === "complete" ? "success" : previewResult.dataCompleteness === "insufficient" ? "error" : "warning"}>
                  {previewResult.dataCompleteness}
                </Pill>
                <Pill tone="neutral">trend: {previewResult.trend}</Pill>
                {previewResult.trendDelta !== null ? (
                  <Pill tone="neutral">Δ {previewResult.trendDelta > 0 ? "+" : ""}{previewResult.trendDelta.toFixed(1)}</Pill>
                ) : null}
              </div>
              {previewResult.summary ? (
                <p style={{ fontSize: 13, color: D.text, marginTop: 12 }}>{previewResult.summary}</p>
              ) : null}
              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: "pointer", fontSize: 12, color: D.muted }}>Calculation breakdown</summary>
                <pre style={{ marginTop: 8, fontSize: 11, color: D.text, background: D.white, padding: 12, borderRadius: 6, border: `1px solid ${D.border}`, overflow: "auto" }}>
                  {JSON.stringify({
                    componentScores: previewResult.componentScores,
                    componentWeights: previewResult.componentWeights,
                    missingComponents: previewResult.missingComponents,
                    calculationVersion: previewResult.calculationVersion,
                  }, null, 2)}
                </pre>
              </details>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
