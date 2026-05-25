// client/src/pages/admin/CommunicationsTabsV2.jsx
// Monochrome V2 of the Templates and CSR Coach tabs used inside CommunicationsPageV2.
// Strict 1:1 with V1 on endpoints, state, and behavior — chrome only.
//
// Endpoints preserved:
//   GET  /admin/sms-templates
//   PUT  /admin/sms-templates/:id
//   GET  /admin/csr/overview?days=30
//   GET  /admin/csr/follow-up-tasks
//   PUT  /admin/csr/follow-up-tasks/:id
//   GET  /admin/csr/weekly-recommendation
//   GET  /admin/csr/leaderboard
//   GET  /admin/csr/lead-quality?days=30
//
// Dual exports: SmsTemplatesTabV2 (Templates tab) +
// CSRCoachTabV2 (CSR Coach tab). Both consumed by CommunicationsPageV2.
//
// Audit focus:
// - SmsTemplates PUT: editing a template that's referenced by an
//   active automation sequence — confirm the change applies to
//   future sends only (no retroactive rewrite of already-sent SMS
//   bodies in the log).
// - is_active toggle: turning off a template that an automation
//   relies on — does the automation gracefully skip, or does it
//   error? Either is OK; silent skip without operator notice is not.
// - Follow-up tasks PUT: marking a task complete is the operator's
//   primary action. Confirm optimistic UI rolls back on PUT failure
//   instead of leaving a lie in the queue.
// - CSR leaderboard PII: surfaces individual CSR call/SMS counts.
//   Should be operator-only (Waves + management); confirm no
//   tech-portal leak.
// - Weekly recommendation: AI-generated coaching summary. Cache it
//   so refresh doesn't re-run Claude; confirm there's a cache key
//   tied to the week boundary (not just a per-render call).
// - Lead-quality breakdown: at scale, /lead-quality?days=30 may
//   return many records. Confirm reasonable bounded response size.
import { useState, useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  Input,
  Select,
  Switch,
  Textarea,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
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
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const unknown = data?.unknown_placeholders?.length
        ? `: ${data.unknown_placeholders.map((key) => `{${key}}`).join(", ")}`
        : "";
      throw new Error(`${data?.error || `HTTP ${r.status}`}${unknown}`);
    }
    return data;
  });
}

function canDeleteSmsTemplate(template) {
  if (template?.can_delete !== undefined) return template.can_delete === true;
  return template?.category === "custom";
}

function variantDraftFrom(variant = {}) {
  return {
    variantKey: variant.variant_key || "",
    name: variant.name || variant.variant_key || "",
    body: variant.body || "",
    weight: variant.weight ?? 1,
    status: variant.status || "active",
    isControl: !!variant.is_control,
  };
}

function variantDraftId(templateKey, variantKey) {
  return `${templateKey}:${variantKey || "__new__"}`;
}

