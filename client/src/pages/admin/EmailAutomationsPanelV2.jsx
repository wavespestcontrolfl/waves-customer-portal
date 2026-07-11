// client/src/pages/admin/EmailAutomationsPanelV2.jsx
// Automations v2 — in-house SendGrid-backed automation sequences.
// Endpoints:
//   GET    /admin/automations/templates
//   GET    /admin/automations/templates/:key
//   PUT    /admin/automations/templates/:key
//   POST   /admin/automations/templates/:key/steps
//   PUT    /admin/automations/steps/:id
//   DELETE /admin/automations/steps/:id
//   POST   /admin/automations/draft-ai
//   POST   /admin/automations/templates/:key/test
//   POST   /admin/automations/templates/:key/trigger
//   GET    /admin/automations/enrollments
//
// Audit focus:
// - draft-ai: Claude-backed step-content generator. Single-flight on
//   the operator's "draft" button; cost-cap guard (don't loop).
// - test vs trigger: /test sends to the operator's own email only;
//   /trigger fires the real sequence at customers. Confirm the UI
//   wiring can NEVER swap the two — a "test" button that secretly
//   hits /trigger is a fan-out incident.
// - DELETE step: must require explicit confirmation; deleting a
//   step in an active sequence is destructive and customers in flight
//   will skip it silently.
// - Enrollments view: GET /enrollments may surface PII (customer
//   email + sequence state). Confirm there's no public exposure
//   path and that the operator-only auth middleware fires.
// - SendGrid template variables: substitution happens server-side
//   from a JSON payload. Watch for any unescaped HTML rendering on
//   the preview side that could XSS the operator from a malformed
//   template body.
import { useState, useEffect, useCallback } from "react";
import { Badge, Button, Card, Switch, cn } from "../../components/ui";

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
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    return data;
  });
}

