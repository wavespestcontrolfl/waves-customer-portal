import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Copy,
  Eye,
  FileText,
  Link2,
  Plus,
  RefreshCw,
  Save,
  Send,
  UserRound,
  X,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { Badge, Button, Card, CardBody, cn } from "../../components/ui";
import { adminFetch as rawAdminFetch } from "../../lib/adminFetch";

const CATEGORY_TABS = [
  { key: "all", label: "All" },
  { key: "service_agreement", label: "Agreements" },
  { key: "wdo", label: "WDO" },
  { key: "prep_form", label: "Prep" },
  { key: "notice", label: "Notices" },
  { key: "marketing", label: "Marketing" },
];

const EMPTY_TEMPLATE = {
  templateKey: "",
  name: "",
  category: "service_agreement",
  documentType: "service_agreement",
  status: "active",
  description: "",
  requiresSignature: true,
  variables: [],
  tags: [],
  defaultDeliveryChannel: "email",
  reminderScheduleDays: [1, 3, -1],
  expireAfterDays: 14,
};

const EMPTY_VERSION = {
  title: "",
  body: "",
  signerDisclosure: "I agree to receive and sign this document electronically.",
  requiredFields: ["initials", "signedName"],
};

const DEFAULT_PREVIEW_CONTEXT = {
  customer: {
    name: "Jordan Customer",
    address: "123 Gulf Breeze Ave, Bradenton FL 34211",
    email: "customer@example.com",
    phone: "(941) 555-0100",
  },
  service: {
    name: "Quarterly Pest Control",
    date: "2026-06-10",
  },
  agreement: {
    start_date: "2026-06-10",
  },
  inspection: {
    date: "2026-06-10",
  },
};

const DEFAULT_SEND_VALUES = {
  serviceName: "Quarterly Pest Control",
  agreementStartDate: "2026-06-10",
  serviceDate: "2026-06-10",
  inspectionDate: "2026-06-10",
};

const BULK_AUDIENCES = [
  { value: "active_pest", label: "Active pest customers" },
  { value: "active_lawn", label: "Active lawn customers" },
  { value: "active_customers", label: "Active customers" },
  { value: "upcoming_service", label: "Upcoming service" },
  { value: "recent_service", label: "Recent service" },
  { value: "all", label: "All customers" },
];

const BULK_GUIDE_TYPES = [
  { value: "pest", label: "Pest control" },
  { value: "lawn", label: "Lawn care" },
  { value: "all", label: "All products" },
];

const BULK_CHANNELS = [
  { value: "sms", label: "SMS" },
];

function api(path, options = {}) {
  return rawAdminFetch(path, options).then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  });
}

function csvFromArray(value) {
  return Array.isArray(value) ? value.join(", ") : "";
}

function arrayFromCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractVariables(text) {
  const found = new Set();
  String(text || "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key) => {
    found.add(key);
    return _match;
  });
  return [...found].sort();
}

function safeJsonParse(text, fallback = {}) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return fallback;
  }
}

function parseJsonOrThrow(text, label) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

function statusTone(status) {
  if (status === "active") return "strong";
  if (status === "paused") return "alert";
  return "neutral";
}

function numberLabel(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toLocaleString() : "0";
}

function customerName(customer) {
  const fullName = `${customer?.firstName || ""} ${customer?.lastName || ""}`.trim();
  return fullName || customer?.companyName || customer?.email || customer?.phone || "Unnamed customer";
}

function customerSearchLabel(customer) {
  if (!customer) return "";
  return [customerName(customer), customer.address, customer.phone, customer.email].filter(Boolean).join(" · ");
}

function templateFromApi(template) {
  return {
    ...EMPTY_TEMPLATE,
    ...template,
    variables: template?.variables || [],
    tags: template?.tags || [],
  };
}

function versionFromApi(version, template) {
  return {
    ...EMPTY_VERSION,
    title: version?.title || template?.name || "",
    body: version?.body || "",
    signerDisclosure: version?.signerDisclosure || EMPTY_VERSION.signerDisclosure,
    requiredFields: version?.requiredFields?.length ? version.requiredFields : EMPTY_VERSION.requiredFields,
  };
}

function Field({ label, children }) {
  return (
    <label className="grid gap-1 text-11 font-medium uppercase tracking-label text-ink-secondary">
      {label}
      {children}
    </label>
  );
}

function TextInput(props) {
  return (
    <input
      {...props}
      className={cn(
        "h-9 rounded-xs border-hairline border-zinc-300 bg-white px-2 text-13 text-zinc-900 normal-case tracking-normal u-focus-ring",
        props.className,
      )}
    />
  );
}

