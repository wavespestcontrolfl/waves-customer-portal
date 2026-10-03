import React, { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge, Button, Card, Select as UiSelect } from "../../components/ui";

// Technician's-voice review texts (GATE_REVIEW_ASK_TECH_VOICE, build plan
// PR 3): what the writer drafted, the record lines behind each sentence,
// repeats it held, touches that fell back to the fixed text, and cadences the
// payment hold is holding. Read-only spot-check for the owner.

const API_BASE = import.meta.env.VITE_API_URL || "/api";

async function adminGet(path) {
  const r = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}` },
  });
  const text = await r.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(r.ok ? "Unexpected non-JSON response from server" : `HTTP ${r.status}`);
  }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

const DAY_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "14", label: "Last 14 days" },
  { value: "30", label: "Last 30 days" },
  { value: "60", label: "Last 60 days" },
];

// Why a touch fell back to the fixed text, in plain words.
const FALLBACK_REASONS = {
  provider_unavailable: "the writer could not be reached",
  fact_check_unavailable: "the fact check could not be reached",
  fact_check_bad_answer: "the fact check gave an unusable answer",
  repeat_check_unavailable: "the repeat check could not be reached",
  repeat_check_bad_answer: "the repeat check gave an unusable answer",
  out_of_time: "drafting ran out of time",
  unsupported_sentence: "a sentence was not backed by the record",
  timing_unsupported: "a time word was not backed by the record",
  off_limits_topic: "it touched an off-limits topic",
  draft_error: "drafting hit an error",
  no_draft: "no draft passed",
};

const HOLD_TEXT = {
  overdue_invoice: "overdue bill",
  payment_reminder_recent: "payment reminder in the last 3 days",
  payment_lookup_unavailable: "billing could not be read",
  cleared_after_window: "cleared after the 3-day window",
};

const fmtET = (value) =>
  value
    ? new Date(value).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

// The link placeholder the sender fills, shown as words.
const withLink = (text) => String(text || "").replace(/\{review_url\}/g, "[review link]");

const stepLabel = (step, channel) =>
  `${channel === "email" ? "Email" : "Text"} ${Number(step) + 1}`;

function outcomeBadge(d) {
  if (d.outcome === "drafted") return <Badge tone="strong">Drafted</Badge>;
  if (d.outcome === "held") return <Badge tone="warn">Held: repeat</Badge>;
  return <Badge tone="neutral">Fixed text</Badge>;
}

function DraftCard({ d }) {
  return (
    <Card className="p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-ui-body text-zinc-900">
        <span className="font-medium">{d.customerName || "Customer"}</span>
        <span className="text-zinc-500">
          {stepLabel(d.step, d.channel)}
          {d.technicianName ? ` · ${d.technicianName}` : ""}
          {d.serviceType ? ` · ${d.serviceType}` : ""}
          {d.serviceDate ? ` · visit ${d.serviceDate}` : ""}
        </span>
        {outcomeBadge(d)}
      </div>
      {d.body && (
        <p className="text-ui-body text-zinc-900 whitespace-pre-wrap border-l-2 border-zinc-300 pl-3">
          {withLink(d.body)}
        </p>
      )}
      {d.outcome === "fallback" && (
        <p className="text-ui-body text-zinc-700">
          The fixed text went out instead: {FALLBACK_REASONS[d.reason] || String(d.reason || "no reason recorded").replace(/_/g, " ")}.
        </p>
      )}
      {d.outcome === "held" && d.repeat && (
        <p className="text-ui-body text-zinc-700">
          Not sent: &ldquo;{withLink(d.repeat.sentence)}&rdquo; repeats text {Number(d.repeat.earlierStep) + 1}: &ldquo;{d.repeat.earlierQuote}&rdquo;
        </p>
      )}
      {d.sentences.length > 0 && (
        <ul className="space-y-1 text-ui-body text-zinc-700">
          {d.sentences.map((s, i) => (
            <li key={i}>
              <span className="text-zinc-900">{withLink(s.sentence)}</span>
              {" — "}
              {s.ask_only
                ? "the review request"
                : s.greeting_only
                  ? "a greeting"
                  : s.quotes.length
                    ? `from the record: ${s.quotes.map((q) => `"${q}"`).join(", ")}`
                    : "no record line"}
            </li>
          ))}
        </ul>
      )}
      <p className="text-ui-caption text-zinc-500">
        Drafted {fmtET(d.createdAt)}
        {d.outcome === "drafted" ? (d.sentAt ? ` · sent ${fmtET(d.sentAt)}` : " · not sent yet") : ""}
      </p>
    </Card>
  );
}

export default function ReviewDraftsPanel() {
  const [days, setDays] = useState("14");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const gen = useRef(0);
  const load = useCallback(() => {
    const mine = ++gen.current;
    setLoading(true);
    setError(null);
    return adminGet(`/admin/review-requests/tech-voice-drafts?days=${days}`)
      .then((d) => { if (mine === gen.current) setData(d); })
      .catch((e) => { if (mine === gen.current) setError(e.message); })
      .finally(() => { if (mine === gen.current) setLoading(false); });
  }, [days]);
  useEffect(() => { load(); }, [load]);

  const drafts = data?.drafts || [];
  const holds = data?.paymentHolds || [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-16 font-medium text-zinc-900 mr-auto">Tech-voice review texts</h2>
        <UiSelect
          value={days}
          onChange={(e) => setDays(e.target.value)}
          aria-label="Time window"
          className="w-auto bg-white border-hairline border-zinc-200 rounded-md text-zinc-900 text-ui-body cursor-pointer"
        >
          {DAY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </UiSelect>
        <Button variant="secondary" onClick={load} disabled={loading}>
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>
      {error && <p className="text-ui-body text-alert-fg">Could not load the texts: {error}</p>}
      {!error && !loading && drafts.length === 0 && holds.length === 0 && (
        <p className="text-ui-body text-zinc-600">
          Nothing in this window. Texts show here once the technician's-voice switch (GATE_REVIEW_ASK_TECH_VOICE) is on.
        </p>
      )}
      {holds.length > 0 && (
        <Card className="p-4 space-y-2">
          <h3 className="text-ui-label font-medium text-zinc-900">Held for payment</h3>
          <ul className="space-y-1 text-ui-body text-zinc-700">
            {holds.map((h) => (
              <li key={h.sequenceId}>
                <span className="text-zinc-900">{h.customerName || "Customer"}</span>
                {` · text ${Number(h.step) + 1} · `}
                {h.reason === "ask_dropped_payment_hold" ? "dropped after 3 days" : `waiting, next check ${fmtET(h.nextEvalAt)}`}
                {h.detail?.hold ? ` · ${HOLD_TEXT[h.detail.hold] || String(h.detail.hold).replace(/_/g, " ")}` : ""}
                {h.detail?.heldSince ? ` since ${fmtET(h.detail.heldSince)}` : ""}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {drafts.map((d) => <DraftCard key={d.id} d={d} />)}
    </div>
  );
}