export default function EmailAutomationsPanelV2() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState(null);
  const [sendTemplate, setSendTemplate] = useState(null);
  const [toast, setToast] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    adminFetch("/admin/automations/templates")
      .then((d) => setTemplates(d.templates || []))
      .catch((e) => setToast("Load failed: " + e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const toggleEnabled = async (tpl) => {
    try {
      await adminFetch(`/admin/automations/templates/${tpl.key}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: !tpl.enabled }),
      });
      load();
    } catch (e) {
      setToast("Toggle failed: " + e.message);
    }
  };

  return (
    <div className="space-y-4">
      {" "}
      <div className="flex items-center justify-between">
        {" "}
        <div>
          {" "}
          <h2 className="text-18 font-medium text-zinc-900">
            Automations
          </h2>{" "}
          <p className="text-12 text-ink-secondary mt-0.5">
            Transactional email sequences sent via SendGrid. Each template has
            one or more steps; the runner ticks every minute and fires steps per
            their delay. Unsubscribe / bounce / spam events cancel active
            enrollments automatically.
          </p>{" "}
        </div>
        {toast && <span className="text-11 text-ink-secondary">{toast}</span>}
      </div>
      {loading ? (
        <div className="text-13 text-ink-secondary p-6 text-center">
          Loading…
        </div>
      ) : (
        <Card className="p-0 overflow-hidden">
          {" "}
          <table className="w-full text-13">
            {" "}
            <thead className="bg-zinc-50 border-b border-hairline border-zinc-200">
              {" "}
              <tr>
                {" "}
                <th className="px-4 py-2 text-left text-11 uppercase tracking-label text-ink-tertiary font-medium">
                  Name
                </th>{" "}
                <th className="px-4 py-2 text-left text-11 uppercase tracking-label text-ink-tertiary font-medium">
                  Group
                </th>{" "}
                <th className="px-4 py-2 text-left text-11 uppercase tracking-label text-ink-tertiary font-medium">
                  Steps
                </th>{" "}
                <th className="px-4 py-2 text-left text-11 uppercase tracking-label text-ink-tertiary font-medium">
                  Active
                </th>{" "}
                <th className="px-4 py-2 text-left text-11 uppercase tracking-label text-ink-tertiary font-medium">
                  Enabled
                </th>{" "}
                <th className="px-4 py-2"></th>{" "}
              </tr>{" "}
            </thead>{" "}
            <tbody>
              {templates.map((t) => {
                const activeCount = t.enrollment_counts?.active || 0;
                return (
                  <tr
                    key={t.key}
                    className="border-b border-hairline border-zinc-100 last:border-b-0 hover:bg-zinc-50/50"
                  >
                    {" "}
                    <td className="px-4 py-3">
                      {" "}
                      <div className="text-14 font-medium text-zinc-900">
                        {t.name}
                      </div>{" "}
                      <div className="text-11 text-ink-tertiary">
                        {t.description}
                      </div>{" "}
                    </td>{" "}
                    <td className="px-4 py-3">
                      {" "}
                      <Badge
                        tone={
                          t.asm_group === "newsletter" ? "muted" : "neutral"
                        }
                      >
                        {t.asm_group}
                      </Badge>{" "}
                    </td>{" "}
                    <td className="px-4 py-3">
                      {" "}
                      <span className="u-nums text-zinc-900 mr-2">
                        {t.step_count}
                      </span>
                      {t.step_count === 0 && (
                        <Badge tone="alert">No steps — won't send</Badge>
                      )}
                    </td>{" "}
                    <td className="px-4 py-3 u-nums text-ink-secondary">
                      {activeCount}
                    </td>{" "}
                    <td className="px-4 py-3">
                      {" "}
                      <Switch
                        checked={!!t.enabled}
                        onChange={() => toggleEnabled(t)}
                      />{" "}
                    </td>{" "}
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {" "}
                      <Button
                        variant="secondary"
                        className="mr-2"
                        disabled={!t.enabled || !t.has_local_content}
                        title={
                          !t.enabled
                            ? "Enable this automation first"
                            : !t.has_local_content
                              ? "No enabled step has content yet — there is nothing to send"
                              : undefined
                        }
                        onClick={() => setSendTemplate(t)}
                      >
                        Send
                      </Button>{" "}
                      <Button
                        variant="secondary"
                        onClick={() => setSelectedKey(t.key)}
                      >
                        Edit steps
                      </Button>{" "}
                    </td>{" "}
                  </tr>
                );
              })}
            </tbody>{" "}
          </table>{" "}
        </Card>
      )}
      {selectedKey && (
        <TemplateEditorModal
          templateKey={selectedKey}
          onClose={() => setSelectedKey(null)}
          onSaved={load}
        />
      )}
      {sendTemplate && (
        <SendAutomationModal
          template={sendTemplate}
          onClose={() => setSendTemplate(null)}
          onSent={load}
        />
      )}
    </div>
  );
}

// ── Manual send modal — search a customer by name, enroll them in this
//    automation's sequence. The server responds with exactly what happened
//    (enrolled / no email / already enrolled / disabled / no steps).
function SendAutomationModal({ template, onClose, onSent }) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (selected) return undefined;
    const q = search.trim();
    if (q.length < 2) {
      // Clearing back below 2 chars cancels any in-flight debounce; reset the
      // spinner too, or it stays stuck on "Searching…" with an empty input.
      setResults([]);
      setSearching(false);
      return undefined;
    }
    let cancelled = false;
    // Drop results from the previous query so a stale row can't be clicked
    // and enrolled under the new search text during the debounce window.
    setResults([]);
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const data = await adminFetch(
          `/admin/customers?search=${encodeURIComponent(q)}&limit=8`,
        );
        if (!cancelled) setResults(data?.customers || []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, selected]);

  // GET /admin/customers maps rows to camelCase (firstName/lastName); accept
  // snake_case too so a mapper change can't blank every result row.
  const customerName = (c) =>
    [c.firstName || c.first_name, c.lastName || c.last_name]
      .filter(Boolean)
      .join(" ") ||
    c.email ||
    "Unnamed customer";

  const send = async () => {
    if (!selected || sending) return;
    setSending(true);
    setResult(null);
    try {
      const data = await adminFetch(
        `/admin/automations/templates/${template.key}/trigger`,
        {
          method: "POST",
          body: JSON.stringify({ customerId: selected.id }),
        },
      );
      setResult({
        ok: !!data.enrolled,
        text: data.message || (data.enrolled ? "Enrolled." : "Not enrolled."),
      });
      if (data.enrolled) onSent?.();
    } catch (e) {
      setResult({ ok: false, text: "Send failed: " + e.message });
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto p-4"
      onClick={onClose}
    >
      {" "}
      <div
        className="bg-white border-hairline border-zinc-300 rounded-sm shadow-xl w-full max-w-lg my-8"
        onClick={(e) => e.stopPropagation()}
      >
        {" "}
        <div className="p-5 border-b border-hairline border-zinc-200 flex items-start justify-between gap-3">
          {" "}
          <div>
            {" "}
            <h3 className="text-16 font-medium text-zinc-900">
              Send "{template.name}"
            </h3>{" "}
            <p className="text-12 text-ink-secondary mt-0.5">
              Enrolls the customer in this sequence — step 1 sends on its
              configured delay. Customers need an email on file.
            </p>{" "}
          </div>{" "}
          <button
            type="button"
            onClick={onClose}
            className="text-ink-tertiary hover:text-zinc-900 text-14"
          >
            ×
          </button>{" "}
        </div>{" "}
        <div className="p-5 space-y-3">
          {selected ? (
            <div className="flex items-center justify-between border-hairline border-zinc-200 rounded-sm px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-14 font-medium text-zinc-900 truncate">
                  {customerName(selected)}
                </div>
                <div className="text-12 text-ink-secondary truncate">
                  {selected.email || "No email on file"}
                </div>
              </div>
              <Button
                variant="secondary"
                onClick={() => {
                  setSelected(null);
                  setResult(null);
                }}
              >
                Change
              </Button>
            </div>
          ) : (
            <>
              <input
                type="text"
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search customer by name…"
                className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900"
              />
              {searching && (
                <div className="text-12 text-ink-secondary">Searching…</div>
              )}
              {!searching &&
                search.trim().length >= 2 &&
                results.length === 0 && (
                  <div className="text-12 text-ink-secondary">
                    No customers found.
                  </div>
                )}
              {results.length > 0 && (
                <div className="border-hairline border-zinc-200 rounded-sm divide-y divide-zinc-100 max-h-60 overflow-y-auto">
                  {results.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setSelected(c);
                        setResults([]);
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-zinc-50"
                    >
                      <div className="text-13 font-medium text-zinc-900">
                        {customerName(c)}
                      </div>
                      <div className="text-12 text-ink-secondary">
                        {c.email || "No email"}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          {result && (
            <div
              className={cn(
                "text-12",
                result.ok ? "text-zinc-900" : "text-alert-fg",
              )}
            >
              {result.text}
            </div>
          )}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-hairline border-zinc-200">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button
              onClick={send}
              disabled={!selected || !selected.email || sending}
              title={
                selected && !selected.email
                  ? "This customer has no email on file"
                  : undefined
              }
            >
              {sending ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>{" "}
      </div>{" "}
    </div>
  );
}

// ── Template editor modal ──────────────────────────────────────────────

function TemplateEditorModal({ templateKey, onClose, onSaved }) {
  const [template, setTemplate] = useState(null);
  const [steps, setSteps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");
  const [testEmail, setTestEmail] = useState("contact@wavespestcontrol.com");
  const [testing, setTesting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    adminFetch(`/admin/automations/templates/${templateKey}`)
      .then((d) => {
        setTemplate(d.template);
        setSteps(d.steps || []);
      })
      .catch((e) => setToast("Load failed: " + e.message))
      .finally(() => setLoading(false));
  }, [templateKey]);
  useEffect(() => {
    load();
  }, [load]);

  const addStep = async () => {
    try {
      await adminFetch(`/admin/automations/templates/${templateKey}/steps`, {
        method: "POST",
        body: JSON.stringify({ delayHours: steps.length === 0 ? 0 : 24 }),
      });
      load();
      onSaved?.();
    } catch (e) {
      setToast("Add failed: " + e.message);
    }
  };

  const sendTest = async () => {
    if (!testEmail) return;
    setTesting(true);
    setToast("");
    try {
      const r = await adminFetch(
        `/admin/automations/templates/${templateKey}/test`,
        {
          method: "POST",
          body: JSON.stringify({ toEmail: testEmail }),
        },
      );
      const ok = r.results?.filter((x) => x.sent).length || 0;
      setToast(`Test sent — ${ok}/${r.results?.length || 0} step(s) delivered`);
    } catch (e) {
      setToast("Test failed: " + e.message);
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        onClick={onClose}
      >
        {" "}
        <div className="bg-white p-5 rounded-sm border-hairline border-zinc-300">
          Loading…
        </div>{" "}
      </div>
    );
  }
  if (!template) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto p-4"
      onClick={onClose}
    >
      {" "}
      <div
        className="bg-white border-hairline border-zinc-300 rounded-sm shadow-xl w-full max-w-4xl my-8"
        onClick={(e) => e.stopPropagation()}
      >
        {" "}
        <div className="p-5 border-b border-hairline border-zinc-200 flex items-start justify-between gap-3">
          {" "}
          <div className="flex-1">
            {" "}
            <h3 className="text-18 font-medium text-zinc-900">
              {template.name}
            </h3>{" "}
            <p className="text-12 text-ink-secondary mt-0.5">
              {template.description}
            </p>{" "}
            <div className="flex items-center gap-2 mt-2">
              {" "}
              <Badge
                tone={template.asm_group === "newsletter" ? "muted" : "neutral"}
              >
                {template.asm_group}
              </Badge>{" "}
              <Badge tone={template.enabled ? "strong" : "muted"}>
                {template.enabled ? "Enabled" : "Disabled"}
              </Badge>{" "}
              <span className="text-11 text-ink-tertiary">
                key: {template.key}
              </span>{" "}
            </div>{" "}
          </div>{" "}
          <button
            type="button"
            onClick={onClose}
            className="text-ink-tertiary hover:text-zinc-900 text-14"
          >
            ×
          </button>{" "}
        </div>{" "}
        <div className="p-5 space-y-4">
          {steps.length === 0 ? (
            <div className="text-13 text-alert-fg p-6 text-center border-hairline border-zinc-200 border-dashed rounded-sm">
              No steps yet. Add the first step to define what the email says.
              Until then, new enrollments on this template will not send any
              emails.
            </div>
          ) : (
            <div className="space-y-3">
              {steps.map((s, i) => (
                <StepEditor
                  key={s.id}
                  step={s}
                  stepIndex={i}
                  totalSteps={steps.length}
                  templateKey={template.key}
                  onSaved={load}
                  onDeleted={load}
                />
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 pt-2 border-t border-hairline border-zinc-200">
            {" "}
            <Button onClick={addStep} variant="secondary">
              + Add step
            </Button>{" "}
            <div className="ml-auto flex items-center gap-2">
              {" "}
              <input
                type="email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                className="bg-white border-hairline border-zinc-300 rounded-sm py-1.5 px-2 text-12 text-zinc-900 font-mono w-56"
                placeholder="test@wavespestcontrol.com"
              />{" "}
              <Button
                onClick={sendTest}
                variant="secondary"
                disabled={testing || steps.length === 0}
              >
                {testing ? "Sending…" : "Send test sequence"}
              </Button>{" "}
            </div>{" "}
          </div>
          {toast && <div className="text-12 text-ink-secondary">{toast}</div>}
        </div>{" "}
      </div>{" "}
    </div>
  );
}

// ── Step editor ───────────────────────────────────────────────────────

function StepEditor({
  step,
  stepIndex,
  totalSteps,
  templateKey,
  onSaved,
  onDeleted,
}) {
  const [delayHours, setDelayHours] = useState(step.delay_hours || 0);
  const [subject, setSubject] = useState(step.subject || "");
  const [previewText, setPreviewText] = useState(step.preview_text || "");
  const [htmlBody, setHtmlBody] = useState(step.html_body || "");
  const [textBody, setTextBody] = useState(step.text_body || "");
  const [enabled, setEnabled] = useState(!!step.enabled);
  const [saving, setSaving] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState("");

  const copyShareLink = async () => {
    if (!step.preview_token) return;
    const url = `${window.location.origin}/api/public/automation-preview/${step.id}/${step.preview_token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be unavailable (insecure context, etc.) — fall back
      // to a simple prompt so operator can copy manually.
      window.prompt("Copy this link:", url);
    }
  };

  const save = async () => {
    setSaving(true);
    setStatus("");
    try {
      await adminFetch(`/admin/automations/steps/${step.id}`, {
        method: "PUT",
        body: JSON.stringify({
          delayHours,
          subject,
          previewText,
          htmlBody,
          textBody,
          enabled,
        }),
      });
      setStatus("Saved.");
      onSaved?.();
    } catch (e) {
      setStatus("Save failed: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm("Delete this step?")) return;
    try {
      await adminFetch(`/admin/automations/steps/${step.id}`, {
        method: "DELETE",
      });
      onDeleted?.();
    } catch (e) {
      setStatus("Delete failed: " + e.message);
    }
  };

  const applyAiDraft = async ({ prompt, tone, includeCTA }) => {
    const r = await adminFetch("/admin/automations/draft-ai", {
      method: "POST",
      body: JSON.stringify({
        templateKey,
        stepGoal: prompt,
        stepIndex,
        totalSteps,
        tone,
        includeCTA,
      }),
    });
    const d = r.draft || {};
    if (d.subject) setSubject(d.subject);
    if (d.previewText) setPreviewText(d.previewText);
    if (d.htmlBody) setHtmlBody(d.htmlBody);
    if (d.textBody) setTextBody(d.textBody);
    setAiOpen(false);
    setStatus("AI draft inserted. Review and Save.");
  };

  return (
    <Card className="p-4">
      {" "}
      <div className="flex items-center justify-between mb-3">
        {" "}
        <div className="flex items-center gap-2">
          {" "}
          <span className="text-14 font-medium text-zinc-900">
            Step {stepIndex + 1}
          </span>{" "}
          <span className="text-11 text-ink-tertiary">
            {stepIndex === 0
              ? `Fires ${delayHours}h after enroll`
              : `Fires ${delayHours}h after step ${stepIndex}`}
          </span>{" "}
        </div>{" "}
        <div className="flex items-center gap-2">
          {" "}
          <Button
            onClick={() => setPreviewOpen(true)}
            variant="secondary"
            disabled={!htmlBody}
          >
            Preview
          </Button>{" "}
          <Button
            onClick={copyShareLink}
            variant="secondary"
            disabled={!step.preview_token || !htmlBody}
          >
            {copied ? "Link copied " : "Copy share link"}
          </Button>{" "}
          <Button onClick={() => setAiOpen(true)} variant="secondary">
            Draft with AI
          </Button>{" "}
          <button
            type="button"
            onClick={remove}
            className="text-11 px-2 py-1 border-hairline border-zinc-300 rounded-sm text-ink-secondary hover:text-alert-fg hover:border-alert-fg u-focus-ring"
          >
            Delete
          </button>{" "}
        </div>{" "}
      </div>{" "}
      <div className="grid grid-cols-3 gap-3 mb-3">
        {" "}
        <div>
          {" "}
          <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">
            Delay (hours)
          </label>{" "}
          <input
            type="number"
            min="0"
            value={delayHours}
            onChange={(e) => setDelayHours(Number(e.target.value))}
            className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-1.5 px-2 text-13 text-zinc-900 font-mono"
          />{" "}
        </div>{" "}
        <div className="col-span-2 flex items-end gap-2">
          {" "}
          <label className="inline-flex items-center gap-2 text-12 text-ink-secondary">
            {" "}
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Step enabled
          </label>
          {!enabled && <Badge tone="muted">Disabled — skipped</Badge>}
        </div>{" "}
      </div>{" "}
      <div className="mb-3">
        {" "}
        <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">
          Subject
        </label>{" "}
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-1.5 px-2 text-13 text-zinc-900"
          placeholder="Hi {{first_name}}, here's what to expect…"
        />{" "}
      </div>{" "}
      <div className="mb-3">
        {" "}
        <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">
          Preview text
        </label>{" "}
        <input
          type="text"
          value={previewText}
          onChange={(e) => setPreviewText(e.target.value)}
          className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-1.5 px-2 text-13 text-zinc-900"
        />{" "}
      </div>{" "}
      <div className="mb-3">
        {" "}
        <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">
          HTML body
        </label>{" "}
        <textarea
          value={htmlBody}
          onChange={(e) => setHtmlBody(e.target.value)}
          rows={10}
          className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900 font-mono"
          placeholder="<p>Hi {{first_name}}, welcome to Waves…</p>"
        />{" "}
        <p className="text-11 text-ink-tertiary mt-1">
          Use <code>{"{{first_name}}"}</code>/ <code>{"{{last_name}}"}</code>/{" "}
          <code>{"{{email}}"}</code>for personalization. SendGrid appends the
          unsub footer automatically based on the automation's ASM group.
        </p>{" "}
      </div>{" "}
      <div className="mb-3">
        {" "}
        <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">
          Plain-text fallback
        </label>{" "}
        <textarea
          value={textBody}
          onChange={(e) => setTextBody(e.target.value)}
          rows={3}
          className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900"
        />{" "}
      </div>{" "}
      <div className="flex items-center gap-2 pt-2 border-t border-hairline border-zinc-200">
        {" "}
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save step"}
        </Button>
        {status && <span className="text-12 text-ink-secondary">{status}</span>}
      </div>
      {aiOpen && (
        <AiDraftModal onClose={() => setAiOpen(false)} onDraft={applyAiDraft} />
      )}
      {previewOpen && (
        <StepPreviewModal
          subject={subject}
          previewText={previewText}
          htmlBody={htmlBody}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </Card>
  );
}

// ── Preview modal — renders step HTML in a sandboxed iframe with
//    {{placeholder}} values filled in so the operator sees what the
//    recipient would actually receive.
function StepPreviewModal({ subject, previewText, htmlBody, onClose }) {
  const sample = {
    first_name: "Friend",
    last_name: "Nguyen",
    email: "friend@example.com",
  };
  const fill = (s) =>
    (s || "")
      .replace(/\{\{\s*first_name\s*\}\}/g, sample.first_name)
      .replace(/\{\{\s*last_name\s*\}\}/g, sample.last_name)
      .replace(/\{\{\s*email\s*\}\}/g, sample.email)
      .replace(/\{first_name\}/g, sample.first_name)
      .replace(/\{last_name\}/g, sample.last_name);

  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;color:#18181b;max-width:640px;margin:24px auto;padding:0 20px;line-height:1.55;}
    h1,h2,h3{line-height:1.2;margin-top:1.2em;}
    h2{font-size:20px;}
    p{margin:0 0 14px;}
    ul,ol{margin:0 0 14px 20px;}
    a{color:#18181b;text-decoration:underline;}
  </style></head><body>${fill(htmlBody || "<p>(no body)</p>")}</body></html>`;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 overflow-y-auto p-4"
      onClick={onClose}
    >
      {" "}
      <div
        className="bg-white border-hairline border-zinc-300 rounded-sm shadow-xl w-full max-w-3xl my-8"
        onClick={(e) => e.stopPropagation()}
      >
        {" "}
        <div className="p-4 border-b border-hairline border-zinc-200 flex items-start justify-between gap-3">
          {" "}
          <div className="min-w-0">
            {" "}
            <div className="text-11 uppercase tracking-label text-ink-tertiary">
              Subject
            </div>{" "}
            <div className="text-14 text-zinc-900 truncate">
              {fill(subject) || (
                <span className="text-ink-tertiary">(no subject)</span>
              )}
            </div>
            {previewText && (
              <>
                {" "}
                <div className="text-11 uppercase tracking-label text-ink-tertiary mt-2">
                  Preview text
                </div>{" "}
                <div className="text-12 text-ink-secondary truncate">
                  {fill(previewText)}
                </div>{" "}
              </>
            )}
            <div className="text-11 text-ink-tertiary mt-2">
              Rendered with sample first name "Friend" — real sends use the
              subscriber's name.
            </div>{" "}
          </div>{" "}
          <button
            type="button"
            onClick={onClose}
            className="text-ink-tertiary hover:text-zinc-900 text-14"
          >
            ×
          </button>{" "}
        </div>{" "}
        <iframe
          srcDoc={doc}
          sandbox=""
          title="step preview"
          className="w-full"
          style={{ height: "60vh", border: "none", background: "#fff" }}
        />{" "}
      </div>{" "}
    </div>
  );
}

// ── AI draft modal (shared visual with newsletter modal) ───────────────

function AiDraftModal({ onClose, onDraft }) {
  const [prompt, setPrompt] = useState("");
  const [tone, setTone] = useState("Neighborly, owner-operator");
  const [includeCTA, setIncludeCTA] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const run = async () => {
    if (prompt.trim().length < 4) {
      setErr("Describe what this step should say (at least a few words)");
      return;
    }
    setLoading(true);
    setErr("");
    try {
      await onDraft({ prompt, tone, includeCTA });
    } catch (e) {
      setErr(e.message);
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      {" "}
      <div
        className="bg-white border-hairline border-zinc-300 rounded-sm shadow-xl w-full max-w-lg p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        {" "}
        <div className="flex items-center justify-between">
          {" "}
          <h3 className="text-16 font-medium text-zinc-900">
            Draft step with AI
          </h3>{" "}
          <button
            type="button"
            onClick={onClose}
            className="text-ink-tertiary hover:text-zinc-900 text-14"
          >
            ×
          </button>{" "}
        </div>{" "}
        <div>
          {" "}
          <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">
            What should this email say?
          </label>{" "}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900"
            placeholder="e.g. Welcome the customer, explain what happens on their first visit, set expectations about timing + weather delays."
          />{" "}
        </div>{" "}
        <div>
          {" "}
          <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">
            Tone
          </label>{" "}
          <input
            type="text"
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900"
          />{" "}
        </div>{" "}
        <label className="inline-flex items-center gap-2 text-12 text-ink-secondary">
          {" "}
          <input
            type="checkbox"
            checked={includeCTA}
            onChange={(e) => setIncludeCTA(e.target.checked)}
          />
          Include a call to action at the end
        </label>
        {err && <div className="text-12 text-alert-fg">{err}</div>}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-hairline border-zinc-200">
          {" "}
          <Button onClick={onClose} variant="secondary" disabled={loading}>
            Cancel
          </Button>{" "}
          <Button onClick={run} disabled={loading}>
            {loading ? "Drafting…" : "Draft it"}
          </Button>{" "}
        </div>{" "}
      </div>{" "}
    </div>
  );
}
