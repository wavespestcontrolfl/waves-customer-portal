import React, { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ClipboardList,
  Eye,
  ListChecks,
  RefreshCw,
  Save,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  Switch,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
  UiSurface,
  cn,
} from "../../components/ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

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

function SectionHeading({ icon: Icon, label, description }) {
  return (
    <div>
      <div className="flex items-center gap-2">
        {Icon ? <Icon size={17} aria-hidden className="text-zinc-900" /> : null}
        <h2 className="text-16 leading-[1.4] font-medium text-zinc-900">{label}</h2>
      </div>
      {description ? (
        <p className="mt-1 text-ui-body text-ink-secondary">{description}</p>
      ) : null}
    </div>
  );
}

function Toggle({ checked, onChange, label, description }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-4 border-b border-hairline border-zinc-200 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-zinc-900">{label}</div>
        {description ? (
          <div className="mt-1 text-ui-caption text-ink-secondary">{description}</div>
        ) : null}
      </div>
      <Switch checked={checked} onChange={onChange} aria-label={label} />
    </div>
  );
}

function NumberField({ value, onChange, min, max, step = 0.1, suffix, label }) {
  // Main rendered the unit beside the input rather than folding it into the
  // label text, so the visible label string stays 1:1. Field requires its
  // single child to be the labelable control itself (it clones an id/htmlFor
  // association onto it), so the suffix renders as a sibling instead of
  // wrapping the Input in an extra div — but it still needs to reach the
  // input's accessible name/description, or screen readers drop the unit.
  const suffixId = useId();
  return (
    <div className={suffix ? "flex items-end gap-2" : undefined}>
      <Field label={label} className={suffix ? "flex-1" : undefined}>
        <Input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const next = e.target.value === "" ? "" : Number(e.target.value);
            onChange(next);
          }}
          className="u-nums"
          aria-describedby={suffix ? suffixId : undefined}
        />
      </Field>
      {suffix ? <span id={suffixId} className="pb-2 text-ui-caption text-ink-secondary">{suffix}</span> : null}
    </div>
  );
}

