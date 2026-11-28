import React, { useEffect, useState } from "react";
import { Button, Card } from "../../components/ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const POLL_MS = 5000;
// Live text switched off: ask once a minute, so a switch-on shows here without a reload.
const IDLE_POLL_MS = 60000;
const SHOWN_LINES = 8;
const LABELS = { caller: "Caller", staff: "Agent" };
// How long a pressed Hold waits for the polls to show the hold before the button comes back.
const HOLD_WAIT_MS = 15000;

async function fetchLiveCalls(signal) {
  const response = await fetch(`${API_BASE}/admin/call-recordings/live`, {
    headers: { Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}` },
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  return { enabled: body?.enabled !== false, calls: Array.isArray(body?.calls) ? body.calls : [] };
}

async function postHold(callId) {
  const response = await fetch(`${API_BASE}/admin/call-recordings/live/${encodeURIComponent(callId)}/hold`, {
    method: "POST",
    headers: { Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}` },
  });
  return response.ok;
}

export function elapsedLabel(startedAt, now) {
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return "";
  const total = Math.max(0, Math.floor((now - started) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// Polls while the browser tab is visible, never overlaps two requests, and keeps the last good
// answer when a poll fails.
function useLiveCalls() {
  const [calls, setCalls] = useState([]);
  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let controller = null;
    let nextAt = 0;
    const visible = () => document.visibilityState !== "hidden";
    const poll = async () => {
      if (stopped || inFlight || !visible() || Date.now() < nextAt) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const next = await fetchLiveCalls(controller.signal);
        nextAt = next.enabled ? 0 : Date.now() + IDLE_POLL_MS;
        if (!stopped) setCalls(next.calls);
      } catch {
        /* keep the last good calls */
      } finally {
        inFlight = false;
      }
    };
    const onVisibility = () => { if (visible()) poll(); };
    document.addEventListener("visibilitychange", onVisibility);
    const timer = setInterval(poll, POLL_MS);
    poll();
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      controller?.abort();
    };
  }, []);
  return calls;
}

function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const ASSIST_ROWS = [
  ["intent", "Asking for"],
  ["price", "Price"],
  ["times", "Open times"],
];

// What the caller asks for, the engine's price and the next open times, from GET /live `assist` (null when the
// feature is off or nothing is known yet). A row with no text is left out.
function AssistRows({ assist }) {
  const rows = ASSIST_ROWS.filter(([key]) => assist?.[key]);
  if (!rows.length) return null;
  return (
    <ul className="mt-3 mb-0 list-none space-y-1 pl-0 text-14 text-zinc-900" data-testid="live-call-assist">
      {rows.map(([key, label]) => (
        <li key={key} className="flex gap-2">
          <span className="w-24 shrink-0 text-zinc-500">{label}</span>
          <span>{assist[key]}</span>
        </li>
      ))}
    </ul>
  );
}

// The Hold button (GATE_CALL_HOLD), from GET /live `hold` (null when the hold is off or the call is not on the
// conference ring). A press does what a star press does: the caller hears the hold script, the recording pauses, and
// the staff press 1 on the phone to go back. The next polls show the hold; a press that shows nothing within
// HOLD_WAIT_MS gives the button back.
function HoldControl({ call, now }) {
  const [pressedAt, setPressedAt] = useState(null);
  const [failed, setFailed] = useState(false);
  const hold = call.hold;
  const onHold = Boolean(hold?.on_hold);
  useEffect(() => { if (onHold) setPressedAt(null); }, [onHold]);
  if (onHold) {
    const time = hold.since ? ` ${elapsedLabel(hold.since, now)}` : "";
    return (
      <p className="mt-3 mb-0 text-14 text-zinc-900" data-testid="live-call-hold">
        {`On hold${time}. Press 1 on the phone to go back.`}
      </p>
    );
  }
  if (!hold?.can_hold) return null;
  const waiting = pressedAt !== null && now - pressedAt < HOLD_WAIT_MS;
  const press = async () => {
    setFailed(false);
    setPressedAt(Date.now());
    let ok = false;
    try {
      ok = await postHold(call.id);
    } catch {
      ok = false;
    }
    if (!ok) {
      setPressedAt(null);
      setFailed(true);
    }
  };
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3" data-testid="live-call-hold">
      <Button variant="secondary" size="sm" onClick={press} disabled={waiting}>
        {waiting ? "Putting on hold…" : "Hold"}
      </Button>
      {failed && <span className="text-14 text-zinc-600">The hold did not start. Press star on the phone.</span>}
    </div>
  );
}

function formatBriefStage(stage, tier) {
  const parts = [];
  if (stage) parts.push(String(stage).replace(/_/g, " "));
  if (tier) parts.push(`WaveGuard ${tier}`);
  return parts.join(" · ");
}

function formatCatalogPrice(item) {
  if (item.pricing_type === "variable") return `${item.name}: Variable (use engine)`;
  if (item.price == null) return item.name;
  const num = Number(item.price);
  if (!Number.isFinite(num)) return item.name;
  if (num === 0) return `${item.name}: Free`;
  const amount = Number.isInteger(num) ? num.toFixed(0) : num.toFixed(2);
  const unit = item.billing_type === "recurring" ? "/visit" : "";
  return `${item.name}: $${amount}${unit}`;
}

function formatTouchLabel(recent) {
  if (!recent || (!recent.calls && !recent.texts)) return "";
  const callWord = recent.calls === 1 ? "call" : "calls";
  const textWord = recent.texts === 1 ? "text" : "texts";
  return `48h: ${recent.calls} ${callWord}, ${recent.texts} ${textWord}`;
}

