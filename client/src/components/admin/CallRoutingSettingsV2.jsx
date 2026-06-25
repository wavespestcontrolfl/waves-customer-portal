// client/src/components/admin/CallRoutingSettingsV2.jsx
// Communications → Call Routing tab. Controls the bilingual AI voice backstop.
//   GET  /admin/settings/call-routing         { config, defaults, gateEnabled }
//   GET  /admin/settings/call-routing/status   live "what a call does right now"
//   PUT  /admin/settings/call-routing          { config }
//   POST /admin/settings/call-routing/reset
//
// The env gate (GATE_VOICE_AI_AGENT) is the hard master switch and is shown
// read-only here — these toggles only tune behavior WHEN the gate is on.
import { useState, useEffect } from "react";
import { Badge, Button, Card, CardBody, Input, Switch, cn } from "../../components/ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...options,
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

const DAYS = [
  { i: 0, label: "Su" }, { i: 1, label: "Mo" }, { i: 2, label: "Tu" },
  { i: 3, label: "We" }, { i: 4, label: "Th" }, { i: 5, label: "Fr" }, { i: 6, label: "Sa" },
];

const MODE_LABEL = {
  disabled: "Disabled — every call routes normally (no AI).",
  no_endpoint: "No agent endpoint set — calls route normally until you add one.",
  answers_first: "AI answers first right now.",
  backstop_on_no_answer: "AI backstops unanswered calls (humans ring first).",
  normal_only: "AI off — backstop disabled; calls go to voicemail on no-answer.",
};