function TextField({ value, onChange, label }) {
  return (
    <Field label={label}>
      <Input
        type="text"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function TextArea({ value, onChange, label, rows = 4 }) {
  return (
    <Field label={label}>
      <Textarea
        value={value || ""}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function SelectField({ value, onChange, label, options }) {
  return (
    <Field label={label}>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </Select>
    </Field>
  );
}

function Pill({ tone = "neutral", children }) {
  const badgeTone = tone === "success" ? "strong" : tone === "error" ? "alert" : tone === "warning" ? "warn" : "neutral";
  return <Badge tone={badgeTone}>{children}</Badge>;
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

  const [recentScores, setRecentScores] = useState([]);
  const [auditEvents, setAuditEvents] = useState([]);
  const [scoresLoading, setScoresLoading] = useState(false);
  const [scoresError, setScoresError] = useState(null);
  const [busyRowId, setBusyRowId] = useState(null);
  const [overrideTarget, setOverrideTarget] = useState(null);
  const [overrideScore, setOverrideScore] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideError, setOverrideError] = useState(null);
  const [overrideSaving, setOverrideSaving] = useState(false);

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

  const enabledLinesValid = config && Array.isArray(config.enabledServiceLines) && config.enabledServiceLines.length > 0;
  const canSave = config && weightValid && !labelError && !trendInvalid && enabledLinesValid;

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

  const refreshScores = useCallback(async () => {
    setScoresLoading(true);
    setScoresError(null);
    try {
      const [recentBody, auditBody] = await Promise.all([
        adminFetch("/admin/pest-pressure/scores/recent?limit=25"),
        adminFetch("/admin/pest-pressure/audit?limit=25"),
      ]);
      setRecentScores(recentBody.scores || []);
      setAuditEvents(auditBody.events || []);
    } catch (err) {
      setScoresError(err.message);
    } finally {
      setScoresLoading(false);
    }
  }, []);

  useEffect(() => { refreshScores(); }, [refreshScores]);

  const handleRecalculate = async (row, clearOverride) => {
    if (clearOverride && !window.confirm("Recalculate AND drop the existing override?")) return;
    setBusyRowId(row.service_record_id);
    try {
      await adminFetch(`/admin/pest-pressure/scores/${row.service_record_id}/recalculate`, {
        method: "POST",
        body: JSON.stringify({ clearOverride: Boolean(clearOverride) }),
      });
      await refreshScores();
    } catch (err) {
      setScoresError(err.message);
    } finally {
      setBusyRowId(null);
    }
  };

  const openOverrideModal = (row) => {
    setOverrideTarget(row);
    setOverrideScore(row.displayed_score != null ? String(row.displayed_score) : "");
    setOverrideReason(row.override_reason || "");
    setOverrideError(null);
  };

  const closeOverrideModal = () => {
    setOverrideTarget(null);
    setOverrideScore("");
    setOverrideReason("");
    setOverrideError(null);
  };

  const submitOverride = async () => {
    if (!overrideTarget) return;
    const num = Number(overrideScore);
    if (!Number.isFinite(num) || num < 0 || num > 5) {
      setOverrideError("Score must be a number between 0 and 5.");
      return;
    }
    const trimmed = overrideReason.trim();
    if (!trimmed) {
      setOverrideError("A reason is required.");
      return;
    }
    setOverrideSaving(true);
    setOverrideError(null);
    try {
      await adminFetch(`/admin/pest-pressure/scores/${overrideTarget.service_record_id}/override`, {
        method: "PUT",
        body: JSON.stringify({ displayedScore: num, reason: trimmed }),
      });
      closeOverrideModal();
      await refreshScores();
    } catch (err) {
      setOverrideError(err.body?.error || err.message);
    } finally {
      setOverrideSaving(false);
    }
  };

  const handleRemoveOverride = async (row) => {
    if (!window.confirm(`Remove override and restore the calculated score (${row.calculated_score})?`)) return;
    setBusyRowId(row.service_record_id);
    try {
      await adminFetch(`/admin/pest-pressure/scores/${row.service_record_id}/override`, {
        method: "DELETE",
      });
      await refreshScores();
    } catch (err) {
      setScoresError(err.message);
    } finally {
      setBusyRowId(null);
    }
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
    return (
      <UiSurface density="comfortable" className="mx-auto max-w-[1300px] text-ui-body text-ink-primary">
        <AdminCommandHeader variant="workspace" title="Pest pressure" icon={ShieldAlert} sticky={false} />
        <ActionFeedback className="min-h-20">Loading Pest Pressure settings…</ActionFeedback>
      </UiSurface>
    );
  }
  if (!config) {
    return (
      <UiSurface density="comfortable" className="mx-auto max-w-[1300px] text-ui-body text-ink-primary">
        <AdminCommandHeader variant="workspace" title="Pest pressure" icon={ShieldAlert} sticky={false} />
        <ActionFeedback error className="min-h-20">Could not load settings. {saveError || ""}</ActionFeedback>
      </UiSurface>
    );
  }

  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1300px] text-ui-body text-ink-primary">
      <div className="space-y-5">
        <AdminCommandHeader
          variant="workspace"
          title="Pest pressure"
          icon={ShieldAlert}
          sticky={false}
          actions={[
            { key: "restore", label: "Restore defaults", icon: RotateCcw, variant: "secondary", onClick: handleRestoreDefaults },
            {
              key: "save",
              label: saving ? "Saving…" : "Save changes",
              icon: Save,
              onClick: handleSave,
              disabled: !canSave || saving,
            },
          ]}
        />
        <p className="max-w-3xl text-ui-body text-ink-secondary">
          Configure the 0–5 Pest Pressure score that appears on customer service reports.
        </p>

        {saveError ? <ActionFeedback error>{saveError}</ActionFeedback> : null}
        {saveMessage ? <ActionFeedback>{saveMessage}</ActionFeedback> : null}

        {/* A. General */}
        <Card>
          <CardHeader><SectionHeading label="General" description="Enable the feature, control customer-facing visibility, and pick how the score behaves when inputs are missing." /></CardHeader>
          <CardBody>
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
          <div className="mt-4 max-w-xl">
            <SelectField
              label="Missing data behavior"
              value={config.missingDataBehavior}
              onChange={(v) => setField("missingDataBehavior", v)}
              options={MISSING_DATA_OPTIONS}
            />
          </div>
          <div className="mt-4">
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
          </CardBody>
        </Card>

        {/* A.5 Service Lines */}
        <Card>
          <CardHeader><SectionHeading label="Service line scope" description="Pest Pressure runs only on the service lines selected here. The multi-visit-trend model is built for recurring pest control; other lines (lawn, tree & shrub) probably shouldn't show a card." /></CardHeader>
          <CardBody>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { key: "pest", label: "Pest control" },
              { key: "mosquito", label: "Mosquito (WaveGuard)" },
              { key: "rodent", label: "Rodent" },
              { key: "termite", label: "Termite (bait monitoring)" },
              { key: "lawn", label: "Lawn care" },
              { key: "tree_shrub", label: "Tree & shrub" },
              { key: "palm", label: "Palm injection" },
            ].map((line) => {
              const enabledLines = Array.isArray(config.enabledServiceLines) ? config.enabledServiceLines : [];
              const checked = enabledLines.includes(line.key);
              return (
                <label key={line.key} className={cn("flex min-h-11 cursor-pointer items-center gap-3 rounded-sm border-hairline px-3 py-2", checked ? "border-zinc-900 bg-zinc-100" : "border-zinc-300 bg-white")}>
                  <Checkbox
                    checked={checked}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? Array.from(new Set([...enabledLines, line.key]))
                        : enabledLines.filter((k) => k !== line.key);
                      setField("enabledServiceLines", next);
                    }}
                  />
                  <span className="text-ui-body text-zinc-900">{line.label}</span>
                </label>
              );
            })}
          </div>
          {(!Array.isArray(config.enabledServiceLines) || config.enabledServiceLines.length === 0) ? (
            <ActionFeedback error className="mt-3">Select at least one service line.</ActionFeedback>
          ) : null}
          <div className="mt-4">
            <Toggle
              label="Skip one-time services"
              description="When on, services explicitly labelled 'one-time' (or 'single visit', 'one-off', 'spot treatment', 'just once') are skipped — the model needs a recurring plan to compare against. Unknown-frequency labels (e.g. 'General Pest Control') are treated as recurring."
              checked={Boolean(config.requireRecurringFrequency)}
              onChange={(v) => setField("requireRecurringFrequency", v)}
            />
          </div>
          </CardBody>
        </Card>

        {/* B. Score Formula */}
        <Card>
          <CardHeader><SectionHeading label="Score formula" description="Component weights as percentages. Must total 100." /></CardHeader>
          <CardBody>
          <div className="grid gap-3 sm:grid-cols-2">
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
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Pill tone={weightValid ? "success" : "error"}>
              Total: {weightTotal.toFixed(0)}%
            </Pill>
            {!weightValid ? (
              <span className="text-ui-body text-alert-fg">Weights must total 100%.</span>
            ) : null}
          </div>
          </CardBody>
        </Card>

        {/* C. Score Labels */}
        <Card>
          <CardHeader><SectionHeading label="Score labels" description="Editable bands for the 0–5 score. Ranges must cover 0–5 with no gaps or overlaps." /></CardHeader>
          <CardBody>
          <div className="grid gap-4">
            {config.labels.map((row, idx) => (
              <div
                key={row.key || idx}
                className="grid items-end gap-3 border-b border-hairline border-zinc-200 pb-4 last:border-b-0 last:pb-0 sm:grid-cols-2 lg:grid-cols-[1.2fr_0.6fr_0.6fr_2fr]"
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
            <ActionFeedback error className="mt-4">{labelError}</ActionFeedback>
          ) : (
            <div className="mt-4">
              <Pill tone="success">Coverage 0.0 – 5.0 valid</Pill>
            </div>
          )}
          </CardBody>
        </Card>

        {/* Trend settings */}
        <Card>
          <CardHeader><SectionHeading label="Trend thresholds" description="Defaults: improving ≤ −0.5; stable within ±0.4; increasing from +0.5; significant from +1.0." /></CardHeader>
          <CardBody>
          <div className="grid gap-3 sm:grid-cols-2">
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
            <ActionFeedback error className="mt-4">
              Trend thresholds must be: improving &lt; 0; stable ≥ 0; increasing &gt; 0; significant &gt; increasing.
            </ActionFeedback>
          ) : null}
          </CardBody>
        </Card>

        {/* E. Service Frequency Windows */}
        <Card>
          <CardHeader><SectionHeading label="Service frequency windows" description="Review window in days for each service frequency." /></CardHeader>
          <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <NumberField label="Monthly" value={config.serviceFrequencyWindows.monthly} onChange={(v) => setField("serviceFrequencyWindows.monthly", v)} min={1} step={1} suffix="days" />
            <NumberField label="Bi-monthly" value={config.serviceFrequencyWindows.bimonthly} onChange={(v) => setField("serviceFrequencyWindows.bimonthly", v)} min={1} step={1} suffix="days" />
            <NumberField label="Quarterly" value={config.serviceFrequencyWindows.quarterly} onChange={(v) => setField("serviceFrequencyWindows.quarterly", v)} min={1} step={1} suffix="days" />
            <NumberField label="Semi-annual" value={config.serviceFrequencyWindows.semiannual} onChange={(v) => setField("serviceFrequencyWindows.semiannual", v)} min={1} step={1} suffix="days" />
            <NumberField label="Fallback (custom)" value={config.serviceFrequencyWindows.fallbackDays} onChange={(v) => setField("serviceFrequencyWindows.fallbackDays", v)} min={1} step={1} suffix="days" />
          </CardBody>
        </Card>

        {/* F. Client Questions */}
        <Card>
          <CardHeader><SectionHeading label="Client rating prompt text" description="Shown to customers (or to techs entering on behalf) when capturing the client-reported activity rating." /></CardHeader>
          <CardBody className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Monthly" value={config.clientQuestionText.monthly} onChange={(v) => setField("clientQuestionText.monthly", v)} />
            <TextField label="Bi-monthly" value={config.clientQuestionText.bimonthly} onChange={(v) => setField("clientQuestionText.bimonthly", v)} />
            <TextField label="Quarterly" value={config.clientQuestionText.quarterly} onChange={(v) => setField("clientQuestionText.quarterly", v)} />
            <TextField label="Custom / unknown" value={config.clientQuestionText.custom} onChange={(v) => setField("clientQuestionText.custom", v)} />
          </div>
          <div>
            <TextArea
              label="Customer-facing explanation"
              rows={6}
              value={config.customerExplanationText}
              onChange={(v) => setField("customerExplanationText", v)}
            />
          </div>
          </CardBody>
        </Card>

        {/* G. Preview */}
        <Card>
          <CardHeader><SectionHeading icon={Sparkles} label="Preview" description="Run the engine with sample inputs and your current (unsaved) settings." /></CardHeader>
          <CardBody>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
          <div className="mt-4">
            <Button
              variant="secondary"
              onClick={runPreview}
              loading={previewLoading}
              className="gap-2"
            >
              <Eye size={16} aria-hidden /> {previewLoading ? "Running…" : "Run preview"}
            </Button>
          </div>
          {previewError ? (
            <ActionFeedback error className="mt-4">{previewError}</ActionFeedback>
          ) : null}
          {previewResult ? (
            <div className="mt-4 rounded-md border-hairline border-zinc-200 bg-zinc-50 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="text-28 leading-none font-medium text-zinc-900 u-nums">
                  {previewResult.score === null ? "—" : previewResult.score.toFixed(1)}
                </div>
                <div className="text-ui-body text-ink-secondary">/ 5</div>
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
                <p className="mt-3 text-ui-body text-zinc-700">{previewResult.summary}</p>
              ) : null}
              <details className="mt-3 rounded-md border-hairline border-zinc-200 bg-white p-3">
                <summary className="min-h-11 cursor-pointer py-2 text-ui-body text-ink-secondary u-focus-ring">Calculation breakdown</summary>
                <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 text-14 leading-relaxed text-zinc-700 u-nums">
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
          </CardBody>
        </Card>

        {/* H. Recent Scores */}
        <Card>
          <CardHeader><SectionHeading icon={ListChecks} label="Recent scores" description="Latest 25 calculated Pest Pressure scores across all customers. Use Recalculate to refresh with current source data; Override to set a specific number with a recorded reason." /></CardHeader>
          <CardBody className="p-0">
          {scoresError ? (
            <ActionFeedback error className="m-4">{scoresError}</ActionFeedback>
          ) : null}
          {scoresLoading ? (
            <ActionFeedback className="m-4 min-h-16">Loading…</ActionFeedback>
          ) : recentScores.length === 0 ? (
            <div className="p-6 text-center text-ink-secondary">
              No Pest Pressure scores yet. They appear after the next service report completes.
            </div>
          ) : (
            <Table className="min-w-[880px]" aria-label="Recent Pest Pressure scores">
                <THead>
                  <TR>
                    <TH>Date</TH>
                    <TH>Customer</TH>
                    <TH>Line</TH>
                    <TH align="right">Calc</TH>
                    <TH align="right">Shown</TH>
                    <TH>Label</TH>
                    <TH>Trend</TH>
                    <TH>State</TH>
                    <TH>Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {recentScores.map((row) => {
                    const busy = busyRowId === row.service_record_id;
                    return (
                      <TR key={row.id}>
                        <TD className="whitespace-nowrap u-nums">
                          {row.service_date ? String(row.service_date).slice(0, 10) : "—"}
                        </TD>
                        <TD>
                          <Link className="inline-flex min-h-11 items-center font-medium text-zinc-900 underline decoration-zinc-300 underline-offset-2 u-focus-ring" to={`/admin/customers?customerId=${encodeURIComponent(row.customer_id)}`}>
                            {row.customer_name || row.customer_id}
                          </Link>
                        </TD>
                        <TD className="text-ink-secondary">{row.service_line || "—"}</TD>
                        <TD align="right" nums className="text-ink-secondary">
                          {row.calculated_score == null ? "—" : Number(row.calculated_score).toFixed(1)}
                        </TD>
                        <TD align="right" nums className="font-medium">
                          {row.displayed_score == null ? "—" : Number(row.displayed_score).toFixed(1)}
                        </TD>
                        <TD>{row.label_name || "—"}</TD>
                        <TD className="text-ink-secondary">{row.trend}</TD>
                        <TD>
                          {row.is_overridden
                            ? <Pill tone="warning"><ShieldAlert size={14} aria-hidden /> override</Pill>
                            : <Pill tone="neutral">calc</Pill>}
                        </TD>
                        <TD>
                          <div className="flex flex-wrap gap-2">
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() => handleRecalculate(row, false)}
                            title="Re-run the engine with current source data"
                          >
                            <RefreshCw size={15} aria-hidden /> Recalc
                          </Button>
                          {row.is_overridden ? (
                            <Button
                              variant="secondary"
                              disabled={busy}
                              onClick={() => handleRemoveOverride(row)}
                            >
                              Remove override
                            </Button>
                          ) : (
                            <Button
                              variant="secondary"
                              disabled={busy || !config.allowManualOverride}
                              onClick={() => openOverrideModal(row)}
                              title={!config.allowManualOverride ? "Overrides disabled in General settings" : ""}
                            >
                              Override
                            </Button>
                          )}
                          </div>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
          )}
          </CardBody>
        </Card>

        {/* I. Audit log */}
        <Card>
          <CardHeader><SectionHeading icon={ClipboardList} label="Audit log" description="Recent admin actions on Pest Pressure: config updates and score overrides. Sourced from the generic audit_log table." /></CardHeader>
          <CardBody>
          {auditEvents.length === 0 ? (
            <div className="py-4 text-center text-ink-secondary">No Pest Pressure audit events yet.</div>
          ) : (
            <div className="grid gap-3">
              {auditEvents.map((evt) => (
                <details key={evt.id} className="rounded-md border-hairline border-zinc-200 p-3">
                  <summary className="flex min-h-11 cursor-pointer flex-wrap items-center justify-between gap-3 py-2 text-ui-body text-zinc-700 u-focus-ring">
                    <span className="flex flex-wrap items-center gap-2">
                      <Pill tone={evt.action.includes("override") ? "warning" : "neutral"}>{evt.action}</Pill>
                      <span className="text-ink-secondary">{evt.actor_type} {evt.actor_id ? `· ${String(evt.actor_id).slice(0, 8)}` : ""}</span>
                    </span>
                    <span className="text-ui-caption text-ink-secondary u-nums">{evt.created_at ? new Date(evt.created_at).toLocaleString("en-US", { timeZone: "America/New_York" }) : ""}</span>
                  </summary>
                  <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 text-14 leading-relaxed text-zinc-700 u-nums">
                    {JSON.stringify(evt.metadata, null, 2)}
                  </pre>
                </details>
              ))}
            </div>
          )}
          </CardBody>
        </Card>
      </div>

      {/* Override modal */}
      <Dialog open={Boolean(overrideTarget)} onClose={closeOverrideModal} size="md">
        {overrideTarget ? (
          <>
            <DialogHeader className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <DialogTitle>Override Pest Pressure score</DialogTitle>
                <p className="mt-2 text-ui-body text-ink-secondary">
                  Customer: <strong className="font-medium text-zinc-900">{overrideTarget.customer_name || overrideTarget.customer_id}</strong>
                  {" · "}Service date: {overrideTarget.service_date ? String(overrideTarget.service_date).slice(0, 10) : "—"}
                </p>
                <p className="mt-1 text-ui-body text-ink-secondary">
                  Calculated: <strong className="font-medium text-zinc-900 u-nums">{overrideTarget.calculated_score == null ? "—" : Number(overrideTarget.calculated_score).toFixed(1)}</strong>
                  {" · "}Currently shown: <strong className="font-medium text-zinc-900 u-nums">{overrideTarget.displayed_score == null ? "—" : Number(overrideTarget.displayed_score).toFixed(1)}</strong>
                </p>
              </div>
              <Button variant="ghost" onClick={closeOverrideModal} aria-label="Close" className="shrink-0 px-3">
                <X size={18} aria-hidden />
              </Button>
            </DialogHeader>
            <DialogBody className="space-y-3">
              <NumberField
                label="New displayed score (0–5)"
                value={overrideScore}
                onChange={(v) => setOverrideScore(v === "" ? "" : String(v))}
                min={0} max={5} step={0.1}
              />
              <Field label="Reason (required, audited)" required>
                <Textarea
                  value={overrideReason}
                  rows={3}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="Why are you overriding this score? Customer dispute, data correction, etc."
                />
              </Field>
              {overrideError ? (
                <ActionFeedback error>{overrideError}</ActionFeedback>
              ) : null}
            </DialogBody>
            <DialogFooter>
              <Button variant="secondary" onClick={closeOverrideModal}>
                Cancel
              </Button>
              <Button onClick={submitOverride} loading={overrideSaving}>
                {overrideSaving ? "Saving…" : "Save override"}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </Dialog>
    </UiSurface>
  );
}
