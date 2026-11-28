import useVisiblePageRefresh from "../../hooks/useVisiblePageRefresh";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  Eye,
  History,
  Mail,
  Plus,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Star,
  Trash2,
  Unlock,
} from "lucide-react";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Input,
  Select,
  Switch,
  Textarea,
  Table,
  cn,
} from "../../components/ui";

// Templates whose preview reports first-visit audience eligibility for an appointment.
const AUDIENCE_PREVIEW_TEMPLATE_KEYS = ["app_intro"];

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
      const err = new Error(data?.error || `HTTP ${r.status}`);
      err.status = r.status;
      err.body = data;
      throw err;
    }
    return data;
  });
}

function hashParams() {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.hash.replace(/^#/, ""));
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function latestDraft(versions) {
  return [...(versions || [])]
    .filter((v) => v.status === "draft")
    .sort((a, b) => Number(b.version_number || 0) - Number(a.version_number || 0))[0];
}

function activeVersion(versions, template) {
  return (
    versions?.find((v) => v.id === template?.active_version_id) ||
    versions?.find((v) => v.status === "active") ||
    versions?.[0] ||
    null
  );
}

function defaultBlock(type = "paragraph") {
  if (type === "heading") return { type, content: "Section heading" };
  if (type === "callout") return { type, content: "Important note for the customer." };
  if (type === "small_note") return { type, content: "Small supporting note." };
  if (type === "details") return { type, rows: [{ label: "Label", value: "{{variable}}" }] };
  if (type === "list") return { type, items: ["First point."] };
  if (type === "cta") return { type, label: "Open", url_variable: "" };
  return { type: "paragraph", content: "New paragraph." };
}

function ModeBadge({ mode }) {
  return (
    <Badge tone={mode === "marketing" ? "strong" : "neutral"}>
      {mode || "service"}
    </Badge>
  );
}

function templateIsActive(template) {
  return String(template?.status || "draft").toLowerCase() === "active";
}

function canDeleteEmailTemplate(template) {
  if (template?.can_delete !== undefined) return template.can_delete === true;
  const status = String(template?.status || "draft").toLowerCase();
  return status === "draft" || status === "archived";
}

function TemplateStatusBadge({ status }) {
  const normalized = String(status || "draft").toLowerCase();
  return (
    <Badge tone={normalized === "active" ? "strong" : "neutral"}>
      {normalized === "active" ? "on" : normalized}
    </Badge>
  );
}

function VersionBadge({ version }) {
  if (!version) return null;
  const active = version.status === "active";
  return (
    <Badge tone={active ? "strong" : "neutral"}>
      v{version.version_number} {version.status}
    </Badge>
  );
}

function formatDateTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusTone(status) {
  if (["sent", "delivered"].includes(status)) return "strong";
  if (["failed", "bounced", "spam_report", "blocked"].includes(status)) return "alert";
  return "neutral";
}

function rateText(value) {
  const n = Number(value || 0);
  return `${Number.isFinite(n) ? n.toFixed(1).replace(".0", "") : "0"}%`;
}

function listText(value) {
  return asArray(value).join("\n");
}

function parseListText(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function settingsFromTemplate(template = {}) {
  return {
    name: template.name || "",
    description: template.description || "",
    mode: template.mode || "service",
    purpose: template.purpose || "general",
    legalClassification: template.legal_classification || "transactional_relationship",
    audience: template.audience || "customer",
    messagePriority: template.message_priority || "normal",
    contentSensitivity: template.content_sensitivity || "normal",
    sendStream: template.send_stream || "service_operational",
    suppressionGroupKey: template.suppression_group_key || "",
    layoutWrapperId: template.layout_wrapper_id || "service_default_v1",
    fromName: template.from_name || "Waves Pest Control",
    fromEmail: template.from_email || "contact@wavespestcontrol.com",
    replyTo: template.reply_to || "contact@wavespestcontrol.com",
    defaultCtaLabel: template.default_cta_label || "",
    defaultCtaUrlVariable: template.default_cta_url_variable || "",
    allowedVariablesText: listText(template.allowed_variables),
    requiredVariablesText: listText(template.required_variables),
    optionalVariablesText: listText(template.optional_variables),
  };
}

function defaultNewTemplate() {
  return {
    templateKey: "",
    name: "",
    mode: "service",
    purpose: "general",
    legalClassification: "transactional_relationship",
    audience: "customer",
    sendStream: "service_operational",
    subject: "",
  };
}

function SendHistoryPanel({ messages, loading }) {
  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <History size={15} />
          <CardTitle>Send history</CardTitle>
        </div>
      </CardHeader>
      <CardBody>
        {loading ? (
          <div className="py-10 text-center text-13 text-ink-secondary">Loading send history...</div>
        ) : messages.length ? (
          <Table aria-label="Email send history" className="min-w-[900px] text-left">
              <thead>
                <tr className="border-b border-zinc-200 text-ui-label text-ink-tertiary">
                  <th className="py-2 pr-4 font-medium">Sent</th>
                  <th className="py-2 pr-4 font-medium">Recipient</th>
                  <th className="py-2 pr-4 font-medium">Template</th>
                  <th className="py-2 pr-4 font-medium">Subject</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 font-medium">Provider</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {messages.map((m) => (
                  <tr key={m.id}>
                    <td className="py-3 pr-4 whitespace-nowrap text-ink-secondary">
                      {formatDateTime(m.sent_at || m.queued_at || m.created_at)}
                    </td>
                    <td className="py-3 pr-4 whitespace-nowrap text-zinc-900">
                      {m.recipient_email_snapshot}
                    </td>
                    <td className="py-3 pr-4 whitespace-nowrap text-ink-secondary">
                      {m.template_key || "-"}
                    </td>
                    <td className="py-3 pr-4 min-w-[260px] text-zinc-900">
                      <div className="line-clamp-2">{m.subject_snapshot || "-"}</div>
                    </td>
                    <td className="py-3 pr-4 whitespace-nowrap">
                      <Badge tone={statusTone(m.status)}>{m.status || "queued"}</Badge>
                    </td>
                    <td className="py-3 whitespace-nowrap text-ink-tertiary">
                      {m.provider_message_id || m.provider || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
        ) : (
          <div className="py-10 text-center text-13 text-ink-secondary">No email sends yet.</div>
        )}
      </CardBody>
    </Card>
  );
}

function TemplateIssuesPanel({ issues, loading, onOpenTemplate }) {
  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <AlertTriangle size={15} />
          <CardTitle>Template issues</CardTitle>
        </div>
      </CardHeader>
      <CardBody>
        {loading ? (
          <div className="py-10 text-center text-13 text-ink-secondary">Loading template issues...</div>
        ) : issues.length ? (
          <Table aria-label="Email issues" className="min-w-[900px] text-left">
              <thead>
                <tr className="border-b border-zinc-200 text-ui-label text-ink-tertiary">
                  <th className="py-2 pr-4 font-medium">When</th>
                  <th className="py-2 pr-4 font-medium">Template</th>
                  <th className="py-2 pr-4 font-medium">Issue</th>
                  <th className="py-2 pr-4 font-medium">Context</th>
                  <th className="py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {issues.map((issue) => (
                  <tr key={issue.id}>
                    <td className="py-3 pr-4 whitespace-nowrap text-ink-secondary">
                      {formatDateTime(issue.created_at)}
                    </td>
                    <td className="py-3 pr-4 whitespace-nowrap">
                      <button
                        type="button"
                        className="text-left text-zinc-900 hover:text-sky-700"
                        onClick={() => onOpenTemplate(issue.template_key)}
                      >
                        {issue.template_key || "-"}
                      </button>
                    </td>
                    <td className="py-3 pr-4 whitespace-nowrap">
                      <Badge tone="alert">{issue.event_type || "issue"}</Badge>
                    </td>
                    <td className="py-3 pr-4 min-w-[220px] text-ink-secondary">
                      <div>{issue.workflow || "-"}</div>
                      {(issue.entity_type || issue.entity_id) && (
                        <div className="text-ui-caption text-ink-tertiary">
                          {[issue.entity_type, issue.entity_id].filter(Boolean).join(" ")}
                        </div>
                      )}
                    </td>
                    <td className="py-3 min-w-[260px] text-zinc-900">
                      <div className="line-clamp-2">{issue.reason || "-"}</div>
                      {Array.isArray(issue.unresolved_placeholders) && issue.unresolved_placeholders.length > 0 && (
                        <div className="mt-1 text-ui-caption text-ink-tertiary">
                          {issue.unresolved_placeholders.join(", ")}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
        ) : (
          <div className="py-10 text-center text-13 text-ink-secondary">No recent template issues.</div>
        )}
      </CardBody>
    </Card>
  );
}

function SuppressionsPanel({
  groups,
  suppressions,
  stats,
  loading,
  filter,
  form,
  busy,
  onFilter,
  onForm,
  onRefresh,
  onCreate,
  onRelease,
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <ShieldCheck size={15} />
            <CardTitle>Preferences & suppressions</CardTitle>
          </div>
          <Button variant="secondary" size="sm" className="gap-2" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={14} /> Refresh
          </Button>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_180px_180px_auto] gap-2">
            <Input
              value={form.email}
              onChange={(e) => onForm({ ...form, email: e.target.value })}
              placeholder="customer@example.com"
            />
            <Select
              value={form.groupKey}
              onChange={(e) => onForm({ ...form, groupKey: e.target.value })}
            >
              <option value="">Global suppression</option>
              {groups.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.name}
                </option>
              ))}
            </Select>
            <Select
              value={form.suppressionType}
              onChange={(e) => onForm({ ...form, suppressionType: e.target.value })}
            >
              <option value="manual">Manual</option>
              <option value="do_not_email">Do not email</option>
              <option value="unsubscribe">Unsubscribe</option>
              <option value="bounce">Bounce</option>
              <option value="spam_complaint">Spam complaint</option>
            </Select>
            <Button variant="primary" className="gap-2" onClick={onCreate} disabled={busy || !form.email}>
              <Plus size={14} /> Add
            </Button>
          </div>
          <Input
            value={form.reason}
            onChange={(e) => onForm({ ...form, reason: e.target.value })}
            placeholder="Reason"
          />
          <div className="grid grid-cols-1 md:grid-cols-[1fr_180px_180px] gap-2">
            <Input
              value={filter.email}
              onChange={(e) => onFilter({ ...filter, email: e.target.value })}
              placeholder="Filter by email"
            />
            <Select
              value={filter.groupKey}
              onChange={(e) => onFilter({ ...filter, groupKey: e.target.value })}
            >
              <option value="">All groups</option>
              <option value="__global">Global only</option>
              {groups.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.name}
                </option>
              ))}
            </Select>
            <Select
              value={filter.status}
              onChange={(e) => onFilter({ ...filter, status: e.target.value })}
            >
              <option value="active">Active</option>
              <option value="released">Released</option>
              <option value="all">All</option>
            </Select>
          </div>
          <div className="flex gap-2 flex-wrap">
            {stats.slice(0, 8).map((s) => (
              <Badge key={`${s.group_key || "global"}-${s.suppression_type}`} tone="neutral">
                {(s.group_key || "global").replace(/_/g, " ")}: {s.count}
              </Badge>
            ))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          {loading ? (
            <div className="py-10 text-center text-13 text-ink-secondary">Loading suppressions...</div>
          ) : suppressions.length ? (
            <Table aria-label="Email suppressions" className="min-w-[1100px] text-left">
                <thead>
                  <tr className="border-b border-zinc-200 text-ui-label text-ink-tertiary">
                    <th className="py-2 pr-4 font-medium">Email</th>
                    <th className="py-2 pr-4 font-medium">Customer</th>
                    <th className="py-2 pr-4 font-medium">Group</th>
                    <th className="py-2 pr-4 font-medium">Type</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Blocked</th>
                    <th className="py-2 pr-4 font-medium">Source</th>
                    <th className="py-2 pr-4 font-medium">Since</th>
                    <th className="py-2 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {suppressions.map((s) => (
                    <tr key={s.id}>
                      <td className="py-3 pr-4 whitespace-nowrap text-zinc-900">{s.email}</td>
                      <td className="py-3 pr-4 whitespace-nowrap">
                        {s.customer ? (
                          <div>
                            <a
                              href={`/admin/customers?customerId=${encodeURIComponent(s.customer.id)}`}
                              className="text-zinc-900 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-500"
                            >
                              {[s.customer.first_name, s.customer.last_name].filter(Boolean).join(" ") || "Unnamed customer"}
                            </a>
                            {s.customer.phone ? (
                              <div className="text-ui-caption text-ink-tertiary">
                                <a href={`tel:${s.customer.phone}`}>{s.customer.phone}</a>
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-ink-tertiary">No match</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 whitespace-nowrap text-ink-secondary">
                        {s.group_name || s.group_key || "Global"}
                      </td>
                      <td className="py-3 pr-4 whitespace-nowrap text-ink-secondary">
                        {String(s.suppression_type || "").replace(/_/g, " ")}
                      </td>
                      <td className="py-3 pr-4 whitespace-nowrap">
                        <Badge tone={s.status === "active" ? "alert" : "neutral"}>{s.status}</Badge>
                      </td>
                      <td
                        className="py-3 pr-4 whitespace-nowrap text-ink-secondary"
                        title={s.last_blocked_at ? `Last blocked ${formatDateTime(s.last_blocked_at)}` : undefined}
                      >
                        {s.blocked_count > 0 ? `${s.blocked_count} ${s.blocked_count === 1 ? "send" : "sends"}` : "—"}
                      </td>
                      <td className="py-3 pr-4 whitespace-nowrap text-ink-tertiary">{s.source || "-"}</td>
                      <td className="py-3 pr-4 whitespace-nowrap text-ink-tertiary">
                        {formatDateTime(s.suppressed_at || s.created_at)}
                      </td>
                      <td className="py-3 whitespace-nowrap">
                        {s.status === "active" ? (
                          <Button variant="ghost" size="sm" className="gap-1" onClick={() => onRelease(s.id)} disabled={busy}>
                            <Unlock size={13} /> Release
                          </Button>
                        ) : (
                          <span className="text-ink-tertiary">Released</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
          ) : (
            <div className="py-10 text-center text-13 text-ink-secondary">No suppressions match the current filters.</div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function DeliverabilityPanel({ data, loading }) {
  const provider = data?.provider || {};
  const rates = data?.rates || {};
  const health = data?.health || {};
  const counts = data?.status_counts || {};
  const configItems = [
    ["SendGrid API", provider.configured ? "Configured" : "Missing", provider.configured],
    ["Webhook signing", provider.webhook_public_key_configured ? "Configured" : "Missing", provider.webhook_public_key_configured],
    ["Service ASM", provider.service_asm_group_id || "Not set", !!provider.service_asm_group_id],
    ["Newsletter ASM", provider.newsletter_asm_group_id || "Not set", !!provider.newsletter_asm_group_id],
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Activity size={15} />
            <CardTitle>Deliverability</CardTitle>
          </div>
        </CardHeader>
        <CardBody>
          {loading ? (
            <div className="py-10 text-center text-13 text-ink-secondary">Loading deliverability...</div>
          ) : (
            <div className="space-y-5">
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <div className="rounded-sm border-hairline border-zinc-200 p-3">
                  <div className="text-11 uppercase tracking-label text-ink-tertiary">30d messages</div>
                  <div className="mt-1 text-22 font-medium text-zinc-900">{health.total_messages || 0}</div>
                </div>
                <div className="rounded-sm border-hairline border-zinc-200 p-3">
                  <div className="text-11 uppercase tracking-label text-ink-tertiary">Delivery</div>
                  <div className="mt-1 text-22 font-medium text-zinc-900">{rateText(rates.delivery_rate)}</div>
                </div>
                <div className="rounded-sm border-hairline border-zinc-200 p-3">
                  <div className="text-11 uppercase tracking-label text-ink-tertiary">Bounce</div>
                  <div className="mt-1 text-22 font-medium text-zinc-900">{rateText(rates.bounce_rate)}</div>
                </div>
                <div className="rounded-sm border-hairline border-zinc-200 p-3">
                  <div className="text-11 uppercase tracking-label text-ink-tertiary">Complaint</div>
                  <div className="mt-1 text-22 font-medium text-zinc-900">{rateText(rates.complaint_rate)}</div>
                </div>
                <div className="rounded-sm border-hairline border-zinc-200 p-3">
                  <div className="text-11 uppercase tracking-label text-ink-tertiary">Active suppressions</div>
                  <div className="mt-1 text-22 font-medium text-zinc-900">{health.active_suppressions || 0}</div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="space-y-3">
                  <div className="text-11 uppercase tracking-label text-ink-tertiary">Provider Configuration</div>
                  <div className="divide-y divide-zinc-100 rounded-sm border-hairline border-zinc-200">
                    {configItems.map(([label, value, ok]) => (
                      <div key={label} className="flex items-center justify-between gap-3 px-3 py-2">
                        <span className="text-13 text-ink-secondary">{label}</span>
                        <Badge tone={ok ? "strong" : "alert"}>{value}</Badge>
                      </div>
                    ))}
                    <div className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="text-13 text-ink-secondary">Marketing from</span>
                      <span className="text-13 text-zinc-900">{provider.from_email || "-"}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="text-13 text-ink-secondary">Service from</span>
                      <span className="text-13 text-zinc-900">{provider.service_from_email || "-"}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="text-13 text-ink-secondary">Portal URL</span>
                      <span className="text-13 text-zinc-900 truncate max-w-[320px]">{provider.public_portal_url || "-"}</span>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="text-11 uppercase tracking-label text-ink-tertiary">Recent Status Counts</div>
                  <div className="divide-y divide-zinc-100 rounded-sm border-hairline border-zinc-200">
                    {Object.keys(counts).length ? Object.entries(counts).map(([status, count]) => (
                      <div key={status} className="flex items-center justify-between gap-3 px-3 py-2">
                        <Badge tone={statusTone(status)}>{status}</Badge>
                        <span className="text-13 text-zinc-900">{count}</span>
                      </div>
                    )) : (
                      <div className="px-3 py-8 text-center text-13 text-ink-secondary">No sends in the last 30 days.</div>
                    )}
                    <div className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="text-13 text-ink-secondary">Last email event</span>
                      <span className="text-13 text-zinc-900">{formatDateTime(health.last_email_message_event)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="text-13 text-ink-secondary">Last provider webhook</span>
                      <span className="text-13 text-zinc-900">{formatDateTime(health.last_provider_event)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function CreateTemplateCard({ value, busy, onChange, onCreate, onCancel }) {
  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-3 flex-wrap">
        <CardTitle>New email template</CardTitle>
        <div className="flex gap-2 flex-wrap">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" className="gap-2" onClick={onCreate} disabled={busy || !value.templateKey || !value.name}>
            <Plus size={14} /> Create
          </Button>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <Input
            value={value.templateKey}
            onChange={(e) => onChange({ ...value, templateKey: e.target.value })}
            placeholder="template.key"
          />
          <Input
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            placeholder="Template name"
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <Select
            value={value.mode}
            onChange={(e) => {
              const mode = e.target.value;
              onChange({
                ...value,
                mode,
                legalClassification: mode === "marketing" ? "commercial_marketing" : "transactional_relationship",
                audience: mode === "marketing" ? "subscriber" : "customer",
                sendStream: mode === "marketing" ? "marketing_newsletter" : "service_operational",
              });
            }}
          >
            <option value="service">Service</option>
            <option value="marketing">Marketing</option>
          </Select>
          <Input
            value={value.purpose}
            onChange={(e) => onChange({ ...value, purpose: e.target.value })}
            placeholder="Purpose"
          />
          <Select
            value={value.legalClassification}
            onChange={(e) => onChange({ ...value, legalClassification: e.target.value })}
          >
            <option value="transactional_relationship">Transactional relationship</option>
            <option value="commercial_marketing">Commercial marketing</option>
            <option value="mixed">Mixed</option>
          </Select>
          <Select
            value={value.audience}
            onChange={(e) => onChange({ ...value, audience: e.target.value })}
          >
            <option value="customer">Customer</option>
            <option value="lead">Lead</option>
            <option value="subscriber">Subscriber</option>
            <option value="internal_user">Internal user</option>
          </Select>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <Select
            value={value.sendStream}
            onChange={(e) => onChange({ ...value, sendStream: e.target.value })}
          >
            <option value="transactional_required">Transactional required</option>
            <option value="service_operational">Service operational</option>
            <option value="marketing_newsletter">Marketing newsletter</option>
            <option value="marketing_referral">Marketing referral</option>
            <option value="marketing_nurture">Marketing nurture</option>
            <option value="internal">Internal</option>
          </Select>
          <Input
            value={value.subject}
            onChange={(e) => onChange({ ...value, subject: e.target.value })}
            placeholder="Initial subject"
          />
        </div>
      </CardBody>
    </Card>
  );
}

function TemplateSettingsPanel({ settings, groups, busy, onChange, onSave }) {
  if (!settings) return null;
  return (
    <div className="space-y-3 rounded-sm border-hairline border-zinc-200 p-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-11 uppercase tracking-label text-ink-tertiary">Template Settings</div>
          <div className="text-12 text-ink-secondary">Contract, sender, compliance, and routing rules.</div>
        </div>
        <Button variant="secondary" size="sm" className="gap-2" onClick={onSave} disabled={busy}>
          <Save size={14} /> Save settings
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <Input
          value={settings.name}
          onChange={(e) => onChange({ ...settings, name: e.target.value })}
          placeholder="Template name"
        />
        <Input
          value={settings.description}
          onChange={(e) => onChange({ ...settings, description: e.target.value })}
          placeholder="Description"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <div>
          <label className="text-11 uppercase tracking-label text-ink-tertiary">Mode</label>
          <Select
            className="mt-1"
            value={settings.mode}
            onChange={(e) => onChange({ ...settings, mode: e.target.value })}
          >
            <option value="service">Service</option>
            <option value="marketing">Marketing</option>
          </Select>
        </div>
        <div>
          <label className="text-11 uppercase tracking-label text-ink-tertiary">Purpose</label>
          <Input
            className="mt-1"
            value={settings.purpose}
            onChange={(e) => onChange({ ...settings, purpose: e.target.value })}
          />
        </div>
        <div>
          <label className="text-11 uppercase tracking-label text-ink-tertiary">Audience</label>
          <Select
            className="mt-1"
            value={settings.audience}
            onChange={(e) => onChange({ ...settings, audience: e.target.value })}
          >
            <option value="customer">Customer</option>
            <option value="lead">Lead</option>
            <option value="subscriber">Subscriber</option>
            <option value="internal_user">Internal user</option>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <div>
          <label className="text-11 uppercase tracking-label text-ink-tertiary">Legal</label>
          <Select
            className="mt-1"
            value={settings.legalClassification}
            onChange={(e) => onChange({ ...settings, legalClassification: e.target.value })}
          >
            <option value="transactional_relationship">Transactional relationship</option>
            <option value="commercial_marketing">Commercial marketing</option>
            <option value="mixed">Mixed</option>
          </Select>
        </div>
        <div>
          <label className="text-11 uppercase tracking-label text-ink-tertiary">Priority</label>
          <Select
            className="mt-1"
            value={settings.messagePriority}
            onChange={(e) => onChange({ ...settings, messagePriority: e.target.value })}
          >
            <option value="critical">Critical</option>
            <option value="normal">Normal</option>
            <option value="bulk">Bulk</option>
          </Select>
        </div>
        <div>
          <label className="text-11 uppercase tracking-label text-ink-tertiary">Sensitivity</label>
          <Select
            className="mt-1"
            value={settings.contentSensitivity}
            onChange={(e) => onChange({ ...settings, contentSensitivity: e.target.value })}
          >
            <option value="normal">Normal</option>
            <option value="financial">Financial</option>
            <option value="account">Account</option>
            <option value="health_safety">Health and safety</option>
            <option value="property_sensitive">Property sensitive</option>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <div>
          <label className="text-11 uppercase tracking-label text-ink-tertiary">Send stream</label>
          <Select
            className="mt-1"
            value={settings.sendStream}
            onChange={(e) => onChange({ ...settings, sendStream: e.target.value })}
          >
            <option value="transactional_required">Transactional required</option>
            <option value="service_operational">Service operational</option>
            <option value="marketing_newsletter">Marketing newsletter</option>
            <option value="marketing_referral">Marketing referral</option>
            <option value="marketing_nurture">Marketing nurture</option>
            <option value="internal">Internal</option>
          </Select>
        </div>
        <div>
          <label className="text-11 uppercase tracking-label text-ink-tertiary">Suppression group</label>
          <Select
            className="mt-1"
            value={settings.suppressionGroupKey}
            onChange={(e) => onChange({ ...settings, suppressionGroupKey: e.target.value })}
          >
            <option value="">Use stream default</option>
            {groups.map((g) => (
              <option key={g.key} value={g.key}>
                {g.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label className="text-11 uppercase tracking-label text-ink-tertiary">Wrapper</label>
          <Input
            className="mt-1"
            value={settings.layoutWrapperId}
            onChange={(e) => onChange({ ...settings, layoutWrapperId: e.target.value })}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <div>
          <label className="text-11 uppercase tracking-label text-ink-tertiary">From name</label>
          <Input
            className="mt-1"
            value={settings.fromName}
            onChange={(e) => onChange({ ...settings, fromName: e.target.value })}
          />
        </div>
        <div>
          <label className="text-11 uppercase tracking-label text-ink-tertiary">From email</label>
          <Input
            className="mt-1"
            value={settings.fromEmail}
            onChange={(e) => onChange({ ...settings, fromEmail: e.target.value })}
          />
        </div>
        <div>
          <label className="text-11 uppercase tracking-label text-ink-tertiary">Reply-to</label>
          <Input
            className="mt-1"
            value={settings.replyTo}
            onChange={(e) => onChange({ ...settings, replyTo: e.target.value })}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div>
          <label className="text-11 uppercase tracking-label text-ink-tertiary">Default CTA label</label>
          <Input
            className="mt-1"
            value={settings.defaultCtaLabel}
            onChange={(e) => onChange({ ...settings, defaultCtaLabel: e.target.value })}
          />
        </div>
        <div>
          <label className="text-11 uppercase tracking-label text-ink-tertiary">Default CTA URL variable</label>
          <Input
            className="mt-1"
            value={settings.defaultCtaUrlVariable}
            onChange={(e) => onChange({ ...settings, defaultCtaUrlVariable: e.target.value })}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <div>
          <label className="text-11 uppercase tracking-label text-ink-tertiary">Allowed variables</label>
          <Textarea
            className="mt-1 font-mono text-12"
            rows={4}
            value={settings.allowedVariablesText}
            onChange={(e) => onChange({ ...settings, allowedVariablesText: e.target.value })}
          />
        </div>
        <div>
          <label className="text-11 uppercase tracking-label text-ink-tertiary">Required variables</label>
          <Textarea
            className="mt-1 font-mono text-12"
            rows={4}
            value={settings.requiredVariablesText}
            onChange={(e) => onChange({ ...settings, requiredVariablesText: e.target.value })}
          />
        </div>
        <div>
          <label className="text-11 uppercase tracking-label text-ink-tertiary">Optional variables</label>
          <Textarea
            className="mt-1 font-mono text-12"
            rows={4}
            value={settings.optionalVariablesText}
            onChange={(e) => onChange({ ...settings, optionalVariablesText: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}

function TemplateList({ templates, selectedKey, onSelect, filter, onFilter, onToggleStatus, onDelete, busy }) {
  const modes = ["all", "service", "marketing"];
  const filtered = templates.filter((t) => filter === "all" || t.mode === filter);
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex items-center justify-between gap-3">
        <CardTitle>Email templates</CardTitle>
        <Select
          size="sm"
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          className="w-32"
        >
          {modes.map((m) => (
            <option key={m} value={m}>
              {m === "all" ? "All" : m}
            </option>
          ))}
        </Select>
      </CardHeader>
      <div className="divide-y divide-zinc-100">
        {filtered.map((t) => {
          const active = templateIsActive(t);
          return (
            <div
              key={t.template_key}
              id={`email-template-row-${t.template_key}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(t.template_key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(t.template_key);
                }
              }}
              className={cn(
                "w-full text-left px-4 py-3 hover:bg-zinc-50 transition-colors cursor-pointer",
                selectedKey === t.template_key && "bg-zinc-50",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-13 font-medium text-zinc-900 truncate">
                    {t.name}
                  </div>
                  <div className="text-11 text-ink-tertiary truncate">
                    {t.template_key}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <TemplateStatusBadge status={t.status} />
                  <Switch
                    checked={active}
                    disabled={busy}
                    aria-label={`${active ? "Disable" : "Enable"} ${t.name}`}
                    onChange={(next) => onToggleStatus(t, next)}
                  />
                  <ModeBadge mode={t.mode} />
                  {canDeleteEmailTemplate(t) ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="px-2"
                      aria-label={`Delete ${t.name}`}
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(t);
                      }}
                    >
                      <Trash2 size={14} />
                    </Button>
                  ) : null}
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2 text-11 text-ink-tertiary">
                <span>{t.purpose}</span>
                <span>{t.draft_count ? `${t.draft_count} draft` : "no draft"}</span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function BlockEditor({ blocks, onChange, variables }) {
  const updateBlock = (index, next) => {
    onChange(blocks.map((b, i) => (i === index ? next : b)));
  };
  const removeBlock = (index) => onChange(blocks.filter((_, i) => i !== index));
  const moveBlock = (index, dir) => {
    const next = [...blocks];
    const swap = index + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[index], next[swap]] = [next[swap], next[index]];
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {["paragraph", "heading", "callout", "details", "list", "cta", "small_note"].map((type) => (
          <Button
            key={type}
            size="sm"
            variant="secondary"
            className="gap-1"
            onClick={() => onChange([...blocks, defaultBlock(type)])}
          >
            <Plus size={13} /> {type.replace("_", " ")}
          </Button>
        ))}
      </div>
      {blocks.map((block, index) => (
        <Card key={`${block.type}-${index}`} className="border-zinc-200">
          <CardBody className="p-3">
            <div className="flex items-center justify-between gap-3 mb-2">
              <div className="flex items-center gap-2">
                <Badge tone="neutral">{block.type}</Badge>
                <span className="text-11 text-ink-tertiary">Block {index + 1}</span>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => moveBlock(index, -1)}>
                  Up
                </Button>
                <Button size="sm" variant="ghost" onClick={() => moveBlock(index, 1)}>
                  Down
                </Button>
                <Button size="sm" variant="ghost" onClick={() => removeBlock(index)}>
                  Remove
                </Button>
              </div>
            </div>
            {block.type === "details" ? (
              <div className="space-y-2">
                {asArray(block.rows).map((row, rowIndex) => (
                  <div key={rowIndex} className="grid grid-cols-2 gap-2">
                    <Input
                      value={row.label || ""}
                      onChange={(e) => {
                        const rows = asArray(block.rows).map((r, i) =>
                          i === rowIndex ? { ...r, label: e.target.value } : r,
                        );
                        updateBlock(index, { ...block, rows });
                      }}
                      placeholder="Label"
                    />
                    <Input
                      value={row.value || ""}
                      onChange={(e) => {
                        const rows = asArray(block.rows).map((r, i) =>
                          i === rowIndex ? { ...r, value: e.target.value } : r,
                        );
                        updateBlock(index, { ...block, rows });
                      }}
                      placeholder="Value"
                    />
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    updateBlock(index, {
                      ...block,
                      rows: [...asArray(block.rows), { label: "Label", value: "" }],
                    })
                  }
                >
                  Add row
                </Button>
              </div>
            ) : block.type === "list" ? (
              <div className="space-y-1">
                <Textarea
                  rows={Math.max(3, asArray(block.items).length + 1)}
                  value={asArray(block.items).join("\n")}
                  onChange={(e) =>
                    updateBlock(index, { ...block, items: e.target.value.split("\n") })
                  }
                  placeholder={"One check-list item per line."}
                />
                <p className="text-11 text-ink-tertiary">
                  One item per line. Blank lines (and items whose variables resolve empty) are
                  dropped from the sent email.
                </p>
              </div>
            ) : block.type === "cta" ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <Input
                  value={block.label || ""}
                  onChange={(e) => updateBlock(index, { ...block, label: e.target.value })}
                  placeholder="CTA label"
                />
                <Select
                  value={block.url_variable || ""}
                  onChange={(e) => updateBlock(index, { ...block, url_variable: e.target.value })}
                >
                  <option value="">Choose URL variable</option>
                  {variables.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </Select>
              </div>
            ) : (
              <Textarea
                rows={block.type === "heading" ? 2 : 4}
                value={block.content || ""}
                onChange={(e) => updateBlock(index, { ...block, content: e.target.value })}
              />
            )}
          </CardBody>
        </Card>
      ))}
    </div>
  );
}

export default function EmailTemplatesPanelV2() {
  const [activeView, setActiveView] = useState("templates");
  const [templates, setTemplates] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedKey, setSelectedKey] = useState(null);
  const [filter, setFilter] = useState("service");
  const [newTemplateOpen, setNewTemplateOpen] = useState(false);
  const [newTemplate, setNewTemplate] = useState(defaultNewTemplate());
  const [detail, setDetail] = useState(null);
  const [templateSettings, setTemplateSettings] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [templateIssues, setTemplateIssues] = useState([]);
  const [templateIssuesLoading, setTemplateIssuesLoading] = useState(false);
  const [suppressions, setSuppressions] = useState([]);
  const [suppressionStats, setSuppressionStats] = useState([]);
  const [suppressionLoading, setSuppressionLoading] = useState(false);
  const [suppressionFilter, setSuppressionFilter] = useState({ email: "", groupKey: "", status: "active" });
  const [suppressionForm, setSuppressionForm] = useState({
    email: "",
    groupKey: "",
    suppressionType: "manual",
    reason: "",
  });
  const [deliverability, setDeliverability] = useState(null);
  const [deliverabilityLoading, setDeliverabilityLoading] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [selectedFixtureId, setSelectedFixtureId] = useState(null);
  const [fixtureName, setFixtureName] = useState("");
  const [payload, setPayload] = useState("{}");
  const [preview, setPreview] = useState(null);
  const [audienceAppointmentId, setAudienceAppointmentId] = useState("");
  const [testEmail, setTestEmail] = useState("contact@wavespestcontrol.com");
  const [toast, setToast] = useState("");
  const [readErrors, setReadErrors] = useState({});
  const selectedKeyRef = useRef(selectedKey);
  selectedKeyRef.current = selectedKey;
  const detailSequence = useRef(0);
  const suppressionsSequence = useRef(0);
  const historySequence = useRef(0);
  const templateIssuesSequence = useRef(0);
  const deliverabilitySequence = useRef(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadTemplates = useCallback(() => {
    setLoading(true);
    return adminFetch("/admin/email-templates")
      .then((d) => {
        const rows = d.templates || [];
        const params = hashParams();
        const hashKey = params.get("tab") === "email_templates" ? params.get("key") : null;
        const hashTemplate = hashKey ? rows.find((t) => t.template_key === hashKey) : null;
        if (hashTemplate?.mode) setFilter(hashTemplate.mode);
        setTemplates(rows);
        setSelectedKey((prev) =>
          hashTemplate?.template_key ||
          prev ||
          rows.find((t) => t.mode === "service")?.template_key ||
          rows[0]?.template_key ||
          null,
        );
      })
      .catch((e) => setToast(`Load failed: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  const loadGroups = useCallback(() => {
    return adminFetch("/admin/email-templates/preference-groups")
      .then((d) => setGroups(d.groups || []))
      .catch((e) => setToast(`Preference groups failed: ${e.message}`));
  }, []);

  const applyFixture = useCallback((fixture) => {
    setSelectedFixtureId(fixture?.id || null);
    setFixtureName(fixture?.name || "Preview data");
    setPayload(JSON.stringify(asObject(fixture?.payload), null, 2));
  }, []);

  const loadDetail = useCallback((key) => {
    if (!key || key !== selectedKeyRef.current) return Promise.resolve(null);
    const seq = ++detailSequence.current;
    return adminFetch(`/admin/email-templates/${encodeURIComponent(key)}`)
      .then((d) => {
        if (seq !== detailSequence.current || key !== selectedKeyRef.current) return;
        setDetail(d);
        setTemplateSettings(settingsFromTemplate(d.template));
        const version = latestDraft(d.versions) || activeVersion(d.versions, d.template);
        setSelectedVersionId(version?.id || null);
        setDraft(version ? {
          subject: version.subject || "",
          previewText: version.preview_text || "",
          blocks: asArray(version.blocks),
          textBody: version.text_body || "",
          status: version.status,
        } : null);
        const fixture = (d.fixtures || []).find((f) => f.is_default) || d.fixtures?.[0];
        applyFixture(fixture);
        setPreview(null);
      })
      .catch((e) => {
        if (seq === detailSequence.current && key === selectedKeyRef.current) {
          setToast(`Template load failed: ${e.message}`);
        }
      });
  }, [applyFixture]);

  const loadHistory = useCallback(({ background = false } = {}) => {
    const seq = ++historySequence.current;
    if (!background) setHistoryLoading(true);
    return adminFetch("/admin/email-templates/send-history?limit=100")
      .then((d) => {
        if (seq !== historySequence.current) return;
        setHistory(d.messages || []);
        setReadErrors((prev) => ({ ...prev, history: null }));
      })
      .catch((e) => {
        if (seq === historySequence.current) setReadErrors((prev) => ({ ...prev, history: e.message }));
      })
      .finally(() => {
        if (seq === historySequence.current) setHistoryLoading(false);
      });
  }, []);

  const loadTemplateIssues = useCallback(({ background = false } = {}) => {
    const seq = ++templateIssuesSequence.current;
    if (!background) setTemplateIssuesLoading(true);
    return adminFetch("/admin/email-templates/issues?limit=100")
      .then((d) => {
        if (seq !== templateIssuesSequence.current) return;
        setTemplateIssues(d.issues || []);
        setReadErrors((prev) => ({ ...prev, issues: null }));
      })
      .catch((e) => {
        if (seq === templateIssuesSequence.current) setReadErrors((prev) => ({ ...prev, issues: e.message }));
      })
      .finally(() => {
        if (seq === templateIssuesSequence.current) setTemplateIssuesLoading(false);
      });
  }, []);

  const loadSuppressions = useCallback(() => {
    const seq = ++suppressionsSequence.current;
    setSuppressionLoading(true);
    const params = new URLSearchParams();
    params.set("limit", "150");
    if (suppressionFilter.email) params.set("email", suppressionFilter.email);
    if (suppressionFilter.groupKey) params.set("groupKey", suppressionFilter.groupKey);
    if (suppressionFilter.status) params.set("status", suppressionFilter.status);
    return adminFetch(`/admin/email-templates/suppressions?${params.toString()}`)
      .then((d) => {
        if (seq !== suppressionsSequence.current) return;
        setSuppressions(d.suppressions || []);
        setSuppressionStats(d.stats || []);
      })
      .catch((e) => {
        if (seq === suppressionsSequence.current) setToast(`Suppressions load failed: ${e.message}`);
      })
      .finally(() => {
        if (seq === suppressionsSequence.current) setSuppressionLoading(false);
      });
  }, [suppressionFilter]);

  const loadDeliverability = useCallback(({ background = false } = {}) => {
    const seq = ++deliverabilitySequence.current;
    if (!background) setDeliverabilityLoading(true);
    return adminFetch("/admin/email-templates/deliverability")
      .then((d) => {
        if (seq !== deliverabilitySequence.current) return;
        setDeliverability(d);
        setReadErrors((prev) => ({ ...prev, deliverability: null }));
      })
      .catch((e) => {
        if (seq === deliverabilitySequence.current) setReadErrors((prev) => ({ ...prev, deliverability: e.message }));
      })
      .finally(() => {
        if (seq === deliverabilitySequence.current) setDeliverabilityLoading(false);
      });
  }, []);

  const refreshReadView = () => {
    if (activeView === "history" && !historyLoading) return loadHistory({ background: true });
    if (activeView === "issues" && !templateIssuesLoading) return loadTemplateIssues({ background: true });
    if (activeView === "deliverability" && !deliverabilityLoading) return loadDeliverability({ background: true });
  };
  useVisiblePageRefresh(refreshReadView, { intervalMs: 60000, enabled: !loading && !busy });

  useEffect(() => {
    loadTemplates();
    loadGroups();
  }, [loadTemplates, loadGroups]);

  useEffect(() => () => {
    detailSequence.current += 1;
    suppressionsSequence.current += 1;
    historySequence.current += 1;
    templateIssuesSequence.current += 1;
    deliverabilitySequence.current += 1;
  }, []);

  useEffect(() => {
    setDetail(null);
    setTemplateSettings(null);
    setSelectedVersionId(null);
    setDraft(null);
    setSelectedFixtureId(null);
    setFixtureName("");
    setPayload("{}");
    setPreview(null);
    loadDetail(selectedKey);
  }, [selectedKey, loadDetail]);

  useEffect(() => {
    if (!selectedKey) return;
    const params = hashParams();
    if (params.get("tab") !== "email_templates" || params.get("key") !== selectedKey) return;
    window.setTimeout(() => {
      document.getElementById(`email-template-row-${selectedKey}`)?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    }, 80);
  }, [selectedKey, templates]);

  useEffect(() => {
    if (activeView === "history") loadHistory();
  }, [activeView, loadHistory]);

  useEffect(() => {
    if (activeView === "issues") loadTemplateIssues();
  }, [activeView, loadTemplateIssues]);

  useEffect(() => {
    if (activeView === "suppressions") loadSuppressions();
  }, [activeView, loadSuppressions]);

  useEffect(() => {
    if (activeView === "deliverability") loadDeliverability();
  }, [activeView, loadDeliverability]);

  const selectedVersion = useMemo(
    () => detail?.versions?.find((v) => v.id === selectedVersionId) || null,
    [detail, selectedVersionId],
  );
  const variables = useMemo(
    () => asArray(detail?.template?.allowed_variables),
    [detail],
  );
  const fixtures = useMemo(() => detail?.fixtures || [], [detail]);
  const selectedFixture = useMemo(
    () => fixtures.find((f) => f.id === selectedFixtureId) || null,
    [fixtures, selectedFixtureId],
  );
  const detailMatchesSelected = Boolean(selectedKey && detail?.template?.template_key === selectedKey);
  const detailWriteDisabled = busy || !detailMatchesSelected;
  const canEdit = Boolean(detailMatchesSelected && draft && selectedVersion?.status === "draft");

  const parsedPayload = () => {
    try {
      return JSON.parse(payload || "{}");
    } catch {
      throw new Error("Preview data must be valid JSON");
    }
  };

  const createTemplate = async () => {
    setBusy(true);
    setToast("");
    try {
      const body = {
        templateKey: newTemplate.templateKey,
        name: newTemplate.name,
        mode: newTemplate.mode,
        purpose: newTemplate.purpose,
        legalClassification: newTemplate.legalClassification,
        audience: newTemplate.audience,
        sendStream: newTemplate.sendStream,
        suppressionGroupKey: newTemplate.sendStream,
        subject: newTemplate.subject || newTemplate.name,
        allowedVariables: ["first_name"],
        requiredVariables: ["first_name"],
        optionalVariables: [],
      };
      const d = await adminFetch("/admin/email-templates", {
        method: "POST",
        body: JSON.stringify(body),
      });
      await loadTemplates();
      setSelectedKey(d.template.template_key);
      setFilter(newTemplate.mode);
      setNewTemplate(defaultNewTemplate());
      setNewTemplateOpen(false);
      setToast("Template created");
    } catch (e) {
      setToast(`Template create failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const createDraft = async () => {
    const key = selectedKey;
    if (!key || !detailMatchesSelected) return;
    setBusy(true);
    setToast("");
    try {
      const d = await adminFetch(`/admin/email-templates/${encodeURIComponent(key)}/versions`, { method: "POST" });
      if (key === selectedKeyRef.current) {
        await loadDetail(key);
        if (key === selectedKeyRef.current) setSelectedVersionId(d.version?.id || null);
      }
      setToast("Draft created");
    } catch (e) {
      setToast(`Draft failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const persistDraft = async () => {
    if (!detailMatchesSelected || !selectedVersionId || !draft) return;
    await adminFetch(`/admin/email-templates/versions/${selectedVersionId}`, {
      method: "PUT",
      body: JSON.stringify({
        subject: draft.subject,
        previewText: draft.previewText,
        blocks: draft.blocks,
        textBody: draft.textBody,
      }),
    });
    await loadDetail(selectedKey);
  };

  const saveDraft = async () => {
    if (!detailMatchesSelected || !selectedVersionId || !draft) return;
    setBusy(true);
    setToast("");
    try {
      await persistDraft();
      setToast("Draft saved");
    } catch (e) {
      setToast(`Save failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const renderPreview = async () => {
    if (!detailMatchesSelected || !selectedVersionId) return;
    setBusy(true);
    setToast("");
    try {
      if (canEdit) await persistDraft();
      const d = await adminFetch(`/admin/email-templates/versions/${selectedVersionId}/preview`, {
        method: "POST",
        body: JSON.stringify({
          payload: parsedPayload(),
          // Only the two onboarding templates show the appointment field; a
          // stale value must not ride along on every other preview (Codex
          // #4112 r6: the server validates the ID before the template check).
          scheduledServiceId: AUDIENCE_PREVIEW_TEMPLATE_KEYS.includes(selectedKey) ? audienceAppointmentId.trim() || undefined : undefined,
        }),
      });
      setPreview(d);
      if (d.missingPayload?.length) {
        setToast(`Missing data: ${d.missingPayload.join(", ")}`);
      }
    } catch (e) {
      setToast(`Preview failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    if (!detailMatchesSelected || !selectedVersionId) return;
    setBusy(true);
    setToast("");
    try {
      if (canEdit) await persistDraft();
      await adminFetch(`/admin/email-templates/versions/${selectedVersionId}/test`, {
        method: "POST",
        body: JSON.stringify({ toEmail: testEmail, payload: parsedPayload() }),
      });
      setToast("Test sent");
    } catch (e) {
      setToast(`Test failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!detailMatchesSelected || !selectedVersionId) return;
    setBusy(true);
    setToast("");
    try {
      if (canEdit) await persistDraft();
      await adminFetch(`/admin/email-templates/versions/${selectedVersionId}/publish`, {
        method: "POST",
      });
      await loadTemplates();
      await loadDetail(selectedKey);
      setToast("Published");
    } catch (e) {
      setToast(`Publish failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const saveTemplateSettings = async () => {
    if (!detailMatchesSelected || !selectedKey || !templateSettings) return;
    setBusy(true);
    setToast("");
    try {
      await adminFetch(`/admin/email-templates/${selectedKey}`, {
        method: "PUT",
        body: JSON.stringify({
          name: templateSettings.name,
          description: templateSettings.description,
          mode: templateSettings.mode,
          purpose: templateSettings.purpose,
          legalClassification: templateSettings.legalClassification,
          audience: templateSettings.audience,
          messagePriority: templateSettings.messagePriority,
          contentSensitivity: templateSettings.contentSensitivity,
          sendStream: templateSettings.sendStream,
          suppressionGroupKey: templateSettings.suppressionGroupKey || null,
          layoutWrapperId: templateSettings.layoutWrapperId,
          fromName: templateSettings.fromName,
          fromEmail: templateSettings.fromEmail,
          replyTo: templateSettings.replyTo,
          defaultCtaLabel: templateSettings.defaultCtaLabel,
          defaultCtaUrlVariable: templateSettings.defaultCtaUrlVariable,
          allowedVariables: parseListText(templateSettings.allowedVariablesText),
          requiredVariables: parseListText(templateSettings.requiredVariablesText),
          optionalVariables: parseListText(templateSettings.optionalVariablesText),
        }),
      });
      await loadTemplates();
      await loadDetail(selectedKey);
      setToast("Template settings saved");
    } catch (e) {
      setToast(`Settings save failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleTemplateStatus = async (template, nextActive) => {
    const key = template?.template_key || selectedKey;
    if (!key) return;
    const nextStatus = nextActive ? "active" : "paused";
    setBusy(true);
    setToast("");
    try {
      const d = await adminFetch(`/admin/email-templates/${key}`, {
        method: "PUT",
        body: JSON.stringify({ status: nextStatus }),
      });
      const updated = d.template || { ...template, status: nextStatus };
      setTemplates((prev) =>
        prev.map((row) =>
          row.template_key === key
            ? { ...row, status: updated.status || nextStatus }
            : row,
        ),
      );
      setDetail((prev) =>
        prev?.template?.template_key === key
          ? { ...prev, template: { ...prev.template, ...updated } }
          : prev,
      );
      setToast(`${updated.name || template?.name || key} ${nextStatus === "active" ? "enabled" : "paused"}`);
    } catch (e) {
      setToast(`Template toggle failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteTemplate = async (template) => {
    if (!template?.template_key) return;
    if (!window.confirm("Delete this email template? This can't be undone.")) return;
    setBusy(true);
    setToast("");
    try {
      await adminFetch(`/admin/email-templates/${template.template_key}`, { method: "DELETE" });
      setTemplates((prev) => prev.filter((row) => row.template_key !== template.template_key));
      if (selectedKey === template.template_key) {
        setSelectedKey(null);
        setDetail(null);
      }
      await loadTemplates();
      setToast("Email template deleted");
    } catch (e) {
      if (e.status === 409 && e.body?.automations?.length) {
        setToast(`In use by automation(s): ${e.body.automations.join(", ")}. Delete those first.`);
      } else {
        setToast(`Template delete failed: ${e.message}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const createSuppression = async () => {
    setBusy(true);
    setToast("");
    try {
      await adminFetch("/admin/email-templates/suppressions", {
        method: "POST",
        body: JSON.stringify({
          email: suppressionForm.email,
          groupKey: suppressionForm.groupKey || null,
          suppressionType: suppressionForm.suppressionType,
          reason: suppressionForm.reason,
        }),
      });
      setSuppressionForm({ email: "", groupKey: "", suppressionType: "manual", reason: "" });
      await loadSuppressions();
      setToast("Suppression added");
    } catch (e) {
      setToast(`Suppression failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const releaseSuppression = async (id) => {
    setBusy(true);
    setToast("");
    try {
      await adminFetch(`/admin/email-templates/suppressions/${id}/release`, {
        method: "POST",
        body: JSON.stringify({ reason: "Released from admin communications panel" }),
      });
      await loadSuppressions();
      setToast("Suppression released");
    } catch (e) {
      setToast(`Release failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const selectFixture = (id) => {
    const fixture = fixtures.find((f) => f.id === id);
    if (!fixture) return;
    applyFixture(fixture);
    setPreview(null);
  };

  const createFixture = async () => {
    if (!detailMatchesSelected || !selectedKey) return;
    setBusy(true);
    setToast("");
    try {
      const baseName = fixtureName.trim() || "Preview data";
      const d = await adminFetch(`/admin/email-templates/${selectedKey}/fixtures`, {
        method: "POST",
        body: JSON.stringify({
          name: fixtures.length ? `${baseName} copy` : baseName,
          payload: parsedPayload(),
          isDefault: fixtures.length === 0,
        }),
      });
      await loadDetail(selectedKey);
      applyFixture(d.fixture);
      setToast("Preview fixture created");
    } catch (e) {
      setToast(`Fixture create failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const saveFixture = async () => {
    if (!detailMatchesSelected) return;
    if (!selectedFixtureId) return createFixture();
    setBusy(true);
    setToast("");
    try {
      const d = await adminFetch(`/admin/email-templates/fixtures/${selectedFixtureId}`, {
        method: "PUT",
        body: JSON.stringify({
          name: fixtureName,
          payload: parsedPayload(),
        }),
      });
      await loadDetail(selectedKey);
      applyFixture(d.fixture);
      setToast("Preview fixture saved");
    } catch (e) {
      setToast(`Fixture save failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const setDefaultFixture = async () => {
    if (!detailMatchesSelected || !selectedFixtureId) return;
    setBusy(true);
    setToast("");
    try {
      const d = await adminFetch(`/admin/email-templates/fixtures/${selectedFixtureId}/default`, {
        method: "POST",
      });
      await loadDetail(selectedKey);
      applyFixture(d.fixture);
      setToast("Default preview fixture updated");
    } catch (e) {
      setToast(`Default fixture failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteFixture = async () => {
    if (!detailMatchesSelected || !selectedFixtureId || fixtures.length <= 1) return;
    setBusy(true);
    setToast("");
    try {
      await adminFetch(`/admin/email-templates/fixtures/${selectedFixtureId}`, { method: "DELETE" });
      await loadDetail(selectedKey);
      setToast("Preview fixture deleted");
    } catch (e) {
      setToast(`Fixture delete failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-13 text-ink-secondary">Loading email templates...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        <Button
          variant={activeView === "templates" ? "primary" : "secondary"}
          size="sm"
          className="gap-2"
          onClick={() => setActiveView("templates")}
        >
          <Mail size={14} /> Templates
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="gap-2"
          onClick={() => {
            setActiveView("templates");
            setNewTemplateOpen(true);
          }}
        >
          <Plus size={14} /> New Template
        </Button>
        <Button
          variant={activeView === "history" ? "primary" : "secondary"}
          size="sm"
          className="gap-2"
          onClick={() => setActiveView("history")}
        >
          <History size={14} /> Send History
        </Button>
        <Button
          variant={activeView === "issues" ? "primary" : "secondary"}
          size="sm"
          className="gap-2"
          onClick={() => setActiveView("issues")}
        >
          <AlertTriangle size={14} /> Issues
        </Button>
        <Button
          variant={activeView === "suppressions" ? "primary" : "secondary"}
          size="sm"
          className="gap-2"
          onClick={() => setActiveView("suppressions")}
        >
          <ShieldCheck size={14} /> Suppressions
        </Button>
        <Button
          variant={activeView === "deliverability" ? "primary" : "secondary"}
          size="sm"
          className="gap-2"
          onClick={() => setActiveView("deliverability")}
        >
          <Activity size={14} /> Deliverability
        </Button>
      </div>

      {toast && <div className="text-12 text-ink-secondary">{toast}</div>}
      {readErrors[activeView] && <ActionFeedback error onRetry={busy ? undefined : refreshReadView}>{readErrors[activeView]}</ActionFeedback>}

      {activeView === "history" ? (
        <SendHistoryPanel messages={history} loading={historyLoading} />
      ) : activeView === "issues" ? (
        <TemplateIssuesPanel
          issues={templateIssues}
          loading={templateIssuesLoading}
          onOpenTemplate={(key) => {
            if (!key) return;
            setSelectedKey(key);
            setActiveView("templates");
          }}
        />
      ) : activeView === "suppressions" ? (
        <SuppressionsPanel
          groups={groups}
          suppressions={suppressions}
          stats={suppressionStats}
          loading={suppressionLoading}
          filter={suppressionFilter}
          form={suppressionForm}
          busy={busy}
          onFilter={setSuppressionFilter}
          onForm={setSuppressionForm}
          onRefresh={loadSuppressions}
          onCreate={createSuppression}
          onRelease={releaseSuppression}
        />
      ) : activeView === "deliverability" ? (
        <DeliverabilityPanel
          data={deliverability}
          loading={deliverabilityLoading}
        />
      ) : (
        <>
          {newTemplateOpen && (
            <CreateTemplateCard
              value={newTemplate}
              busy={busy}
              onChange={setNewTemplate}
              onCreate={createTemplate}
              onCancel={() => {
                setNewTemplateOpen(false);
                setNewTemplate(defaultNewTemplate());
              }}
            />
          )}
          <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
            <TemplateList
              templates={templates}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              filter={filter}
              onFilter={setFilter}
              onToggleStatus={toggleTemplateStatus}
              onDelete={deleteTemplate}
              busy={busy}
            />

            <div className="space-y-4">
        <Card>
          <CardHeader className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <CardTitle>{detail?.template?.name || "Email template"}</CardTitle>
                <TemplateStatusBadge status={detail?.template?.status} />
                <ModeBadge mode={detail?.template?.mode} />
                <VersionBadge version={selectedVersion} />
              </div>
              <div className="text-12 text-ink-tertiary mt-1">
                {detail?.template?.template_key}
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button variant="secondary" size="sm" className="gap-2" onClick={() => loadDetail(selectedKey)} disabled={busy || !selectedKey}>
                <RefreshCw size={14} /> Reload
              </Button>
              {!canEdit && (
                <Button variant="secondary" size="sm" className="gap-2" onClick={createDraft} disabled={detailWriteDisabled}>
                  <Plus size={14} /> New draft
                </Button>
              )}
              <Button variant="secondary" size="sm" className="gap-2" onClick={renderPreview} disabled={detailWriteDisabled}>
                <Eye size={14} /> Preview
              </Button>
              {canEdit && (
                <Button variant="secondary" size="sm" className="gap-2" onClick={saveDraft} disabled={detailWriteDisabled}>
                  <Save size={14} /> Save
                </Button>
              )}
              {canEdit && (
                <Button variant="primary" size="sm" className="gap-2" onClick={publish} disabled={detailWriteDisabled}>
                  <CheckCircle size={14} /> Publish
                </Button>
              )}
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <TemplateSettingsPanel
              settings={templateSettings}
              groups={groups}
              busy={detailWriteDisabled}
              onChange={setTemplateSettings}
              onSave={saveTemplateSettings}
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-11 uppercase tracking-label text-ink-tertiary">Version</label>
                <Select
                  className="mt-1"
                  value={selectedVersionId || ""}
                  onChange={(e) => {
                    const version = detail?.versions?.find((v) => v.id === e.target.value);
                    setSelectedVersionId(e.target.value);
                    setDraft(version ? {
                      subject: version.subject || "",
                      previewText: version.preview_text || "",
                      blocks: asArray(version.blocks),
                      textBody: version.text_body || "",
                      status: version.status,
                    } : null);
                    setPreview(null);
                  }}
                >
                  {(detail?.versions || []).map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.version_number} - {v.status}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="text-11 uppercase tracking-label text-ink-tertiary">Allowed variables</label>
                <div className="mt-1 flex gap-1 flex-wrap">
                  {variables.map((v) => (
                    <Badge key={v} tone="neutral">
                      {`{{${v}}}`}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>

            {draft && (
              <>
                <div>
                  <label className="text-11 uppercase tracking-label text-ink-tertiary">Subject</label>
                  <Input
                    className="mt-1"
                    value={draft.subject}
                    disabled={!canEdit}
                    onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-11 uppercase tracking-label text-ink-tertiary">Preview text</label>
                  <Input
                    className="mt-1"
                    value={draft.previewText}
                    disabled={!canEdit}
                    onChange={(e) => setDraft({ ...draft, previewText: e.target.value })}
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <label className="text-11 uppercase tracking-label text-ink-tertiary">Structured body blocks</label>
                    {!canEdit && <span className="text-11 text-ink-tertiary">Create a draft to edit</span>}
                  </div>
                  {canEdit ? (
                    <BlockEditor
                      blocks={draft.blocks}
                      variables={variables}
                      onChange={(blocks) => setDraft({ ...draft, blocks })}
                    />
                  ) : (
                    <div className="space-y-2">
                      {draft.blocks.map((b, idx) => (
                        <div key={idx} className="rounded-sm border-hairline border-zinc-200 p-3 text-13 text-ink-secondary">
                          <Badge tone="neutral">{b.type}</Badge>
                          <div className="mt-2 whitespace-pre-wrap">
                            {b.type === "details"
                              ? asArray(b.rows).map((r) => `${r.label}: ${r.value}`).join("\n")
                              : b.type === "cta"
                                ? `${b.label} -> ${b.url_variable}`
                                : b.content}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </CardBody>
        </Card>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Preview data</CardTitle>
            </CardHeader>
            <CardBody className="space-y-3">
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr_auto] gap-2">
                <Select
                  value={selectedFixtureId || ""}
                  onChange={(e) => selectFixture(e.target.value)}
                >
                  {fixtures.length ? fixtures.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}{f.is_default ? " (default)" : ""}
                    </option>
                  )) : (
                    <option value="">No preview data</option>
                  )}
                </Select>
                <Input
                  value={fixtureName}
                  onChange={(e) => setFixtureName(e.target.value)}
                  placeholder="Fixture name"
                />
                <div className="flex gap-2 flex-wrap">
                  <Button variant="secondary" size="sm" className="gap-2" onClick={createFixture} disabled={detailWriteDisabled}>
                    <Plus size={14} /> New
                  </Button>
                  <Button variant="secondary" size="sm" className="gap-2" onClick={saveFixture} disabled={detailWriteDisabled}>
                    <Save size={14} /> Save
                  </Button>
                </div>
              </div>
              <div className="flex gap-2 flex-wrap items-center">
                {selectedFixture?.is_default ? (
                  <Badge tone="strong">Default fixture</Badge>
                ) : (
                  <Button variant="ghost" size="sm" className="gap-2" onClick={setDefaultFixture} disabled={detailWriteDisabled || !selectedFixtureId}>
                    <Star size={14} /> Set default
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-2"
                  onClick={deleteFixture}
                  disabled={detailWriteDisabled || !selectedFixtureId || fixtures.length <= 1}
                >
                  <Trash2 size={14} /> Delete
                </Button>
              </div>
              {AUDIENCE_PREVIEW_TEMPLATE_KEYS.includes(selectedKey) && (
                <div className="space-y-2">
                  <label htmlFor="email-audience-appointment" className="text-14 text-ink-secondary">Appointment ID for an audience check (optional)</label>
                  <Input
                    id="email-audience-appointment"
                    value={audienceAppointmentId}
                    onChange={(event) => { setAudienceAppointmentId(event.target.value); setPreview(null); }}
                    placeholder="Paste an appointment UUID, then choose Preview"
                  />
                  {preview?.audiencePreview?.scheduledServiceId === audienceAppointmentId.trim() && preview.audiencePreview.templateKey === selectedKey && (
                    <div className="rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3 text-14 text-ink-secondary" role="status">
                      {preview.audiencePreview.applies ? (
                        <p>Before audience expansion: {preview.audiencePreview.before ? "Yes" : "No"}. After: {preview.audiencePreview.after ? "Yes" : "No"}.</p>
                      ) : <p>This appointment’s audience is unchanged.</p>}
                      <p>Email gate: {preview.audiencePreview.gateEnabled ? "Enabled" : "Off"}.</p>
                      <p className="mt-2">{preview.audiencePreview.note}</p>
                    </div>
                  )}
                </div>
              )}
              <Textarea
                rows={12}
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
                className="font-mono text-12"
              />
              <div className="flex gap-2 flex-wrap items-center">
                <Input
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  className="max-w-xs"
                />
                <Button variant="secondary" className="gap-2" onClick={sendTest} disabled={detailWriteDisabled}>
                  <Send size={14} /> Send test
                </Button>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader className="flex items-center gap-2">
              <Mail size={15} />
              <CardTitle>Rendered email</CardTitle>
            </CardHeader>
            <CardBody>
              {preview ? (
                <div className="space-y-3">
                  <div>
                    <div className="text-11 uppercase tracking-label text-ink-tertiary">Subject</div>
                    <div className="text-14 font-medium text-zinc-900">{preview.subject}</div>
                  </div>
                  <iframe
                    title="Email preview"
                    srcDoc={preview.html}
                    // sandbox with no allow-scripts / allow-same-origin: the
                    // preview renders HTML/CSS but can't run scripts or navigate
                    // in the admin origin, so a javascript: CTA in the template
                    // can't execute when clicked.
                    sandbox=""
                    className="w-full h-[520px] rounded-sm border-hairline border-zinc-200 bg-white"
                  />
                </div>
              ) : (
                <div className="h-[520px] rounded-sm border-hairline border-dashed border-zinc-300 flex items-center justify-center text-13 text-ink-tertiary">
                  Render a preview to inspect the final email.
                </div>
              )}
            </CardBody>
          </Card>
        </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