function SelectInput(props) {
  return (
    <select
      {...props}
      className={cn(
        "h-9 rounded-xs border-hairline border-zinc-300 bg-white px-2 text-13 text-zinc-900 normal-case tracking-normal u-focus-ring",
        props.className,
      )}
    />
  );
}

function TextArea(props) {
  return (
    <textarea
      {...props}
      className={cn(
        "min-h-28 rounded-xs border-hairline border-zinc-300 bg-white px-2 py-2 text-13 text-zinc-900 normal-case tracking-normal leading-5 u-focus-ring",
        props.className,
      )}
    />
  );
}

export default function DocumentTemplatesPage() {
  const [category, setCategory] = useState("all");
  const [templates, setTemplates] = useState([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [detail, setDetail] = useState(null);
  const [templateDraft, setTemplateDraft] = useState(EMPTY_TEMPLATE);
  const [versionDraft, setVersionDraft] = useState(EMPTY_VERSION);
  const [newMode, setNewMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [previewContext, setPreviewContext] = useState(JSON.stringify(DEFAULT_PREVIEW_CONTEXT, null, 2));
  const [preview, setPreview] = useState(null);
  const [sendCustomerId, setSendCustomerId] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState([]);
  const [customerLoading, setCustomerLoading] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [sendValues, setSendValues] = useState(JSON.stringify(DEFAULT_SEND_VALUES, null, 2));
  const [sendAllowUnresolved, setSendAllowUnresolved] = useState(false);
  const [signingUrl, setSigningUrl] = useState("");
  const [bulkAudience, setBulkAudience] = useState("active_pest");
  const [bulkGuideType, setBulkGuideType] = useState("pest");
  const [bulkChannel, setBulkChannel] = useState("sms");
  const [bulkSearch, setBulkSearch] = useState("");
  const [bulkCity, setBulkCity] = useState("");
  const [bulkDays, setBulkDays] = useState(30);
  const [bulkLimit, setBulkLimit] = useState(100);
  const [bulkSkipRecentDays, setBulkSkipRecentDays] = useState(14);
  const [bulkPreview, setBulkPreview] = useState(null);
  const [bulkResult, setBulkResult] = useState(null);
  const [bulkLoading, setBulkLoading] = useState(false);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (category !== "all") params.set("category", category);
      const data = await api(`/admin/document-templates?${params.toString()}`);
      setTemplates(data.templates || []);
      setSelectedKey((current) => {
        if (current && (data.templates || []).some((template) => template.templateKey === current)) return current;
        return data.templates?.[0]?.templateKey || "";
      });
    } catch (err) {
      setError(err.message || "Could not load document templates");
    } finally {
      setLoading(false);
    }
  }, [category]);

  const loadDetail = useCallback(async (key) => {
    if (!key || newMode) return;
    setError("");
    try {
      const data = await api(`/admin/document-templates/${encodeURIComponent(key)}`);
      setDetail(data);
      const nextTemplate = templateFromApi(data.template);
      const nextVersion = versionFromApi(data.template?.activeVersion || data.versions?.[0], data.template);
      setTemplateDraft(nextTemplate);
      setVersionDraft(nextVersion);
      setPreview(null);
      setSigningUrl("");
      setBulkPreview(null);
      setBulkResult(null);
      if (nextTemplate.templateKey?.includes("lawn")) {
        setBulkGuideType("lawn");
        setBulkAudience("active_lawn");
      } else if (nextTemplate.templateKey?.includes("pest")) {
        setBulkGuideType("pest");
        setBulkAudience("active_pest");
      }
    } catch (err) {
      setError(err.message || "Could not load document template");
    }
  }, [newMode]);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  useEffect(() => {
    if (selectedKey) loadDetail(selectedKey);
  }, [selectedKey, loadDetail]);

  useEffect(() => {
    const term = customerQuery.trim();
    if (selectedCustomer && term === customerSearchLabel(selectedCustomer)) {
      setCustomerResults([]);
      setCustomerLoading(false);
      return undefined;
    }
    if (term.length < 2) {
      setCustomerResults([]);
      setCustomerLoading(false);
      return undefined;
    }

    let cancelled = false;
    setCustomerLoading(true);
    const timeout = setTimeout(async () => {
      try {
        const data = await api(`/admin/customers?search=${encodeURIComponent(term)}&limit=8&sort=name`);
        if (!cancelled) setCustomerResults(data.customers || []);
      } catch {
        if (!cancelled) setCustomerResults([]);
      } finally {
        if (!cancelled) setCustomerLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [customerQuery, selectedCustomer]);

  const activeVersion = detail?.template?.activeVersion;
  const selectedCustomerId = selectedCustomer?.id || sendCustomerId.trim();
  const variableList = useMemo(() => {
    return [...new Set([
      ...(templateDraft.variables || []),
      ...extractVariables(versionDraft.title),
      ...extractVariables(versionDraft.body),
    ])].sort();
  }, [templateDraft.variables, versionDraft.title, versionDraft.body]);
  const bulkEnabled = Boolean(!newMode
    && templateDraft.templateKey
    && templateDraft.category === "marketing"
    && templateDraft.documentType === "customer_guide"
    && templateDraft.requiresSignature === false);
  const bulkSendableCount = bulkPreview?.counts?.sendable || 0;

  const updateTemplate = (key, value) => {
    setTemplateDraft((prev) => ({ ...prev, [key]: value }));
  };

  const updateVersion = (key, value) => {
    setVersionDraft((prev) => ({ ...prev, [key]: value }));
  };

  const startNew = () => {
    setNewMode(true);
    setSelectedKey("");
    setDetail(null);
    setTemplateDraft(EMPTY_TEMPLATE);
    setVersionDraft(EMPTY_VERSION);
    setPreview(null);
    setSigningUrl("");
    setSendCustomerId("");
    setCustomerQuery("");
    setCustomerResults([]);
    setSelectedCustomer(null);
    setBulkPreview(null);
    setBulkResult(null);
    setToast("");
    setError("");
  };

  const saveTemplate = async () => {
    setSaving(true);
    setError("");
    setToast("");
    try {
      const templatePayload = {
        ...templateDraft,
        variables: variableList,
        tags: templateDraft.tags,
      };
      if (newMode) {
        const data = await api("/admin/document-templates", {
          method: "POST",
          body: {
            ...templatePayload,
            title: versionDraft.title,
            body: versionDraft.body,
            signerDisclosure: versionDraft.signerDisclosure,
            requiredFields: versionDraft.requiredFields,
          },
        });
        setNewMode(false);
        setSelectedKey(data.template.templateKey);
        setToast("Template created");
        await loadTemplates();
      } else {
        await api(`/admin/document-templates/${encodeURIComponent(templateDraft.templateKey)}`, {
          method: "PUT",
          body: templatePayload,
        });
        setToast("Template saved");
        await loadTemplates();
        await loadDetail(templateDraft.templateKey);
      }
    } catch (err) {
      setError(err.message || "Could not save template");
    } finally {
      setSaving(false);
    }
  };

  const saveVersion = async () => {
    if (newMode || !templateDraft.templateKey) return saveTemplate();
    setSaving(true);
    setError("");
    setToast("");
    try {
      await api(`/admin/document-templates/${encodeURIComponent(templateDraft.templateKey)}/versions`, {
        method: "POST",
        body: {
          ...versionDraft,
          variables: variableList,
          publish: true,
        },
      });
      setToast("Version published");
      await loadTemplates();
      await loadDetail(templateDraft.templateKey);
    } catch (err) {
      setError(err.message || "Could not publish version");
    } finally {
      setSaving(false);
    }
  };

  const runPreview = async () => {
    if (!templateDraft.templateKey || newMode) {
      setPreview({
        title: versionDraft.title,
        body: versionDraft.body,
        unresolvedVariables: extractVariables(`${versionDraft.title}\n${versionDraft.body}`),
      });
      return;
    }
    setSaving(true);
    setError("");
    try {
      const data = await api(`/admin/document-templates/${encodeURIComponent(templateDraft.templateKey)}/preview`, {
        method: "POST",
        body: { context: safeJsonParse(previewContext, DEFAULT_PREVIEW_CONTEXT) },
      });
      setPreview(data.rendered);
    } catch (err) {
      setError(err.message || "Could not preview template");
    } finally {
      setSaving(false);
    }
  };

  const createSigningLink = async () => {
    if (!templateDraft.templateKey || !selectedCustomerId) return;
    setSaving(true);
    setError("");
    setToast("");
    setSigningUrl("");
    try {
      const data = await api(`/admin/document-templates/${encodeURIComponent(templateDraft.templateKey)}/contracts`, {
        method: "POST",
        body: {
          customerId: selectedCustomerId,
          values: parseJsonOrThrow(sendValues, "Send values"),
          allowUnresolved: sendAllowUnresolved,
        },
      });
      setSigningUrl(data.signingUrl || data.contract?.signingUrl || "");
      setPreview(data.rendered || null);
      setToast("Document link created");
    } catch (err) {
      setError(err.message || "Could not create document link");
    } finally {
      setSaving(false);
    }
  };

  const copySigningUrl = async () => {
    if (!signingUrl) return;
    await navigator.clipboard?.writeText(signingUrl).catch(() => {});
    setToast("Document link copied");
  };

  const bulkPayload = () => ({
    audience: bulkAudience,
    guideType: bulkGuideType,
    channel: bulkChannel,
    search: bulkSearch,
    city: bulkCity,
    days: Number(bulkDays) || 30,
    limit: Number(bulkLimit) || 100,
    skipRecentDays: Number(bulkSkipRecentDays) || 0,
    values: safeJsonParse(sendValues, DEFAULT_SEND_VALUES),
    allowUnresolved: sendAllowUnresolved,
  });

  const runBulkPreview = async ({ silent = false } = {}) => {
    if (!bulkEnabled) return;
    setBulkLoading(true);
    setError("");
    if (!silent) {
      setToast("");
      setBulkResult(null);
    }
    try {
      const data = await api(`/admin/document-templates/${encodeURIComponent(templateDraft.templateKey)}/bulk-preview`, {
        method: "POST",
        body: bulkPayload(),
      });
      setBulkPreview(data);
      if (!silent) setToast("Bulk audience preview ready");
    } catch (err) {
      setError(err.message || "Could not preview bulk send");
    } finally {
      setBulkLoading(false);
    }
  };

  const sendBulkGuide = async () => {
    if (!bulkEnabled || !bulkPreview || bulkSendableCount <= 0) return;
    const confirmed = window.confirm(`Send ${templateDraft.name} to ${numberLabel(bulkSendableCount)} customer${bulkSendableCount === 1 ? "" : "s"}?`);
    if (!confirmed) return;
    setBulkLoading(true);
    setError("");
    setToast("");
    try {
      const data = await api(`/admin/document-templates/${encodeURIComponent(templateDraft.templateKey)}/bulk-send`, {
        method: "POST",
        body: bulkPayload(),
      });
      setBulkResult(data);
      setToast(`Bulk send complete: ${numberLabel(data.summary?.sentEmail || 0)} email, ${numberLabel(data.summary?.sentSms || 0)} SMS`);
      await runBulkPreview({ silent: true });
    } catch (err) {
      setError(err.message || "Could not send bulk guide");
    } finally {
      setBulkLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1500px]">
      <AdminCommandHeader
        title="Contract Templates"
        icon={FileText}
        sections={CATEGORY_TABS}
        activeKey={category}
        onSectionChange={setCategory}
        navGridClassName="grid-cols-2 md:grid-cols-6"
        actions={[
          { label: "Refresh", icon: RefreshCw, variant: "secondary", onClick: loadTemplates, disabled: loading },
          { label: "New Template", icon: Plus, onClick: startNew },
        ]}
      />

      {error && (
        <div className="mb-3 rounded-sm border-hairline border-red-200 bg-red-50 px-3 py-2 text-12 text-red-900">
          {error}
        </div>
      )}
      {toast && (
        <div className="mb-3 rounded-sm border-hairline border-emerald-200 bg-emerald-50 px-3 py-2 text-12 text-emerald-950">
          {toast}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="rounded-sm border-hairline border-zinc-200 bg-white overflow-hidden">
          <div className="border-b-hairline border-zinc-200 px-3 py-2">
            <div className="u-label text-ink-secondary">Template library</div>
            <div className="mt-1 text-12 text-zinc-900">{loading ? "Loading" : `${templates.length} template${templates.length === 1 ? "" : "s"}`}</div>
          </div>
          <div className="divide-y divide-zinc-100">
            {templates.map((template) => (
              <button
                key={template.templateKey}
                type="button"
                onClick={() => {
                  setNewMode(false);
                  setSelectedKey(template.templateKey);
                }}
                className={cn(
                  "w-full px-3 py-3 text-left hover:bg-zinc-50 u-focus-ring",
                  selectedKey === template.templateKey && !newMode ? "bg-zinc-50" : "bg-white",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-13 font-medium text-zinc-900">{template.name}</div>
                    <div className="mt-1 truncate text-11 text-ink-secondary">{template.templateKey}</div>
                  </div>
                  <Badge tone={statusTone(template.status)}>{template.status}</Badge>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <span className="h-5 px-1.5 inline-flex items-center rounded-xs border-hairline border-zinc-200 bg-zinc-50 text-10 uppercase tracking-label text-ink-secondary">
                    {template.category}
                  </span>
                  {template.requiresSignature && (
                    <span className="h-5 px-1.5 inline-flex items-center rounded-xs border-hairline border-zinc-200 bg-white text-10 uppercase tracking-label text-zinc-700">
                      E-sign
                    </span>
                  )}
                </div>
              </button>
            ))}
            {!templates.length && (
              <div className="px-3 py-8 text-center text-12 text-ink-secondary">
                No templates for this filter.
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <Card>
            <CardBody className="p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="u-label text-ink-secondary">Template details</div>
                  <div className="mt-1 text-16 font-medium text-zinc-900">
                    {newMode ? "New document template" : templateDraft.name || "Select a template"}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={saveTemplate} disabled={saving}>
                    <Save size={14} className="mr-1.5" />
                    Save metadata
                  </Button>
                  <Button size="sm" onClick={saveVersion} disabled={saving}>
                    <CheckCircle2 size={14} className="mr-1.5" />
                    {newMode ? "Create" : "Publish version"}
                  </Button>
                </div>
              </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <Field label="Template key">
                  <TextInput
                    value={templateDraft.templateKey || ""}
                    disabled={!newMode}
                    onChange={(event) => updateTemplate("templateKey", event.target.value)}
                    placeholder="service_agreement.residential"
                  />
                </Field>
                <Field label="Name">
                  <TextInput value={templateDraft.name || ""} onChange={(event) => updateTemplate("name", event.target.value)} />
                </Field>
                <Field label="Category">
                  <SelectInput value={templateDraft.category || "general"} onChange={(event) => updateTemplate("category", event.target.value)}>
                    <option value="service_agreement">Service agreement</option>
                    <option value="wdo">WDO</option>
                    <option value="prep_form">Prep form</option>
                    <option value="notice">Notice</option>
                    <option value="marketing">Marketing</option>
                    <option value="general">General</option>
                  </SelectInput>
                </Field>
                <Field label="Status">
                  <SelectInput value={templateDraft.status || "active"} onChange={(event) => updateTemplate("status", event.target.value)}>
                    <option value="active">Active</option>
                    <option value="draft">Draft</option>
                    <option value="paused">Paused</option>
                    <option value="archived">Archived</option>
                  </SelectInput>
                </Field>
              </div>

              <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1fr_180px]">
                <Field label="Description">
                  <TextInput value={templateDraft.description || ""} onChange={(event) => updateTemplate("description", event.target.value)} />
                </Field>
                <Field label="Tags">
                  <TextInput value={csvFromArray(templateDraft.tags)} onChange={(event) => updateTemplate("tags", arrayFromCsv(event.target.value))} />
                </Field>
                <label className="mt-5 inline-flex h-9 items-center gap-2 text-12 font-medium text-zinc-900">
                  <input
                    type="checkbox"
                    checked={templateDraft.requiresSignature !== false}
                    onChange={(event) => updateTemplate("requiresSignature", event.target.checked)}
                    className="h-4 w-4 rounded-xs border-zinc-300 text-zinc-900 u-focus-ring"
                  />
                  Requires e-sign
                </label>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <Field label="Default delivery">
                  <SelectInput
                    value={templateDraft.defaultDeliveryChannel || "email"}
                    onChange={(event) => updateTemplate("defaultDeliveryChannel", event.target.value)}
                  >
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                    <option value="both">Email + SMS</option>
                  </SelectInput>
                </Field>
                <Field label="Expires after days">
                  <TextInput
                    type="number"
                    min="1"
                    max="14"
                    value={templateDraft.expireAfterDays || 14}
                    onChange={(event) => updateTemplate("expireAfterDays", event.target.value)}
                  />
                </Field>
                <Field label="Reminder days">
                  <TextInput
                    value={csvFromArray(templateDraft.reminderScheduleDays || [])}
                    onChange={(event) => updateTemplate("reminderScheduleDays", arrayFromCsv(event.target.value))}
                    placeholder="1, 3, -1"
                  />
                </Field>
              </div>
            </CardBody>
          </Card>

          <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
            <Card>
              <CardBody className="p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="u-label text-ink-secondary">Active version</div>
                    <div className="mt-1 text-13 text-zinc-900">
                      {activeVersion ? `Version ${activeVersion.versionNumber}` : newMode ? "Draft version" : "No active version"}
                    </div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={runPreview} disabled={saving}>
                    <Eye size={14} className="mr-1.5" />
                    Preview
                  </Button>
                </div>

                <div className="grid gap-3">
                  <Field label="Document title">
                    <TextInput value={versionDraft.title || ""} onChange={(event) => updateVersion("title", event.target.value)} />
                  </Field>
                  <Field label="Body">
                    <TextArea
                      value={versionDraft.body || ""}
                      onChange={(event) => updateVersion("body", event.target.value)}
                      className="min-h-[340px] font-mono text-12"
                    />
                  </Field>
                  <Field label="Signer disclosure">
                    <TextArea
                      value={versionDraft.signerDisclosure || ""}
                      onChange={(event) => updateVersion("signerDisclosure", event.target.value)}
                      className="min-h-20"
                    />
                  </Field>
                </div>

                <div className="mt-3 rounded-xs border-hairline border-zinc-200 bg-zinc-50 p-2">
                  <div className="u-label text-ink-secondary">Merge fields</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {variableList.map((variable) => (
                      <span key={variable} className="h-6 px-2 inline-flex items-center rounded-xs border-hairline border-zinc-200 bg-white text-11 text-zinc-800">
                        {variable}
                      </span>
                    ))}
                    {!variableList.length && <span className="text-12 text-ink-secondary">No merge fields.</span>}
                  </div>
                </div>
              </CardBody>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardBody className="p-4">
                  <div className="mb-3">
                    <div className="u-label text-ink-secondary">Preview context</div>
                    <div className="mt-1 text-13 text-zinc-900">Rendered output</div>
                  </div>
                  <TextArea
                    value={previewContext}
                    onChange={(event) => setPreviewContext(event.target.value)}
                    className="min-h-40 font-mono text-12"
                  />
                  <div className="mt-3 rounded-xs border-hairline border-zinc-200 bg-zinc-50 p-3">
                    <div className="text-14 font-medium text-zinc-900">{preview?.title || versionDraft.title || "Preview"}</div>
                    <div className="mt-2 max-h-80 overflow-auto whitespace-pre-line text-12 leading-5 text-zinc-800">
                      {preview?.body || "Run preview to render this template."}
                    </div>
                    {(preview?.unresolvedVariables || []).length > 0 && (
                      <div className="mt-3 rounded-xs border-hairline border-amber-300 bg-amber-50 px-2 py-1.5 text-11 text-amber-950">
                        Unresolved: {preview.unresolvedVariables.join(", ")}
                      </div>
                    )}
                  </div>
                </CardBody>
              </Card>

              <Card>
                <CardBody className="p-4">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div>
                      <div className="u-label text-ink-secondary">Customer link</div>
                      <div className="mt-1 text-13 text-zinc-900">Create customer document</div>
                    </div>
                    <Button size="sm" onClick={createSigningLink} disabled={saving || newMode || !selectedCustomerId}>
                      <Send size={14} className="mr-1.5" />
                      Create link
                    </Button>
                  </div>
                  <div className="grid gap-3">
                    <div className="grid gap-2">
                      <Field label="Customer">
                        <TextInput
                          value={customerQuery}
                          onChange={(event) => {
                            setCustomerQuery(event.target.value);
                            setSelectedCustomer(null);
                            setSendCustomerId("");
                          }}
                          placeholder="Search name, phone, email, or address"
                        />
                      </Field>
                      {selectedCustomer && (
                        <div className="flex items-start justify-between gap-2 rounded-xs border-hairline border-zinc-200 bg-zinc-50 px-2 py-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 text-12 font-medium text-zinc-900">
                              <UserRound size={14} />
                              <span className="truncate">{customerName(selectedCustomer)}</span>
                            </div>
                            <div className="mt-0.5 truncate text-11 text-ink-secondary">
                              {[selectedCustomer.address, selectedCustomer.phone, selectedCustomer.email].filter(Boolean).join(" · ")}
                            </div>
                          </div>
                          <button
                            type="button"
                            title="Clear selected customer"
                            aria-label="Clear selected customer"
                            onClick={() => {
                              setSelectedCustomer(null);
                              setSendCustomerId("");
                              setCustomerQuery("");
                            }}
                            className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-xs border-hairline border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 u-focus-ring"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      )}
                      {!selectedCustomer && (customerResults.length > 0 || customerLoading) && (
                        <div className="rounded-xs border-hairline border-zinc-200 bg-white">
                          {customerResults.map((customer) => (
                            <button
                              key={customer.id}
                              type="button"
                              onClick={() => {
                                setSelectedCustomer(customer);
                                setSendCustomerId(customer.id);
                                setCustomerQuery(customerSearchLabel(customer));
                                setCustomerResults([]);
                              }}
                              className="flex w-full items-start gap-2 border-b-hairline border-zinc-100 px-2 py-2 text-left last:border-b-0 hover:bg-zinc-50 u-focus-ring"
                            >
                              <UserRound size={14} className="mt-0.5 flex-shrink-0 text-zinc-600" />
                              <span className="min-w-0">
                                <span className="block truncate text-12 font-medium text-zinc-900">{customerName(customer)}</span>
                                <span className="block truncate text-11 text-ink-secondary">
                                  {[customer.address, customer.phone, customer.email].filter(Boolean).join(" · ")}
                                </span>
                              </span>
                            </button>
                          ))}
                          {customerLoading && (
                            <div className="px-2 py-2 text-12 text-ink-secondary">Searching customers...</div>
                          )}
                        </div>
                      )}
                      {!selectedCustomer && customerQuery.trim().length >= 2 && !customerLoading && customerResults.length === 0 && (
                        <div className="text-12 text-ink-secondary">No matching customers found.</div>
                      )}
                    </div>
                    <Field label="Values">
                      <TextArea value={sendValues} onChange={(event) => setSendValues(event.target.value)} className="min-h-32 font-mono text-12" />
                    </Field>
                    <label className="inline-flex items-center gap-2 text-12 font-medium text-zinc-900">
                      <input
                        type="checkbox"
                        checked={sendAllowUnresolved}
                        onChange={(event) => setSendAllowUnresolved(event.target.checked)}
                        className="h-4 w-4 rounded-xs border-zinc-300 text-zinc-900 u-focus-ring"
                      />
                      Allow unresolved fields
                    </label>
                  </div>
                  {signingUrl && (
                    <div className="mt-3 rounded-xs border-hairline border-zinc-200 bg-zinc-50 p-2">
                      <div className="mb-2 flex items-center gap-2 text-12 font-medium text-zinc-900">
                        <Link2 size={14} />
                        Document link ready
                      </div>
                      <div className="break-all text-11 leading-5 text-zinc-800">{signingUrl}</div>
                      <Button size="sm" variant="secondary" className="mt-2" onClick={copySigningUrl}>
                        <Copy size={14} className="mr-1.5" />
                        Copy
                      </Button>
                    </div>
                  )}
                </CardBody>
              </Card>

              <Card>
                <CardBody className="p-4">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div>
                      <div className="u-label text-ink-secondary">Bulk send guide</div>
                      <div className="mt-1 text-13 text-zinc-900">Preview audience and send</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" onClick={runBulkPreview} disabled={!bulkEnabled || bulkLoading}>
                        <Eye size={14} className="mr-1.5" />
                        Preview
                      </Button>
                      <Button size="sm" onClick={sendBulkGuide} disabled={!bulkEnabled || bulkLoading || !bulkPreview || bulkSendableCount <= 0}>
                        <Send size={14} className="mr-1.5" />
                        Send batch
                      </Button>
                    </div>
                  </div>

                  {!bulkEnabled ? (
                    <div className="rounded-xs border-hairline border-zinc-200 bg-zinc-50 px-3 py-2 text-12 text-ink-secondary">
                      Select an active marketing or customer-guide template.
                    </div>
                  ) : (
                    <div className="grid gap-3">
                      <div className="grid gap-3 md:grid-cols-2">
                        <Field label="Audience">
                          <SelectInput
                            value={bulkAudience}
                            onChange={(event) => {
                              const next = event.target.value;
                              setBulkAudience(next);
                              if (next === "active_lawn") setBulkGuideType("lawn");
                              if (next === "active_pest") setBulkGuideType("pest");
                              setBulkPreview(null);
                            }}
                          >
                            {BULK_AUDIENCES.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </SelectInput>
                        </Field>
                        <Field label="Guide type">
                          <SelectInput
                            value={bulkGuideType}
                            onChange={(event) => {
                              setBulkGuideType(event.target.value);
                              setBulkPreview(null);
                            }}
                          >
                            {BULK_GUIDE_TYPES.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </SelectInput>
                        </Field>
                        <Field label="Delivery">
                          <SelectInput
                            value={bulkChannel}
                            onChange={(event) => {
                              setBulkChannel(event.target.value);
                              setBulkPreview(null);
                            }}
                          >
                            {BULK_CHANNELS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </SelectInput>
                        </Field>
                        <Field label="Batch limit">
                          <TextInput
                            type="number"
                            min="1"
                            max="250"
                            value={bulkLimit}
                            onChange={(event) => {
                              setBulkLimit(event.target.value);
                              setBulkPreview(null);
                            }}
                          />
                        </Field>
                        <Field label="Search">
                          <TextInput
                            value={bulkSearch}
                            onChange={(event) => {
                              setBulkSearch(event.target.value);
                              setBulkPreview(null);
                            }}
                            placeholder="Optional name, phone, email, address"
                          />
                        </Field>
                        <Field label="City">
                          <TextInput
                            value={bulkCity}
                            onChange={(event) => {
                              setBulkCity(event.target.value);
                              setBulkPreview(null);
                            }}
                            placeholder="Optional city"
                          />
                        </Field>
                        <Field label="Days">
                          <TextInput
                            type="number"
                            min="1"
                            max="365"
                            value={bulkDays}
                            onChange={(event) => {
                              setBulkDays(event.target.value);
                              setBulkPreview(null);
                            }}
                          />
                        </Field>
                        <Field label="Skip duplicate days">
                          <TextInput
                            type="number"
                            min="0"
                            max="365"
                            value={bulkSkipRecentDays}
                            onChange={(event) => {
                              setBulkSkipRecentDays(event.target.value);
                              setBulkPreview(null);
                            }}
                          />
                        </Field>
                      </div>

                      {bulkPreview && (
                        <div className="rounded-xs border-hairline border-zinc-200 bg-zinc-50 p-3">
                          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                            <div className="rounded-xs border-hairline border-zinc-200 bg-white px-2 py-2">
                              <div className="u-label text-ink-secondary">Matched</div>
                              <div className="u-nums mt-1 text-18 font-medium text-zinc-900">{numberLabel(bulkPreview.counts?.matched)}</div>
                            </div>
                            <div className="rounded-xs border-hairline border-zinc-200 bg-white px-2 py-2">
                              <div className="u-label text-ink-secondary">Sendable</div>
                              <div className="u-nums mt-1 text-18 font-medium text-emerald-950">{numberLabel(bulkPreview.counts?.sendable)}</div>
                            </div>
                            <div className="rounded-xs border-hairline border-zinc-200 bg-white px-2 py-2">
                              <div className="u-label text-ink-secondary">Duplicates</div>
                              <div className="u-nums mt-1 text-18 font-medium text-amber-950">{numberLabel(bulkPreview.counts?.duplicateSkipped)}</div>
                            </div>
                            <div className="rounded-xs border-hairline border-zinc-200 bg-white px-2 py-2">
                              <div className="u-label text-ink-secondary">Products</div>
                              <div className="u-nums mt-1 text-18 font-medium text-zinc-900">{numberLabel(bulkPreview.productGuide?.productCount)}</div>
                            </div>
                          </div>
                          {bulkPreview.counts?.capped && (
                            <div className="mt-2 rounded-xs border-hairline border-amber-300 bg-amber-50 px-2 py-1.5 text-11 text-amber-950">
                              Preview is capped by the batch limit.
                            </div>
                          )}
                          <div className="mt-3 grid gap-2">
                            {(bulkPreview.sampleCustomers || []).slice(0, 6).map((customer) => (
                              <div key={customer.id} className="flex items-start justify-between gap-2 border-b-hairline border-zinc-200 pb-2 text-12 last:border-b-0 last:pb-0">
                                <div className="min-w-0">
                                  <div className="truncate font-medium text-zinc-900">{customer.name}</div>
                                  <div className="truncate text-11 text-ink-secondary">
                                    {[customer.address, customer.phone, customer.email].filter(Boolean).join(" · ")}
                                  </div>
                                </div>
                                {customer.duplicateContractId && (
                                  <span className="flex-shrink-0 rounded-xs border-hairline border-amber-300 bg-amber-50 px-1.5 py-0.5 text-10 uppercase tracking-label text-amber-950">
                                    duplicate
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {bulkResult && (
                        <div className="rounded-xs border-hairline border-emerald-200 bg-emerald-50 p-3 text-12 text-emerald-950">
                          <div className="font-medium">Batch result</div>
                          <div className="mt-1">
                            Created {numberLabel(bulkResult.summary?.created)} documents, sent {numberLabel(bulkResult.summary?.sentSms)} SMS.
                          </div>
                          {(bulkResult.summary?.failed || bulkResult.summary?.skippedMissingContact || bulkResult.summary?.skippedDuplicate) ? (
                            <div className="mt-1">
                              Failed {numberLabel(bulkResult.summary?.failed)}, missing contact {numberLabel(bulkResult.summary?.skippedMissingContact)}, duplicate skipped {numberLabel(bulkResult.summary?.skippedDuplicate)}.
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  )}
                </CardBody>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