export default function CallRoutingSettingsV2() {
  const [config, setConfig] = useState(null);
  const [gateEnabled, setGateEnabled] = useState(false);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  const loadStatus = () =>
    adminFetch("/admin/settings/call-routing/status").then(setStatus).catch(() => setStatus(null));

  useEffect(() => {
    adminFetch("/admin/settings/call-routing")
      .then((r) => {
        setConfig(r.config);
        setGateEnabled(!!r.gateEnabled);
      })
      .catch(() => setConfig(null))
      .finally(() => setLoading(false));
    loadStatus();
  }, []);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  const setField = (key, value) => setConfig((c) => ({ ...c, [key]: value }));
  const setSched = (field, value) =>
    setConfig((c) => ({ ...c, answerFirstSchedule: { ...c.answerFirstSchedule, [field]: value } }));
  const toggleDay = (i) =>
    setConfig((c) => {
      const days = new Set(c.answerFirstSchedule?.openDays || []);
      days.has(i) ? days.delete(i) : days.add(i);
      return { ...c, answerFirstSchedule: { ...c.answerFirstSchedule, openDays: [...days].sort() } };
    });

  const save = async () => {
    setSaving(true);
    try {
      const r = await adminFetch("/admin/settings/call-routing", {
        method: "PUT",
        body: JSON.stringify({ config }),
      });
      setConfig(r.config);
      await loadStatus();
      showToast("Call routing saved");
    } catch (e) {
      alert("Save failed: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!window.confirm("Reset call routing to defaults?")) return;
    setSaving(true);
    try {
      const r = await adminFetch("/admin/settings/call-routing/reset", { method: "POST" });
      setConfig(r.config);
      await loadStatus();
      showToast("Reset to defaults");
    } catch (e) {
      alert("Reset failed: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Card><CardBody><div className="text-13 text-ink-tertiary">Loading…</div></CardBody></Card>;
  if (!config) return <Card><CardBody><div className="text-13 text-alert-fg">Couldn't load call routing settings.</div></CardBody></Card>;

  const sched = config.answerFirstSchedule || { enabled: false, startHourET: 18, endHourET: 8, openDays: [] };

  return (
    <Card id="call_routing">
      <CardBody>
        {/* Header */}
        <div className="flex justify-between items-start mb-4 gap-3 flex-wrap">
          <div>
            <div className="text-16 font-medium text-ink-primary">Call Routing</div>
            <div className="text-12 text-ink-tertiary mt-1">
              Bilingual AI voice agent that answers unanswered inbound calls (Spanish auto-detected) instead of voicemail.
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={reset} disabled={saving}>Reset</Button>
            <Button variant="primary" size="sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </div>

        {/* Master gate + live mode */}
        <div className="p-3 mb-4 bg-zinc-50 border-hairline rounded-md flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-13 font-medium text-ink-primary">AI voice agent</span>
              <Badge tone={gateEnabled ? "strong" : "neutral"}>{gateEnabled ? "ON" : "OFF"}</Badge>
            </div>
            <div className="text-12 text-ink-tertiary mt-1">
              Master switch is env-controlled (<code>GATE_VOICE_AI_AGENT</code>). {status ? MODE_LABEL[status.effectiveMode] : ""}
            </div>
          </div>
        </div>

        {/* Settings */}
        <div className="bg-white border-hairline rounded-md divide-y divide-zinc-200">
          {/* Agent endpoint */}
          <Row label="Agent endpoint" hint="Phone number (+1…) or SIP URI the AI agent answers on. Required — without it, calls always route normally.">
            <Input
              type="text"
              value={config.agentEndpoint || ""}
              onChange={(e) => setField("agentEndpoint", e.target.value)}
              placeholder="+19415551234 or sip:agent@…"
              className="w-full md:w-72"
            />
          </Row>

          {/* Ring timeout slider */}
          <Row label="Ring staff before AI answers" hint="How long inbound calls ring your team before the AI backstops an unanswered call.">
            <div className="flex items-center gap-3">
              <input
                type="range" min={5} max={120} step={5}
                value={config.ringTimeoutSec}
                onChange={(e) => setField("ringTimeoutSec", Number(e.target.value))}
                className="w-40 accent-zinc-900"
              />
              <span className="text-13 text-ink-secondary tabular-nums w-14">{config.ringTimeoutSec}s</span>
            </div>
          </Row>

          {/* No-answer backstop */}
          <Row label="Backstop unanswered calls" hint="When no one answers in time, the AI picks up instead of dumb voicemail. (Recommended.)">
            <Switch checked={!!config.noAnswerBackstopEnabled} onChange={(v) => setField("noAnswerBackstopEnabled", v)} />
          </Row>

          {/* AI answers first */}
          <Row
            label="AI answers first (override)"
            hint="AI picks up immediately on EVERY call — the only mode where it fronts a call humans would take. Leave off for the safe ring-first flow."
          >
            <Switch checked={!!config.aiAnswersFirst} onChange={(v) => setField("aiAnswersFirst", v)} />
          </Row>

          {/* Nightly answers-first schedule */}
          <Row
            label="Nightly answers-first schedule"
            hint="Optionally have the AI answer first only inside an overnight window, so after-hours callers skip the ring. Off = pure ring-timeout."
          >
            <Switch checked={!!sched.enabled} onChange={(v) => setSched("enabled", v)} />
          </Row>

          {sched.enabled && (
            <div className="p-3 bg-zinc-50">
              <div className="flex items-center gap-2 flex-wrap mb-3">
                <span className="text-12 text-ink-tertiary">From</span>
                <Input type="number" min={0} max={23} value={sched.startHourET}
                  onChange={(e) => setSched("startHourET", Number(e.target.value))} className="w-16" />
                <span className="text-12 text-ink-tertiary">to</span>
                <Input type="number" min={0} max={24} value={sched.endHourET}
                  onChange={(e) => setSched("endHourET", Number(e.target.value))} className="w-16" />
                <span className="text-12 text-ink-tertiary">ET (overnight wrap supported, e.g. 18 → 8)</span>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-12 text-ink-tertiary mr-1">Days{ (sched.openDays || []).length === 0 ? " (all)" : "" }:</span>
                {DAYS.map((d) => {
                  const on = (sched.openDays || []).includes(d.i);
                  return (
                    <button key={d.i} type="button" onClick={() => toggleDay(d.i)}
                      className={cn(
                        "px-2 py-1 rounded-md text-12 border-hairline min-w-[34px]",
                        on ? "bg-zinc-900 text-white" : "bg-white text-ink-secondary",
                      )}>
                      {d.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Agent connect timeout */}
          <Row label="Agent answer timeout" hint="If the AI doesn't pick up within this many seconds, the caller drops to voicemail. Keep short so a dead agent fails fast.">
            <div className="flex items-center gap-2">
              <Input type="number" min={5} max={30} value={config.agentTimeoutSec}
                onChange={(e) => setField("agentTimeoutSec", Number(e.target.value))} className="w-16" />
              <span className="text-13 text-ink-tertiary">s</span>
            </div>
          </Row>
        </div>

        {toast && (
          <div className="fixed bottom-6 right-6 px-4 py-2.5 bg-zinc-900 text-white rounded-md text-13 font-medium shadow-lg z-[300]">
            {toast}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function Row({ label, hint, children }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2 md:gap-4 p-3 items-center">
      <div>
        <div className="text-13 text-ink-primary">{label}</div>
        {hint && <div className="text-12 text-ink-tertiary mt-0.5 leading-relaxed">{hint}</div>}
      </div>
      <div className="md:justify-self-end">{children}</div>
    </div>
  );
}