function CallerBriefBlock({ brief }) {
  if (!brief) return null;
  const stageLabel = formatBriefStage(brief.stage, brief.tier);
  const touchLabel = formatTouchLabel(brief.recent_48h);
  const estimates = Array.isArray(brief.open_estimates) ? brief.open_estimates : [];
  const notes = Array.isArray(brief.property_notes) ? brief.property_notes : [];
  return (
    <div className="space-y-1" data-testid="live-call-caller-brief">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {stageLabel && <span className="font-medium capitalize text-zinc-900">{stageLabel}</span>}
        {brief.address && <span className="text-zinc-700">{brief.address}</span>}
        {brief.lawn_sqft && <span className="text-zinc-500">{`${brief.lawn_sqft.toLocaleString()} sq ft lawn`}</span>}
        {brief.lot_sqft && <span className="text-zinc-500">{`${brief.lot_sqft.toLocaleString()} sq ft lot`}</span>}
        {touchLabel && <span className="text-zinc-500">{touchLabel}</span>}
      </div>
      {brief.next_visit && (
        <div className="text-zinc-700">
          {`Next visit: ${brief.next_visit.date || ""} ${brief.next_visit.service || ""}${brief.next_visit.window ? ` (${brief.next_visit.window})` : ""}`.trim()}
        </div>
      )}
      {estimates.length > 0 && (
        <div className="text-zinc-700">
          {`Open estimate: ${estimates.map((e) => `${e.service}${e.amount ? ` ($${e.amount})` : ""} [${e.status}]`).join(" · ")}`}
        </div>
      )}
      {notes.length > 0 && <div className="text-zinc-600">{notes.join(" · ")}</div>}
    </div>
  );
}

// Co-Pilot 2.0 (free /live-only path): instant Caller Brief, full-catalog matching prices,
// 2 tightest open route slots, and 7-item missing-info checklist. Uses div (not ul/li)
// so transcript list semantics remain cleanly isolated.
function CopilotSection({ copilot, hasAssistTimes }) {
  if (!copilot) return null;
  const prices = Array.isArray(copilot.catalog_prices) ? copilot.catalog_prices : [];
  const slots = !hasAssistTimes && Array.isArray(copilot.route_slots) ? copilot.route_slots : [];
  const checklist = Array.isArray(copilot.checklist) ? copilot.checklist : [];
  if (!copilot.brief && !prices.length && !slots.length && !checklist.length) return null;

  return (
    <div className="mt-3 space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-13 text-zinc-900" data-testid="live-call-copilot">
      <CallerBriefBlock brief={copilot.brief} />
      {prices.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="live-call-catalog-prices">
          <span className="text-zinc-500 mr-1">Catalog:</span>
          {prices.map((item, idx) => (
            <span key={`${item.name}-${idx}`} className="rounded bg-white px-2 py-0.5 border border-zinc-200 font-medium text-zinc-800">
              {formatCatalogPrice(item)}
            </span>
          ))}
        </div>
      )}
      {slots.length > 0 && (
        <div className="text-zinc-800" data-testid="live-call-route-slots">
          <span className="text-zinc-500 mr-2">Best route slots:</span>
          <span>{slots.join(" · ")}</span>
        </div>
      )}
      {checklist.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1" data-testid="live-call-checklist">
          {checklist.map((item) => (
            <span
              key={item.key}
              data-status={item.ok ? "ok" : "missing"}
              className={item.ok
                ? "rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-12 text-emerald-800"
                : "rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-12 text-amber-800"}
            >
              {`${item.ok ? "✓" : "○"} ${item.label}`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Tailwind preflight is off in this app, so the links and the list set their own color, margin and padding.
export default function LiveCallPanelV2() {
  const calls = useLiveCalls();
  const now = useNow(calls.length > 0);
  if (!calls.length) return null;
  return (
    <div className="space-y-3 px-4 pt-4" data-testid="live-call-panel">
      {calls.map((call) => (
        <Card key={call.id} className="p-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-14 text-zinc-900">
            {call.customer && (
              <a
                className="font-medium text-zinc-900 underline"
                href={`/admin/customers?customerId=${encodeURIComponent(call.customer.id)}`}
              >
                {call.customer.name}
              </a>
            )}
            <a
              className={call.customer ? "text-zinc-600 underline hover:text-zinc-900" : "font-medium text-zinc-900 underline"}
              href={`#tab=calls&call=${encodeURIComponent(call.id)}`}
            >
              {call.caller_phone || "Unknown"}
            </a>
            {call.answered_by && <span className="text-zinc-600">Answered by {call.answered_by}</span>}
            <span className="text-zinc-600 tabular-nums ml-auto">{elapsedLabel(call.started_at, now)}</span>
          </div>
          <HoldControl call={call} now={now} />
          <CopilotSection copilot={call.copilot} hasAssistTimes={Boolean(call.assist?.times)} />
          <AssistRows assist={call.assist} />
          <ul className="mt-3 mb-0 list-none space-y-1 pl-0 text-14 text-zinc-900">
            {(call.lines || []).slice(-SHOWN_LINES).map((line, i) => (
              <li key={`${line.at}-${i}`} className="flex gap-2">
                <span className="w-14 shrink-0 text-zinc-500">{LABELS[line.speaker] || LABELS.caller}</span>
                <span>{line.text}</span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
