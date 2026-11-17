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
