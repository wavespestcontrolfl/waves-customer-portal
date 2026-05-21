import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  Mail,
  MessageSquare,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  Input,
  Switch,
  Textarea,
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
      const err = new Error(data?.error || `HTTP ${r.status}`);
      err.status = r.status;
      err.body = data;
      throw err;
    }
    return data;
  });
}

function statusLabel(status) {
  if (status === "paired") return "Paired";
  if (status === "email_only") return "Email only";
  if (status === "sms_only") return "SMS only";
  return "Unmapped";
}

function statusTone(status) {
  if (status === "paired") return "strong";
  if (status === "unmapped") return "alert";
  return "neutral";
}

function minutesLabel(value) {
  const minutes = Number(value || 0);
  if (!minutes) return "Immediate";
  if (minutes % 1440 === 0) return `${minutes / 1440}d delay`;
  if (minutes % 60 === 0) return `${minutes / 60}h delay`;
  return `${minutes}m delay`;
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

function canDeleteSmsTemplate(template) {
  if (template?.can_delete !== undefined) return template.can_delete === true;
  return template?.category === "custom";
}

function smsDraftFrom(template = {}) {
  return {
    body: template.body || "",
    is_active: template.is_active !== false,
  };
}

function emailDraftFrom(automation = {}) {
  return {
    status: automation.status || "draft",
    subject: automation.subject || "",
    previewText: automation.preview_text || "",
  };
}

function hashTo(params) {
  if (typeof window === "undefined") return;
  const nextHash = `#${new URLSearchParams(params).toString()}`;
  if (window.location.hash === nextHash) {
    window.dispatchEvent(new Event("hashchange"));
    return;
  }
  window.location.hash = nextHash;
}

function updateSmsRows(events, id, updater) {
  return events.map((event) => ({
    ...event,
    sms_templates: (event.sms_templates || []).map((template) =>
      template.id === id ? updater(template) : template,
    ),
  }));
}

function removeSmsRows(events, id) {
  return events.map((event) => ({
    ...event,
    sms_templates: (event.sms_templates || []).filter((template) => template.id !== id),
  }));
}

function updateEmailRows(events, automationKey, updater) {
  return events.map((event) => ({
    ...event,
    email_automations: (event.email_automations || []).map((automation) =>
      automation.automation_key === automationKey ? updater(automation) : automation,
    ),
  }));
}

function Variables({ variables }) {
  const rows = asArray(variables);
  if (!rows.length) return null;
  return (
    <div className="mt-2 flex gap-1 flex-wrap">
      {rows.map((v) => (
        <span
          key={v}
          className="text-10 px-1.5 py-0.5 rounded-xs bg-zinc-50 text-ink-tertiary border-hairline font-mono"
        >
          {`{${v}}`}
        </span>
      ))}
    </div>
  );
}

function MissingChannel({ channel, onClick }) {
  const Icon = channel === "sms" ? MessageSquare : Mail;
  return (
    <Card className="border-dashed bg-zinc-50">
      <CardBody className="min-h-[190px] flex flex-col justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-12 uppercase tracking-label text-ink-tertiary">
            <Icon size={14} />
            {channel === "sms" ? "SMS" : "Email"}
          </div>
          <div className="mt-3 text-13 text-ink-secondary">
            No {channel === "sms" ? "SMS template" : "email automation"} is mapped to this event.
          </div>
        </div>
        <Button variant="secondary" size="sm" className="gap-2 self-start" onClick={onClick}>
          <Plus size={14} /> Configure {channel === "sms" ? "SMS" : "Email"}
        </Button>
      </CardBody>
    </Card>
  );
}

function SmsCard({
  template,
  draft,
  pending,
  showDelete,
  onDraft,
  onSave,
  onDelete,
}) {
  return (
    <Card id={`sms-template-${template.template_key}`}>
      <CardBody className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <MessageSquare size={14} />
              <div className="text-14 font-semibold text-zinc-900 truncate">{template.name}</div>
              <Badge tone="neutral" className="capitalize">{template.category || "sms"}</Badge>
            </div>
            <div className="mt-1 text-11 text-ink-tertiary font-mono truncate">
              {template.template_key}
            </div>
          </div>
          <Switch
            checked={draft.is_active}
            disabled={pending}
            aria-label={`${draft.is_active ? "Disable" : "Enable"} ${template.name}`}
            onChange={(next) => onDraft({ ...draft, is_active: next })}
          />
        </div>

        <Textarea
          rows={5}
          value={draft.body}
          disabled={pending}
          onChange={(e) => onDraft({ ...draft, body: e.target.value })}
        />
        <Variables variables={template.variables} />

        <div className="flex gap-2 flex-wrap">
          <Button variant="primary" size="sm" className="gap-2" disabled={pending} onClick={onSave}>
            <Save size={14} /> Save
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="gap-2"
            onClick={() => hashTo({ tab: "templates", key: template.template_key })}
          >
            <ExternalLink size={14} /> Open in SMS Templates
          </Button>
          {showDelete ? (
            <Button variant="ghost" size="sm" className="gap-2" disabled={pending} onClick={onDelete}>
              <Trash2 size={14} /> Delete
            </Button>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

function EmailCard({ automation, draft, pending, onDraft, onSave }) {
  const canEditVersion = automation.active_version_id && automation.version_status === "draft";
  return (
    <Card id={`email-template-${automation.template_key}`}>
      <CardBody className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Mail size={14} />
              <div className="text-14 font-semibold text-zinc-900 truncate">
                {automation.template_name || automation.template_key}
              </div>
              <Badge tone={automation.status === "active" ? "strong" : "neutral"}>
                {automation.status || "draft"}
              </Badge>
              {automation.active_version_number ? (
                <Badge tone={automation.version_status === "active" ? "strong" : "neutral"}>
                  v{automation.active_version_number} {automation.version_status || ""}
                </Badge>
              ) : (
                <Badge tone="alert">No active version</Badge>
              )}
            </div>
            <div className="mt-1 text-11 text-ink-tertiary font-mono truncate">
              {automation.automation_key} / {automation.template_key}
            </div>
          </div>
          <Switch
            checked={draft.status === "active"}
            disabled={pending}
            aria-label={`${draft.status === "active" ? "Pause" : "Activate"} ${automation.automation_key}`}
            onChange={(next) => onDraft({ ...draft, status: next ? "active" : "paused" })}
          />
        </div>

        <div className="flex gap-2 flex-wrap">
          <Badge tone="neutral">{minutesLabel(automation.delay_minutes)}</Badge>
          {automation.audience ? <Badge tone="neutral">{automation.audience}</Badge> : null}
          {automation.frequency_cap ? <Badge tone="neutral">{automation.frequency_cap}</Badge> : null}
        </div>

        <div className="space-y-2">
          <div>
            <label className="text-11 uppercase tracking-label text-ink-tertiary">Subject</label>
            <Input
              className="mt-1"
              value={draft.subject}
              disabled={pending || !canEditVersion}
              onChange={(e) => onDraft({ ...draft, subject: e.target.value })}
            />
          </div>
          <div>
            <label className="text-11 uppercase tracking-label text-ink-tertiary">Preview text</label>
            <Input
              className="mt-1"
              value={draft.previewText}
              disabled={pending || !canEditVersion}
              onChange={(e) => onDraft({ ...draft, previewText: e.target.value })}
            />
          </div>
          {!canEditVersion ? (
            <div className="text-11 text-ink-tertiary">
              Create a draft in Email Templates to edit subject and preview text.
            </div>
          ) : null}
        </div>

        <div className="flex gap-2 flex-wrap">
          <Button variant="primary" size="sm" className="gap-2" disabled={pending} onClick={onSave}>
            <Save size={14} /> Save
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="gap-2"
            onClick={() => hashTo({ tab: "email_templates", key: automation.template_key })}
          >
            <ExternalLink size={14} /> Open in Email Templates
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-2"
            onClick={() => hashTo({ tab: "email_templates", key: automation.template_key })}
          >
            <ExternalLink size={14} /> Edit blocks / versions
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function EventSection({
  event,
  smsDrafts,
  emailDrafts,
  pending,
  onSmsDraft,
  onEmailDraft,
  onSmsSave,
  onEmailSave,
}) {
  const expectedSms = event.channels_expected?.includes("sms");
  const expectedEmail = event.channels_expected?.includes("email");
  const smsTemplates = event.sms_templates || [];
  const emailAutomations = event.email_automations || [];

  return (
    <section className="border-b border-hairline border-zinc-200 pb-5 last:border-b-0 last:pb-0">
      <div className="mb-3 flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-16 font-semibold text-zinc-900">{event.name || event.event_key}</h3>
            <Badge tone={statusTone(event.status)}>{statusLabel(event.status)}</Badge>
            {event.audience ? <Badge tone="neutral">{event.audience}</Badge> : null}
            {event.fires_when ? <Badge tone="neutral">{event.fires_when}</Badge> : null}
          </div>
          {event.description ? (
            <div className="mt-1 text-13 text-ink-secondary">{event.description}</div>
          ) : null}
          {event.source ? (
            <div className="mt-1 text-11 text-ink-tertiary">Source: {event.source}</div>
          ) : null}
        </div>
        <div className="text-11 text-ink-tertiary font-mono">{event.event_key}</div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div className="space-y-3">
          {smsTemplates.map((template) => (
            <SmsCard
              key={template.id}
              template={template}
              draft={smsDrafts[template.id] || smsDraftFrom(template)}
              pending={!!pending[`sms:${template.id}`]}
              onDraft={(next) => onSmsDraft(template.id, next)}
              onSave={() => onSmsSave(template)}
            />
          ))}
          {!smsTemplates.length && expectedSms ? (
            <MissingChannel channel="sms" onClick={() => hashTo({ tab: "templates" })} />
          ) : null}
        </div>

        <div className="space-y-3">
          {emailAutomations.map((automation) => (
            <EmailCard
              key={automation.automation_key}
              automation={automation}
              draft={emailDrafts[automation.automation_key] || emailDraftFrom(automation)}
              pending={!!pending[`email:${automation.automation_key}`]}
              onDraft={(next) => onEmailDraft(automation.automation_key, next)}
              onSave={() => onEmailSave(automation)}
            />
          ))}
          {!emailAutomations.length && expectedEmail ? (
            <MissingChannel channel="email" onClick={() => hashTo({ tab: "email_templates", view: "automations" })} />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SmsOnlyBucket({ event, smsDrafts, pending, onSmsDraft, onSmsSave, onSmsDelete }) {
  const rows = event.sms_templates || [];
  return (
    <details className="rounded-md border-hairline border-zinc-200 bg-white">
      <summary className="cursor-pointer px-4 py-3 text-13 font-medium text-zinc-900">
        {event.name} ({rows.length})
      </summary>
      <div className="border-t border-hairline border-zinc-200 p-4">
        {rows.length ? (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {rows.map((template) => (
              <SmsCard
                key={template.id}
                template={template}
                draft={smsDrafts[template.id] || smsDraftFrom(template)}
                pending={!!pending[`sms:${template.id}`] || !!pending[`delete-sms:${template.id}`]}
                showDelete={canDeleteSmsTemplate(template)}
                onDraft={(next) => onSmsDraft(template.id, next)}
                onSave={() => onSmsSave(template)}
                onDelete={() => onSmsDelete(template)}
              />
            ))}
          </div>
        ) : (
          <div className="text-13 text-ink-secondary">No channel-only SMS templates.</div>
        )}
      </div>
    </details>
  );
}

function EmailOnlyBucket({ event }) {
  return (
    <details className="rounded-md border-hairline border-zinc-200 bg-white">
      <summary className="cursor-pointer px-4 py-3 text-13 font-medium text-zinc-900">
        {event.name} ({event.email_automations?.length || 0})
      </summary>
      <div className="border-t border-hairline border-zinc-200 p-4 text-13 text-ink-secondary">
        Reserved for email templates without an automation event.
      </div>
    </details>
  );
}

export default function NotificationEventsTabV2() {
  const [events, setEvents] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [smsDrafts, setSmsDrafts] = useState({});
  const [emailDrafts, setEmailDrafts] = useState({});
  const [pending, setPending] = useState({});
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");

  const markPending = (key, value) => {
    setPending((prev) => ({ ...prev, [key]: value }));
  };

  const loadEvents = useCallback(() => {
    setLoading(true);
    setToast("");
    return adminFetch("/admin/notification-events")
      .then((d) => {
        const nextEvents = d.events || [];
        setEvents(nextEvents);
        setCatalog(d.catalog || []);
        setSmsDrafts(Object.fromEntries(
          nextEvents.flatMap((event) =>
            (event.sms_templates || []).map((template) => [template.id, smsDraftFrom(template)]),
          ),
        ));
        setEmailDrafts(Object.fromEntries(
          nextEvents.flatMap((event) =>
            (event.email_automations || []).map((automation) => [
              automation.automation_key,
              emailDraftFrom(automation),
            ]),
          ),
        ));
      })
      .catch((e) => setToast(`Notification events failed: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const regularEvents = useMemo(
    () => events.filter((event) => !event.event_key?.startsWith("__")),
    [events],
  );
  const smsOnlyEvent = events.find((event) => event.event_key === "__sms_only__");
  const emailOnlyEvent = events.find((event) => event.event_key === "__email_only__");

  const saveSms = async (template) => {
    const key = `sms:${template.id}`;
    const draft = smsDrafts[template.id] || smsDraftFrom(template);
    markPending(key, true);
    setToast("");
    setEvents((prev) => updateSmsRows(prev, template.id, (row) => ({
      ...row,
      body: draft.body,
      is_active: draft.is_active,
    })));
    try {
      await adminFetch(`/admin/sms-templates/${template.id}`, {
        method: "PUT",
        body: JSON.stringify({ body: draft.body, is_active: draft.is_active }),
      });
      setToast(`${template.name} saved`);
    } catch (e) {
      setEvents((prev) => updateSmsRows(prev, template.id, () => template));
      setSmsDrafts((prev) => ({ ...prev, [template.id]: smsDraftFrom(template) }));
      setToast(`SMS save failed: ${e.message}`);
    } finally {
      markPending(key, false);
    }
  };

  const deleteSms = async (template) => {
    if (!window.confirm("Delete this SMS template? This can't be undone.")) return;
    const key = `delete-sms:${template.id}`;
    markPending(key, true);
    setToast("");
    try {
      await adminFetch(`/admin/sms-templates/${template.id}`, { method: "DELETE" });
      setEvents((prev) => removeSmsRows(prev, template.id));
      setSmsDrafts((prev) => {
        const next = { ...prev };
        delete next[template.id];
        return next;
      });
      setToast(`${template.name} deleted`);
    } catch (e) {
      setToast(`SMS delete failed: ${e.message}`);
    } finally {
      markPending(key, false);
    }
  };

  const saveEmail = async (automation) => {
    const key = `email:${automation.automation_key}`;
    const draft = emailDrafts[automation.automation_key] || emailDraftFrom(automation);
    const canEditVersion = automation.active_version_id && automation.version_status === "draft";
    markPending(key, true);
    setToast("");
    setEvents((prev) => updateEmailRows(prev, automation.automation_key, (row) => ({
      ...row,
      status: draft.status,
      subject: canEditVersion ? draft.subject : row.subject,
      preview_text: canEditVersion ? draft.previewText : row.preview_text,
    })));
    try {
      if (draft.status !== automation.status) {
        await adminFetch(`/admin/email-templates/automations/${automation.automation_key}`, {
          method: "PUT",
          body: JSON.stringify({ status: draft.status }),
        });
      }
      if (
        canEditVersion &&
        (draft.subject !== (automation.subject || "") ||
          draft.previewText !== (automation.preview_text || ""))
      ) {
        const d = await adminFetch(`/admin/email-templates/versions/${automation.active_version_id}`, {
          method: "PUT",
          body: JSON.stringify({
            subject: draft.subject,
            previewText: draft.previewText,
          }),
        });
        const version = d.version || {};
        setEvents((prev) => updateEmailRows(prev, automation.automation_key, (row) => ({
          ...row,
          subject: version.subject ?? draft.subject,
          preview_text: version.preview_text ?? draft.previewText,
          version_status: version.status || row.version_status,
        })));
      }
      setToast(`${automation.template_name || automation.template_key} saved`);
    } catch (e) {
      setEvents((prev) => updateEmailRows(prev, automation.automation_key, () => automation));
      setEmailDrafts((prev) => ({
        ...prev,
        [automation.automation_key]: emailDraftFrom(automation),
      }));
      setToast(`Email save failed: ${e.message}`);
    } finally {
      markPending(key, false);
    }
  };

  if (loading) {
    return <div className="p-10 text-center text-13 text-ink-secondary">Loading notification events...</div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-13 text-ink-secondary">
            <span className="font-mono u-nums text-ink-primary">{regularEvents.length}</span>{" "}
            notification events
          </div>
          <div className="text-11 text-ink-tertiary">
            Catalog entries: {catalog.length}
          </div>
        </div>
        <Button variant="secondary" size="sm" className="gap-2" onClick={loadEvents}>
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>

      {toast ? <div className="text-12 text-ink-secondary">{toast}</div> : null}

      <div className="space-y-5">
        {regularEvents.map((event) => (
          <EventSection
            key={event.event_key}
            event={event}
            smsDrafts={smsDrafts}
            emailDrafts={emailDrafts}
            pending={pending}
            onSmsDraft={(id, next) => setSmsDrafts((prev) => ({ ...prev, [id]: next }))}
            onEmailDraft={(automationKey, next) =>
              setEmailDrafts((prev) => ({ ...prev, [automationKey]: next }))
            }
            onSmsSave={saveSms}
            onEmailSave={saveEmail}
          />
        ))}
      </div>

      <div className={cn("space-y-3", regularEvents.length && "pt-2")}>
        {smsOnlyEvent ? (
          <SmsOnlyBucket
            event={smsOnlyEvent}
            smsDrafts={smsDrafts}
            pending={pending}
            onSmsDraft={(id, next) => setSmsDrafts((prev) => ({ ...prev, [id]: next }))}
            onSmsSave={saveSms}
            onSmsDelete={deleteSms}
          />
        ) : null}
        {emailOnlyEvent ? <EmailOnlyBucket event={emailOnlyEvent} /> : null}
      </div>
    </div>
  );
}