function issueMetadata(issue = {}) {
  const value = issue.metadata || {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function issueTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ── SMS Templates Tab ───────────────────────────────────────────────

export function SmsTemplatesTabV2() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [editBody, setEditBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [saveError, setSaveError] = useState("");
  const [variantsByKey, setVariantsByKey] = useState({});
  const [loadingVariants, setLoadingVariants] = useState(null);
  const [variantDrafts, setVariantDrafts] = useState({});
  const [variantEditing, setVariantEditing] = useState({});
  const [variantErrors, setVariantErrors] = useState({});
  const [variantSaving, setVariantSaving] = useState(null);
  const [templateIssues, setTemplateIssues] = useState([]);
  const [filter, setFilter] = useState("all");
  const [highlightKey, setHighlightKey] = useState(null);
  const hashApplied = useRef(false);

  useEffect(() => {
    adminFetch("/admin/sms-templates")
      .then((d) => {
        setTemplates(d.templates || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    adminFetch("/admin/sms-templates/issues?limit=10")
      .then((d) => setTemplateIssues(d.issues || []))
      .catch(() => setTemplateIssues([]));
  }, []);

  useEffect(() => {
    if (hashApplied.current || !templates.length) return;
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    if (params.get("tab") !== "templates") return;
    const key = params.get("key");
    if (!key) return;
    const match = templates.find((t) => t.template_key === key);
    if (!match) return;
    hashApplied.current = true;
    setFilter("all");
    setHighlightKey(key);
    window.setTimeout(() => {
      document.getElementById(`sms-template-row-${key}`)?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    }, 80);
  }, [templates]);

  const handleSave = async (id) => {
    setSaving(true);
    setSaveError("");
    try {
      await adminFetch(`/admin/sms-templates/${id}`, {
        method: "PUT",
        body: JSON.stringify({ body: editBody }),
      });
      setTemplates((prev) =>
        prev.map((t) => (t.id === id ? { ...t, body: editBody } : t)),
      );
      setEditing(null);
    } catch (err) {
      setSaveError(err.message || "Save failed");
    }
    setSaving(false);
  };

  const loadVariants = async (templateKey) => {
    if (!templateKey || variantsByKey[templateKey]) return;
    setLoadingVariants(templateKey);
    try {
      const data = await adminFetch(`/admin/sms-templates/${templateKey}/variants`);
      setVariantsByKey((prev) => ({
        ...prev,
        [templateKey]: data.variants || [],
      }));
    } catch {
      setVariantsByKey((prev) => ({ ...prev, [templateKey]: [] }));
    }
    setLoadingVariants(null);
  };

  const setVariantDraftField = (draftId, field, value) => {
    setVariantDrafts((prev) => ({
      ...prev,
      [draftId]: {
        ...prev[draftId],
        [field]: value,
      },
    }));
    setVariantErrors((prev) => ({ ...prev, [draftId]: "" }));
  };

  const startNewVariant = (templateKey) => {
    const draftId = variantDraftId(templateKey);
    setVariantDrafts((prev) => ({
      ...prev,
      [draftId]: variantDraftFrom(),
    }));
    setVariantEditing((prev) => ({ ...prev, [draftId]: true }));
    setVariantErrors((prev) => ({ ...prev, [draftId]: "" }));
  };

  const startEditVariant = (templateKey, variant) => {
    const draftId = variantDraftId(templateKey, variant.variant_key);
    setVariantDrafts((prev) => ({
      ...prev,
      [draftId]: variantDraftFrom(variant),
    }));
    setVariantEditing((prev) => ({ ...prev, [draftId]: true }));
    setVariantErrors((prev) => ({ ...prev, [draftId]: "" }));
  };

  const cancelVariantEdit = (draftId) => {
    setVariantEditing((prev) => ({ ...prev, [draftId]: false }));
    setVariantErrors((prev) => ({ ...prev, [draftId]: "" }));
  };

  const saveVariant = async (templateKey, variantKey = null) => {
    const draftId = variantDraftId(templateKey, variantKey);
    const draft = variantDrafts[draftId] || variantDraftFrom();
    const cleanVariantKey = String(draft.variantKey || "").trim();
    if (!variantKey && !cleanVariantKey) {
      setVariantErrors((prev) => ({ ...prev, [draftId]: "Variant key required" }));
      return;
    }
    if (!String(draft.body || "").trim()) {
      setVariantErrors((prev) => ({ ...prev, [draftId]: "Body required" }));
      return;
    }

    setVariantSaving(draftId);
    setVariantErrors((prev) => ({ ...prev, [draftId]: "" }));
    try {
      const payload = {
        variantKey: cleanVariantKey,
        name: draft.name || cleanVariantKey,
        body: draft.body,
        weight: Number(draft.weight || 0),
        status: draft.status || "active",
        isControl: !!draft.isControl,
      };
      const data = await adminFetch(
        variantKey
          ? `/admin/sms-templates/${templateKey}/variants/${variantKey}`
          : `/admin/sms-templates/${templateKey}/variants`,
        {
          method: variantKey ? "PUT" : "POST",
          body: JSON.stringify(payload),
        },
      );
      const saved = data.variant;
      setVariantsByKey((prev) => {
        const current = prev[templateKey] || [];
        const next = current.some((v) => v.variant_key === saved.variant_key)
          ? current.map((v) => (v.variant_key === saved.variant_key ? saved : v))
          : [...current, saved];
        return { ...prev, [templateKey]: next };
      });
      setVariantEditing((prev) => ({ ...prev, [draftId]: false }));
      if (!variantKey) {
        setVariantDrafts((prev) => ({
          ...prev,
          [draftId]: variantDraftFrom(),
        }));
      }
    } catch (err) {
      setVariantErrors((prev) => ({ ...prev, [draftId]: err.message || "Variant save failed" }));
    }
    setVariantSaving(null);
  };

  const deleteVariant = async (templateKey, variantKey) => {
    if (!window.confirm("Delete this SMS variant? This can't be undone.")) return;
    const draftId = variantDraftId(templateKey, variantKey);
    setVariantSaving(draftId);
    try {
      await adminFetch(`/admin/sms-templates/${templateKey}/variants/${variantKey}`, {
        method: "DELETE",
      });
      setVariantsByKey((prev) => ({
        ...prev,
        [templateKey]: (prev[templateKey] || []).filter((v) => v.variant_key !== variantKey),
      }));
    } catch (err) {
      setVariantErrors((prev) => ({ ...prev, [draftId]: err.message || "Variant delete failed" }));
    }
    setVariantSaving(null);
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Delete this SMS template? This can't be undone.")) return;
    setDeleting(id);
    try {
      await adminFetch(`/admin/sms-templates/${id}`, { method: "DELETE" });
      setTemplates((prev) => prev.filter((t) => t.id !== id));
      if (editing === id) setEditing(null);
    } catch {
      alert("Delete failed");
    }
    setDeleting(null);
  };

  const toggleActive = async (t) => {
    await adminFetch(`/admin/sms-templates/${t.id}`, {
      method: "PUT",
      body: JSON.stringify({ is_active: !t.is_active }),
    });
    setTemplates((prev) =>
      prev.map((x) => (x.id === t.id ? { ...x, is_active: !x.is_active } : x)),
    );
  };

  const jumpToTemplate = (templateKey) => {
    if (!templateKey) return;
    setFilter("all");
    setHighlightKey(templateKey);
    window.setTimeout(() => {
      document.getElementById(`sms-template-row-${templateKey}`)?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    }, 80);
  };

  const categories = [...new Set(templates.map((t) => t.category))];
  const filtered =
    filter === "all"
      ? templates
      : templates.filter((t) => t.category === filter);

  if (loading)
    return (
      <div className="p-10 text-center text-ink-tertiary text-13">
        Loading templates…
      </div>
    );

  return (
    <div className="flex flex-col gap-4">
      {" "}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {" "}
        <div className="text-13 text-ink-secondary">
          {" "}
          <span className="font-mono u-nums text-ink-primary">
            {filtered.length}
          </span>
          SMS Templates
        </div>{" "}
        <div className="flex gap-1.5 flex-wrap">
          {" "}
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={cn(
              "min-h-[44px] md:min-h-0 md:h-7 px-3 py-2 md:py-0 inline-flex items-center rounded-xs text-14 md:text-11 normal-case md:uppercase tracking-normal md:tracking-label border-hairline transition-colors",
              filter === "all"
                ? "bg-zinc-900 text-white border-zinc-900"
                : "bg-white text-ink-secondary border-zinc-300 hover:bg-zinc-50",
            )}
          >
            All
          </button>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setFilter(c)}
              className={cn(
                "min-h-[44px] md:min-h-0 md:h-7 px-3 py-2 md:py-0 inline-flex items-center rounded-xs text-14 md:text-11 normal-case md:uppercase tracking-normal md:tracking-label border-hairline transition-colors capitalize",
                filter === c
                  ? "bg-zinc-900 text-white border-zinc-900"
                  : "bg-white text-ink-secondary border-zinc-300 hover:bg-zinc-50",
              )}
            >
              {c}
            </button>
          ))}
        </div>{" "}
      </div>{" "}
      {templateIssues.length ? (
        <Card>
          <CardBody>
            <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
              <div className="text-13 font-medium text-ink-primary">
                Recent Template Issues
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => adminFetch("/admin/sms-templates/issues?limit=10")
                  .then((d) => setTemplateIssues(d.issues || []))
                  .catch(() => setTemplateIssues([]))}
              >
                Refresh
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              {templateIssues.map((issue) => {
                const meta = issueMetadata(issue);
                return (
                  <button
                    key={issue.id || `${meta.template_key}-${issue.created_at}`}
                    type="button"
                    onClick={() => jumpToTemplate(meta.template_key)}
                    className="w-full text-left rounded-xs border-hairline border-zinc-200 bg-zinc-50 hover:bg-zinc-100 transition-colors p-2"
                  >
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <span className="text-12 font-mono text-ink-primary">
                        {meta.template_key || "unknown_template"}
                      </span>
                      <span className="text-11 text-ink-tertiary">
                        {issueTime(issue.created_at)}
                      </span>
                    </div>
                    <div className="mt-1 text-12 text-ink-secondary">
                      {meta.event_type || "render_issue"}: {meta.reason || "Template could not render"}
                    </div>
                    {(meta.workflow || meta.entity_id) ? (
                      <div className="mt-1 text-11 text-ink-tertiary">
                        {[meta.workflow, meta.entity_type, meta.entity_id].filter(Boolean).join(" · ")}
                      </div>
                    ) : null}
                    {meta.unresolved_placeholders?.length ? (
                      <div className="mt-1 text-11 text-alert-fg">
                        {meta.unresolved_placeholders.map((key) => `{${key}}`).join(", ")}
                      </div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </CardBody>
        </Card>
      ) : null}
      <div className="flex flex-col gap-2">
        {filtered.map((t) => (
          <Card
            key={t.id}
            id={`sms-template-row-${t.template_key}`}
            className={cn(
              "transition-shadow",
              highlightKey === t.template_key && "ring-2 ring-zinc-900 ring-offset-2",
            )}
          >
            {" "}
            <CardBody>
              {" "}
              <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
                {" "}
                <div className="flex items-center gap-2 flex-wrap">
                  {" "}
                  <span className="text-13 font-medium text-ink-primary">
                    {t.name}
                  </span>{" "}
                  <Badge tone="neutral" className="capitalize">
                    {t.category}
                  </Badge>
                  {t.is_internal && <Badge tone="neutral">Internal</Badge>}
                </div>{" "}
                <div className="flex items-center gap-2">
                  {" "}
                  <Switch
                    checked={t.is_active}
                    onChange={() => toggleActive(t)}
                  />
                  {editing === t.id ? (
                    <>
                      {" "}
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => handleSave(t.id)}
                        disabled={saving}
                      >
                        {saving ? "…" : "Save"}
                      </Button>{" "}
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </Button>{" "}
                    </>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setEditing(t.id);
                        setSaveError("");
                        setEditBody(t.body);
                        loadVariants(t.template_key);
                      }}
                    >
                      Edit
                    </Button>
                  )}
                  {canDeleteSmsTemplate(t) ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="px-2"
                      aria-label={`Delete ${t.name}`}
                      onClick={() => handleDelete(t.id)}
                      disabled={deleting === t.id}
                    >
                      <Trash2 size={14} />
                    </Button>
                  ) : null}
                </div>{" "}
              </div>
              {editing === t.id ? (
                <div className="flex flex-col gap-2">
                  <Textarea
                    value={editBody}
                    onChange={(e) => {
                      setEditBody(e.target.value);
                      setSaveError("");
                    }}
                    rows={4}
                  />
                  {saveError ? (
                    <div className="text-12 text-alert-fg">{saveError}</div>
                  ) : null}
                  <div className="rounded-xs border-hairline border-zinc-200 bg-zinc-50 p-3">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <div className="text-11 uppercase tracking-label text-ink-tertiary">
                        Variants
                      </div>
                      <div className="flex items-center gap-2">
                        {loadingVariants === t.template_key ? (
                          <div className="text-11 text-ink-tertiary">Loading...</div>
                        ) : null}
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => startNewVariant(t.template_key)}
                        >
                          Add Variant
                        </Button>
                      </div>
                    </div>
                    {variantEditing[variantDraftId(t.template_key)] ? (
                      <div className="mb-2 rounded-xs border-hairline border-zinc-200 bg-white p-2">
                        <div className="grid gap-2 md:grid-cols-4">
                          <Input
                            value={variantDrafts[variantDraftId(t.template_key)]?.variantKey || ""}
                            onChange={(e) => setVariantDraftField(variantDraftId(t.template_key), "variantKey", e.target.value)}
                            placeholder="variant_key"
                          />
                          <Input
                            value={variantDrafts[variantDraftId(t.template_key)]?.name || ""}
                            onChange={(e) => setVariantDraftField(variantDraftId(t.template_key), "name", e.target.value)}
                            placeholder="Name"
                          />
                          <Input
                            type="number"
                            min="0"
                            step="0.1"
                            value={variantDrafts[variantDraftId(t.template_key)]?.weight ?? 1}
                            onChange={(e) => setVariantDraftField(variantDraftId(t.template_key), "weight", e.target.value)}
                          />
                          <Select
                            value={variantDrafts[variantDraftId(t.template_key)]?.status || "active"}
                            onChange={(e) => setVariantDraftField(variantDraftId(t.template_key), "status", e.target.value)}
                          >
                            <option value="active">Active</option>
                            <option value="draft">Draft</option>
                            <option value="paused">Paused</option>
                          </Select>
                        </div>
                        <Textarea
                          className="mt-2"
                          value={variantDrafts[variantDraftId(t.template_key)]?.body || ""}
                          onChange={(e) => setVariantDraftField(variantDraftId(t.template_key), "body", e.target.value)}
                          rows={3}
                          placeholder="Variant body"
                        />
                        <div className="mt-2 flex items-center justify-between gap-3 flex-wrap">
                          <label className="flex items-center gap-2 text-12 text-ink-secondary">
                            <Switch
                              checked={!!variantDrafts[variantDraftId(t.template_key)]?.isControl}
                              onChange={() => setVariantDraftField(
                                variantDraftId(t.template_key),
                                "isControl",
                                !variantDrafts[variantDraftId(t.template_key)]?.isControl,
                              )}
                            />
                            Control
                          </label>
                          <div className="flex items-center gap-2">
                            {variantErrors[variantDraftId(t.template_key)] ? (
                              <div className="text-12 text-alert-fg">
                                {variantErrors[variantDraftId(t.template_key)]}
                              </div>
                            ) : null}
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => saveVariant(t.template_key)}
                              disabled={variantSaving === variantDraftId(t.template_key)}
                            >
                              Save Variant
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => cancelVariantEdit(variantDraftId(t.template_key))}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                    {(variantsByKey[t.template_key] || []).length ? (
                      <div className="flex flex-col gap-2">
                        {variantsByKey[t.template_key].map((variant) => (
                          <div
                            key={variant.id || variant.variant_key}
                            className="flex items-start justify-between gap-3 rounded-xs border-hairline border-zinc-200 bg-white p-2"
                          >
                            {variantEditing[variantDraftId(t.template_key, variant.variant_key)] ? (
                              <div className="min-w-0 flex-1">
                                <div className="grid gap-2 md:grid-cols-4">
                                  <Input
                                    value={variant.variant_key}
                                    disabled
                                  />
                                  <Input
                                    value={variantDrafts[variantDraftId(t.template_key, variant.variant_key)]?.name || ""}
                                    onChange={(e) => setVariantDraftField(variantDraftId(t.template_key, variant.variant_key), "name", e.target.value)}
                                    placeholder="Name"
                                  />
                                  <Input
                                    type="number"
                                    min="0"
                                    step="0.1"
                                    value={variantDrafts[variantDraftId(t.template_key, variant.variant_key)]?.weight ?? 1}
                                    onChange={(e) => setVariantDraftField(variantDraftId(t.template_key, variant.variant_key), "weight", e.target.value)}
                                  />
                                  <Select
                                    value={variantDrafts[variantDraftId(t.template_key, variant.variant_key)]?.status || "active"}
                                    onChange={(e) => setVariantDraftField(variantDraftId(t.template_key, variant.variant_key), "status", e.target.value)}
                                  >
                                    <option value="active">Active</option>
                                    <option value="draft">Draft</option>
                                    <option value="paused">Paused</option>
                                  </Select>
                                </div>
                                <Textarea
                                  className="mt-2"
                                  value={variantDrafts[variantDraftId(t.template_key, variant.variant_key)]?.body || ""}
                                  onChange={(e) => setVariantDraftField(variantDraftId(t.template_key, variant.variant_key), "body", e.target.value)}
                                  rows={3}
                                />
                                <div className="mt-2 flex items-center justify-between gap-3 flex-wrap">
                                  <label className="flex items-center gap-2 text-12 text-ink-secondary">
                                    <Switch
                                      checked={!!variantDrafts[variantDraftId(t.template_key, variant.variant_key)]?.isControl}
                                      onChange={() => setVariantDraftField(
                                        variantDraftId(t.template_key, variant.variant_key),
                                        "isControl",
                                        !variantDrafts[variantDraftId(t.template_key, variant.variant_key)]?.isControl,
                                      )}
                                    />
                                    Control
                                  </label>
                                  <div className="flex items-center gap-2">
                                    {variantErrors[variantDraftId(t.template_key, variant.variant_key)] ? (
                                      <div className="text-12 text-alert-fg">
                                        {variantErrors[variantDraftId(t.template_key, variant.variant_key)]}
                                      </div>
                                    ) : null}
                                    <Button
                                      variant="primary"
                                      size="sm"
                                      onClick={() => saveVariant(t.template_key, variant.variant_key)}
                                      disabled={variantSaving === variantDraftId(t.template_key, variant.variant_key)}
                                    >
                                      Save Variant
                                    </Button>
                                    <Button
                                      variant="secondary"
                                      size="sm"
                                      onClick={() => cancelVariantEdit(variantDraftId(t.template_key, variant.variant_key))}
                                    >
                                      Cancel
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            ) : (
                              <>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-12 font-medium text-ink-primary">
                                      {variant.name || variant.variant_key}
                                    </span>
                                    <Badge tone={variant.status === "active" ? "strong" : "neutral"}>
                                      {variant.status || "draft"}
                                    </Badge>
                                    {variant.is_control ? <Badge tone="neutral">Control</Badge> : null}
                                  </div>
                                  <div className="mt-1 text-12 text-ink-secondary whitespace-pre-wrap">
                                    {variant.body}
                                  </div>
                                </div>
                                <div className="shrink-0 flex items-center gap-2">
                                  <div className="text-11 font-mono u-nums text-ink-tertiary">
                                    w{variant.weight ?? 1}
                                  </div>
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => startEditVariant(t.template_key, variant)}
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="px-2"
                                    aria-label={`Delete ${variant.name || variant.variant_key}`}
                                    onClick={() => deleteVariant(t.template_key, variant.variant_key)}
                                    disabled={variantSaving === variantDraftId(t.template_key, variant.variant_key)}
                                  >
                                    <Trash2 size={14} />
                                  </Button>
                                </div>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-12 text-ink-tertiary">
                        No active SMS variants configured for this template.
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-12 text-ink-secondary leading-relaxed whitespace-pre-wrap">
                  {t.body}
                </div>
              )}
              {t.variables && (
                <div className="mt-2 flex gap-1 flex-wrap">
                  {(typeof t.variables === "string"
                    ? JSON.parse(t.variables)
                    : t.variables
                  ).map((v) => (
                    <span
                      key={v}
                      className="text-10 px-1.5 py-0.5 rounded-xs bg-zinc-50 text-ink-tertiary border-hairline font-mono"
                    >
                      {`{${v}}`}
                    </span>
                  ))}
                </div>
              )}
            </CardBody>{" "}
          </Card>
        ))}
      </div>{" "}
    </div>
  );
}

// ── CSR Coach Tab ───────────────────────────────────────────────────

export function CSRCoachTabV2() {
  const [overview, setOverview] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [weeklyRec, setWeeklyRec] = useState(null);
  const [leaderboard, setLeaderboard] = useState(null);
  const [leadQuality, setLeadQuality] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      adminFetch("/admin/csr/overview?days=30").catch(() => null),
      adminFetch("/admin/csr/follow-up-tasks").catch(() => null),
      adminFetch("/admin/csr/weekly-recommendation").catch(() => null),
      adminFetch("/admin/csr/leaderboard").catch(() => null),
      adminFetch("/admin/csr/lead-quality?days=30").catch(() => null),
    ]).then(([ov, tk, wr, lb, lq]) => {
      setOverview(ov);
      setTasks(tk);
      setWeeklyRec(wr);
      setLeaderboard(lb);
      setLeadQuality(lq);
      setLoading(false);
    });
  }, []);

  const handleTaskUpdate = async (taskId, status) => {
    await adminFetch(`/admin/csr/follow-up-tasks/${taskId}`, {
      method: "PUT",
      body: JSON.stringify({ status }),
    });
    const tk = await adminFetch("/admin/csr/follow-up-tasks");
    setTasks(tk);
  };

  if (loading)
    return (
      <div className="p-10 text-center text-ink-tertiary text-13">
        Loading CSR Coach…
      </div>
    );

  const csrs = overview?.csrStats || [];
  const rateAlert = (r) => r < 40;
  const scoreAlert = (s) => s < 9;

  return (
    <div className="flex flex-col gap-4">
      {/* Team Overview */}
      <Card>
        {" "}
        <CardBody>
          {" "}
          <div className="text-13 font-medium text-ink-primary mb-3">
            Team Overview (Last 30 Days)
          </div>{" "}
          <div className="overflow-x-auto">
            {" "}
            <Table>
              {" "}
              <THead>
                {" "}
                <TR>
                  {" "}
                  <TH>CSR</TH> <TH className="text-right">Calls</TH>{" "}
                  <TH className="text-right">1st-Call Book %</TH>{" "}
                  <TH className="text-right">Avg Score</TH>{" "}
                  <TH className="text-right">Follow-Up %</TH>{" "}
                </TR>{" "}
              </THead>{" "}
              <TBody>
                {csrs.map((c) => (
                  <TR key={c.name}>
                    {" "}
                    <TD>{c.name}</TD>{" "}
                    <TD className="text-right font-mono u-nums">{c.calls}</TD>{" "}
                    <TD
                      className={cn(
                        "text-right font-mono u-nums",
                        rateAlert(c.firstCallBookingRate) && "text-alert-fg",
                      )}
                    >
                      {c.firstCallBookingRate}%
                    </TD>{" "}
                    <TD
                      className={cn(
                        "text-right font-mono u-nums",
                        scoreAlert(c.avgScore) && "text-alert-fg",
                      )}
                    >
                      {c.avgScore}/15
                    </TD>{" "}
                    <TD
                      className={cn(
                        "text-right font-mono u-nums",
                        rateAlert(c.followUpRate) && "text-alert-fg",
                      )}
                    >
                      {c.followUpRate}%
                    </TD>{" "}
                  </TR>
                ))}
                {overview?.teamTotals && (
                  <TR className="border-t-2 border-zinc-300">
                    {" "}
                    <TD className="font-medium">Team</TD>{" "}
                    <TD className="text-right font-mono u-nums font-medium">
                      {overview.teamTotals.calls}
                    </TD>{" "}
                    <TD className="text-right font-mono u-nums font-medium">
                      {overview.teamTotals.bookingRate}%
                    </TD>{" "}
                    <TD className="text-right font-mono u-nums font-medium">
                      {overview.teamTotals.avgScore}/15
                    </TD>{" "}
                    <TD className="text-right text-ink-tertiary">—</TD>{" "}
                  </TR>
                )}
              </TBody>{" "}
            </Table>{" "}
          </div>{" "}
        </CardBody>{" "}
      </Card>
      {/* Weekly Team Focus */}
      {weeklyRec?.recommendation && (
        <Card>
          {" "}
          <CardBody>
            {" "}
            <div className="text-13 font-medium text-ink-primary mb-2">
              This Week's Team Focus
            </div>{" "}
            <div className="p-3 bg-zinc-50 rounded-md mb-3 border-l-[3px] border-l-zinc-900">
              {" "}
              <div className="text-13 text-ink-primary leading-relaxed mb-1.5">
                {weeklyRec.recommendation}
              </div>
              {weeklyRec.dataPoint && (
                <div className="text-12 text-ink-tertiary mb-0.5">
                  {weeklyRec.dataPoint}
                </div>
              )}
              {weeklyRec.estimatedImpact && (
                <div className="text-12 text-ink-secondary">
                  {weeklyRec.estimatedImpact}
                </div>
              )}
            </div>{" "}
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                navigator.clipboard?.writeText(weeklyRec.recommendation)
              }
            >
              Copy to Group Chat
            </Button>{" "}
          </CardBody>{" "}
        </Card>
      )}

      {/* Lead Quality */}
      {leadQuality && (
        <Card>
          {" "}
          <CardBody>
            {" "}
            <div className="text-13 font-medium text-ink-primary mb-1">
              Lead Quality vs CSR Performance
            </div>{" "}
            <div className="text-12 text-ink-tertiary mb-3">
              Lost calls breakdown (last 30 days):
            </div>
            {(leadQuality.lossReasons || []).map((r, i) => {
              const reasonLabels = {
                bad_lead: "Bad leads (CSR couldn't save)",
                csr_missed_script: "CSR missed script",
                pricing: "Price objection unhandled",
                no_availability: "No availability",
                customer_shopping: "Customer shopping",
                after_hours: "After hours",
                no_answer: "No answer",
              };
              const isCsr =
                r.reason === "csr_missed_script" || r.reason === "pricing";
              return (
                <div key={i} className="flex items-center gap-3 mb-1.5">
                  {" "}
                  <div className="flex-1 h-4 bg-zinc-100 rounded-xs overflow-hidden">
                    {" "}
                    <div
                      className={cn(
                        "h-full rounded-xs",
                        isCsr ? "bg-alert-fg" : "bg-zinc-400",
                      )}
                      style={{
                        width: `${r.pct}%`,
                        minWidth: r.pct > 0 ? 4 : 0,
                      }}
                    />{" "}
                  </div>{" "}
                  <span
                    className={cn(
                      "text-12 w-[250px] text-right",
                      isCsr ? "text-alert-fg" : "text-ink-secondary",
                    )}
                  >
                    {reasonLabels[r.reason] || r.reason}
                  </span>{" "}
                  <span className="text-12 font-mono u-nums text-ink-tertiary w-9 text-right">
                    {r.pct}%
                  </span>{" "}
                </div>
              );
            })}
            {overview?.fixableLossCount > 0 && (
              <div className="mt-3 p-3 bg-alert-bg rounded-md border-l-[3px] border-l-alert-fg">
                {" "}
                <span className="text-13 text-alert-fg font-medium">
                  {overview.fixableLossCount} fixable CSR errors = ~$
                  {overview.fixableRevenue?.toLocaleString()}/mo in lost
                  bookings
                </span>{" "}
              </div>
            )}
          </CardBody>{" "}
        </Card>
      )}

      {/* Follow-Up Tasks */}
      <Card>
        {" "}
        <CardBody>
          {" "}
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            {" "}
            <div className="text-13 font-medium text-ink-primary">
              Follow-Up Tasks
            </div>{" "}
            <div className="text-12 text-ink-tertiary">
              Pending:{" "}
              <span className="font-mono u-nums text-ink-secondary">
                {tasks?.pending || 0}
              </span>{" "}
              <span className="mx-2">·</span>Overdue:{" "}
              <span
                className={cn(
                  "font-mono u-nums",
                  tasks?.overdue > 0 ? "text-alert-fg" : "text-ink-tertiary",
                )}
              >
                {tasks?.overdue || 0}
              </span>{" "}
            </div>{" "}
          </div>
          {(tasks?.tasks || []).length === 0 ? (
            <div className="p-5 text-center text-ink-tertiary text-13">
              No pending follow-up tasks
            </div>
          ) : (
            (tasks?.tasks || []).slice(0, 10).map((t) => {
              const isOverdue =
                t.status === "pending" && new Date(t.deadline) < new Date();
              return (
                <div
                  key={t.id}
                  className={cn(
                    "p-3 bg-zinc-50 rounded-md mb-2 border-l-[3px]",
                    isOverdue ? "border-l-alert-fg" : "border-l-zinc-400",
                  )}
                >
                  {" "}
                  <div className="flex justify-between items-start mb-1 gap-2 flex-wrap">
                    {" "}
                    <div
                      className={cn(
                        "text-13 font-medium",
                        isOverdue ? "text-alert-fg" : "text-ink-primary",
                      )}
                    >
                      {isOverdue ? "OVERDUE" : "DUE"}: {t.assigned_to} —{" "}
                      {t.task_type?.replace(/_/g, " ")}
                      {t.first_name && ` ${t.first_name} ${t.last_name || ""}`}
                    </div>{" "}
                    <span className="text-10 text-ink-tertiary font-mono u-nums">
                      {new Date(t.deadline).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>{" "}
                  </div>{" "}
                  <div className="text-12 text-ink-secondary mb-2 leading-relaxed">
                    {t.recommended_action}
                  </div>{" "}
                  <div className="flex gap-1.5">
                    {" "}
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleTaskUpdate(t.id, "completed")}
                    >
                      Mark Done
                    </Button>{" "}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleTaskUpdate(t.id, "in_progress")}
                    >
                      Reassign
                    </Button>{" "}
                  </div>{" "}
                </div>
              );
            })
          )}
        </CardBody>{" "}
      </Card>
      {/* Bonus Leaderboard */}
      {leaderboard && (
        <Card>
          {" "}
          <CardBody>
            {" "}
            <div className="text-13 font-medium text-ink-primary mb-0.5">
              Bonus Leaderboard
            </div>{" "}
            <div className="text-12 text-ink-tertiary mb-3">
              Period: {leaderboard.periodLabel}
            </div>
            {(leaderboard.categories || []).map((cat, i) => (
              <div
                key={i}
                className="flex items-center gap-3 p-3 bg-zinc-50 rounded-md mb-1.5"
              >
                {" "}
                <div className="flex-1">
                  {" "}
                  <div className="text-13 text-ink-primary font-medium">
                    {cat.category}: {cat.winner || "TBD"}
                  </div>{" "}
                  <div className="text-12 text-ink-secondary">
                    {cat.value}
                  </div>{" "}
                </div>{" "}
                <div className="text-14 font-medium font-mono u-nums text-ink-primary">
                  ${cat.bonus}
                </div>{" "}
              </div>
            ))}
          </CardBody>{" "}
        </Card>
      )}
    </div>
  );
}
