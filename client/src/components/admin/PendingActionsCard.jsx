/**
 * PendingActionsCard — operator confirmation for Intelligence Bar writes
 * (issue #1568).
 *
 * Renders the pendingActions array from a /query response and posts the
 * operator's decision to /confirm-action or /cancel-action. The pending
 * action id is the confirmation credential: it lives ONLY in this
 * component's props/state. Never write it into conversationHistory, a
 * prompt, or anything else that reaches the model.
 *
 * variant="dark"  — D-palette inline styles (legacy IB surfaces)
 * variant="light" — Tailwind zinc (V2 IntelligenceBarShell)
 */
import { useEffect, useRef, useState } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

const D = {
  bg: "#0f1923", card: "#1e293b", border: "#334155",
  teal: "#0ea5e9", green: "#10b981", amber: "#f59e0b",
  red: "#ef4444",
  text: "#e2e8f0", muted: "#94a3b8", white: "#fff",
};

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  });
}

function paramLines(params) {
  return Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
}

// W0B authorization contract presentation. Tier mirrors the write-gate
// taxonomy (yellow = one Confirm, red = owner + exact-effect). Kinds group
// the effect lines; colors are deliberately restrained — red is reserved
// for the red tier and irreversible/contact flags, never decoration.
const TIER_LABEL = { yellow: "Confirm to run", red: "Owner confirm — exact effects", green: "Read" };
const KIND_LABEL = { operational: "Operations", customer: "Customer record", billing: "Billing", comms: "Messages" };
const KIND_ORDER = ["comms", "billing", "customer", "operational"];
const RECEIPT_STATES = { completed: 'confirmed', partially_completed: 'partial', provider_accepted: 'accepted',
  failed: 'failed', blocked: 'failed', canceled: 'cancelled', expired: 'failed', awaiting_approval: undefined, outcome_unknown: 'unknown' };

function receiptState(receipt) {
  const outcome = receipt.outcome || (receipt.success === true ? 'completed' : receipt.success === false ? 'failed' : 'outcome_unknown');
  return Object.hasOwn(RECEIPT_STATES, outcome) ? RECEIPT_STATES[outcome] : 'unknown';
}

function groupEffects(effects) {
  const groups = new Map();
  for (const e of effects || []) {
    if (!groups.has(e.kind)) groups.set(e.kind, []);
    groups.get(e.kind).push(e);
  }
  return KIND_ORDER.filter((k) => groups.has(k)).map((k) => [k, groups.get(k)]);
}

function ContractView({ contract, dark, showApproval = true }) {
  if (!contract) return null;
  const red = contract.tier === "red";
  const tierStyle = dark
    ? {
        display: "inline-block", padding: "2px 8px", borderRadius: 6, fontSize: 14, fontWeight: 600,
        background: red ? `${D.red}22` : `${D.amber}22`, color: red ? D.red : D.amber,
        border: `1px solid ${red ? D.red : D.amber}55`,
      }
    : undefined;
  const tierClass = dark
    ? undefined
    : `inline-block px-2 py-0.5 rounded-sm text-[14px] font-medium border ${
        red ? "border-alert-fg text-alert-fg" : "border-zinc-400 text-zinc-700"
      }`;
  return (
    <div style={dark ? { marginBottom: 10 } : undefined} className={dark ? undefined : "mb-2.5"}>
      {showApproval && <div style={dark ? { display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" } : undefined}
        className={dark ? undefined : "flex items-center gap-2 mb-1.5 flex-wrap"}>
        <span style={tierStyle} className={tierClass}>{TIER_LABEL[contract.tier] || contract.tier}</span>
        {contract.irreversible && (
          <span style={dark ? { fontSize: 14, color: D.red, fontWeight: 500 } : undefined}
            className={dark ? undefined : "text-[14px] text-alert-fg font-medium"}>
            Cannot be undone
          </span>
        )}
        {contract.notifies_customer && (
          <span style={dark ? { fontSize: 14, color: D.amber, fontWeight: 500 } : undefined}
            className={dark ? undefined : "text-[14px] text-zinc-700 font-medium"}>
            Contacts the customer
          </span>
        )}
      </div>}
      {groupEffects(contract.effects).map(([kind, items]) => (
        <div key={kind} style={dark ? { marginBottom: 6 } : undefined} className={dark ? undefined : "mb-1.5"}>
          <div style={dark ? { fontSize: 14, color: D.muted, textTransform: "uppercase", letterSpacing: "0.04em" } : undefined}
            className={dark ? undefined : "text-[14px] text-zinc-500 uppercase tracking-wide"}>
            {KIND_LABEL[kind] || kind}
          </div>
          {items.map((e, i) => (
            <div key={`${kind}-${i}`} style={dark ? { fontSize: 14, color: D.text, wordBreak: "break-word" } : undefined}
              className={dark ? undefined : "text-[14px] text-zinc-800 break-words"}>
              • {e.label}
            </div>
          ))}
        </div>
      ))}
      {Array.isArray(contract.more_effects) && contract.more_effects.length > 0 && (
        // Complete text of every capped/overflow line — nothing the operator
        // approves is hidden; the summary above is just the short form.
        <details style={dark ? { marginTop: 4 } : undefined} className={dark ? undefined : "mt-1"}>
          <summary style={dark ? { fontSize: 14, color: D.teal, cursor: "pointer" } : undefined}
            className={dark ? undefined : "text-[14px] text-zinc-700 cursor-pointer underline"}>
            Show more ({contract.more_effects.length} full detail{contract.more_effects.length > 1 ? "s" : ""})
          </summary>
          {contract.more_effects.map((e, i) => (
            <div key={`more-${i}`} style={dark ? { fontSize: 14, color: D.text, wordBreak: "break-word", marginTop: 4 } : undefined}
              className={dark ? undefined : "text-[14px] text-zinc-800 break-words mt-1"}>
              • {e.label}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

export default function PendingActionsCard({ actions, variant = "dark", onResolved, touchFriendly = false }) {
  // status per action id: undefined | 'confirming' | 'confirmed' | 'cancelling' | 'cancelled' | 'failed'
  const [statusById, setStatusById] = useState({});
  const [errorById, setErrorById] = useState({});
  const inFlightRef = useRef(new Set());

  // Preserve existing card outcomes and expiry across clarification turns. Countdown
  // deadlines anchor on RECEIPT TIME + the server-computed expiresInMs, so a
  // skewed device clock can't stale the card early or keep Confirm alive
  // past the server's TTL; raw expiresAt is only the fallback for older
  // server responses that don't send the duration.
  const [deadlineById, setDeadlineById] = useState({});
  useEffect(() => {
    const received = Date.now();
    setDeadlineById((previous) => {
      const deadlines = { ...previous };
      for (const a of actions || []) {
        if (deadlines[a.id] !== undefined) continue;
        if (typeof a.expiresInMs === "number") {
          deadlines[a.id] = (a.receivedAt ?? received) + a.expiresInMs;
        } else if (a.expiresAt) {
          const at = new Date(a.expiresAt).getTime();
          if (Number.isFinite(at)) deadlines[a.id] = at;
        }
      }
      return deadlines;
    });
  }, [actions]);

  // Tick for the expiry countdown — the server enforces the 10-minute TTL
  // on the claim, so an un-refreshed card must go visibly stale instead of
  // offering a Confirm that can only 409.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!actions || actions.length === 0) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [actions]);

  if (!actions || actions.length === 0) return null;

  const msLeft = (action) => (
    deadlineById[action.id] != null ? deadlineById[action.id] - now : null
  );
  const countdownLabel = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `Expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const setStatus = (id, status, error) => {
    setStatusById((prev) => ({ ...prev, [id]: status }));
    setErrorById((prev) => ({ ...prev, [id]: error || null }));
  };

  const showReceipt = (action, body) => {
    const state = receiptState(body);
    const message = body.warning || body.result?.warning || body.result?.error || body.result?.message
      || (state === "unknown" ? "The outcome is not established. Check status before taking further action."
        : state === "failed" ? "The action could not be completed" : null);
    setStatus(action.id, state, message);
    return state;
  };

  const checkStatus = async (action) => {
    try {
      const receipt = await adminFetch(`/admin/intelligence-bar/actions/${encodeURIComponent(action.id)}`);
      showReceipt(action, receipt);
      onResolved?.(action, "status", receipt);
    } catch {
      setStatus(action.id, "unknown", "Status is unavailable. This does not mean the action was canceled or failed.");
    }
  };

  const decide = async (action, decision) => {
    if (inFlightRef.current.has(action.id)) return;
    inFlightRef.current.add(action.id);
    const inFlight = decision === "confirm" ? "confirming" : "cancelling";
    const done = decision === "confirm" ? "confirmed" : "cancelled";
    setStatus(action.id, inFlight);
    try {
      const path = decision === "confirm" ? "/admin/intelligence-bar/confirm-action" : "/admin/intelligence-bar/cancel-action";
      // Exact-effect confirm (W0B): echo the contract hash this card rendered
      // so the server can only commit the effect set the operator saw.
      const body = await adminFetch(path, {
        method: "POST",
        body: JSON.stringify({
          pending_action_id: action.id,
          ...(decision === "confirm" && action.contract_hash ? { contract_hash: action.contract_hash } : {}),
        }),
      });
      if (decision === "confirm") showReceipt(action, body);
      else if (body.cancelled === true) setStatus(action.id, done);
      else await checkStatus(action);
      if (onResolved) onResolved(action, decision, body);
    } catch {
      // A dropped response can follow a successful commit. Read the durable
      // receipt; never resubmit a send/order/payment on a network error.
      await checkStatus(action);
    } finally {
      inFlightRef.current.delete(action.id);
    }
  };

  const dark = variant === "dark";

  const statusLabel = {
    confirming: "Confirming…",
    cancelling: "Cancelling…",
    confirmed: "✓ Done",
    accepted: "Accepted by provider",
    partial: "Partially completed",
    unknown: "Outcome unknown",
    cancelled: "Cancelled",
  };

  return (
    <div
      style={dark ? {
        margin: "10px 0 14px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      } : undefined}
      className={dark ? undefined : "mt-2 mb-3 flex flex-col gap-2"}
    >
      {actions.map((action) => {
        const status = statusById[action.id] || action.resolvedStatus || (action.receipt ? receiptState(action.receipt) : undefined);
        const receiptResult = action.receipt?.result;
        const detail = errorById[action.id] || action.resolvedWarning || receiptResult?.warning || receiptResult?.error || receiptResult?.message
          || (status === 'unknown' ? 'The outcome is not established. Check status before taking further action.' : null);
        const settled = ["confirmed", "cancelled", "failed", "accepted", "partial", "unknown"].includes(status);
        const busy = status === "confirming" || status === "cancelling";
        const remaining = msLeft(action);
        const expired = !settled && !busy && remaining !== null && remaining <= 0;

        return (
          <div
            key={action.id}
            style={dark ? {
              background: D.card,
              border: `1px solid ${status === "confirmed" ? D.green : status === "failed" ? D.red : D.amber}`,
              borderRadius: 10,
              padding: "12px 14px",
            } : undefined}
            className={dark ? undefined : `border rounded-sm px-3.5 py-3 bg-white ${
              status === "confirmed" ? "border-zinc-400" : status === "failed" ? "border-alert-fg" : "border-zinc-300"
            }`}
          >
            <div
              style={dark ? { color: D.text, fontSize: 14, fontWeight: 500, marginBottom: 6 } : undefined}
              className={dark ? undefined : "text-[14px] text-zinc-900 font-medium mb-1.5"}
            >
              {settled ? "Action result: " : "Awaiting your confirmation: "}{action.contract?.action_label || action.tool}
            </div>

            {settled ? <details style={{ marginBottom: 8, fontSize: 14 }}>
              <summary style={{ cursor: 'pointer', minHeight: 44, paddingTop: 8 }}>Action details</summary>
              <ContractView contract={action.contract} dark={dark} showApproval={false} />
            </details> : <ContractView contract={action.contract} dark={dark} />}

            {action.summary && !action.contract && (
              <div
                style={dark ? { fontSize: 14, color: D.text, marginBottom: 8, wordBreak: "break-word" } : undefined}
                className={dark ? undefined : "text-[14px] text-zinc-700 mb-2 break-words"}
              >
                {action.summary}
              </div>
            )}

            {/* With a contract, the effect list IS the param disclosure —
                the raw param lines stay only for legacy payloads. */}
            {!action.contract && (
            <div
              style={dark ? { fontSize: 14, color: D.muted, marginBottom: 10 } : undefined}
              className={dark ? undefined : "text-[14px] text-zinc-500 mb-2.5"}
            >
              {paramLines(action.params).map(([k, v]) => (
                <div key={k} style={dark ? { wordBreak: "break-word" } : undefined} className={dark ? undefined : "break-words"}>
                  <span style={dark ? { color: D.text } : undefined} className={dark ? undefined : "text-zinc-700"}>{k}:</span> {v}
                </div>
              ))}
            </div>
            )}

            {detail && (
              <div
                style={dark ? { fontSize: 14, color: D.red, marginBottom: 8 } : undefined}
                className={dark ? undefined : "text-[14px] text-alert-fg mb-2"}
              >
                {detail}
              </div>
            )}

            {status === "unknown" && (
              <button type="button" onClick={() => checkStatus(action)}
                style={dark ? { minHeight: 44, padding: "8px 12px", color: D.text, background: D.card, border: `1px solid ${D.border}`, borderRadius: 8 } : undefined}
                className={dark ? undefined : "min-h-11 px-3 py-2 border border-zinc-300 rounded-sm text-[14px]"}>
                Check status
              </button>
            )}

            {expired ? (
              <div
                style={dark ? { fontSize: 14, fontWeight: 500, color: D.amber } : undefined}
                className={dark ? undefined : "text-[14px] font-medium text-zinc-500"}
              >
                Expired — this proposal is no longer confirmable. Ask again to re-propose it.
              </div>
            ) : !settled ? (
              <div style={dark ? { display: "flex", flexDirection: "column", gap: 8 } : undefined} className={dark ? undefined : "flex flex-col gap-2"}>
                {remaining !== null && (
                  <div
                    style={dark ? { fontSize: 14, color: D.muted } : undefined}
                    className={dark ? undefined : "text-[14px] text-zinc-500"}
                  >
                    {countdownLabel(remaining)}
                  </div>
                )}
              <div style={dark ? { display: "flex", gap: 8 } : undefined} className={dark ? undefined : "flex gap-2"}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => decide(action, "confirm")}
                  style={dark ? {
                    background: D.green, color: D.white, border: "none", borderRadius: 8,
                    padding: "7px 16px", fontSize: 14, fontWeight: 500,
                    cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1,
                  } : undefined}
                  className={dark ? undefined : `bg-zinc-900 text-white rounded-sm px-4 py-1.5 text-[14px] font-medium disabled:opacity-60 ${touchFriendly ? "min-h-11" : ""}`}
                >
                  {status === "confirming" ? statusLabel.confirming : "Confirm"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => decide(action, "cancel")}
                  style={dark ? {
                    background: "transparent", color: D.muted, border: `1px solid ${D.border}`,
                    borderRadius: 8, padding: "7px 16px", fontSize: 14,
                    cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1,
                  } : undefined}
                  className={dark ? undefined : `bg-white text-zinc-600 border border-zinc-300 rounded-sm px-4 py-1.5 text-[14px] disabled:opacity-60 ${touchFriendly ? "min-h-11" : ""}`}
                >
                  {status === "cancelling" ? statusLabel.cancelling : "Cancel"}
                </button>
              </div>
              </div>
            ) : (
              <div
                style={dark ? {
                  fontSize: 14, fontWeight: 500,
                  color: status === "confirmed" ? D.green : status === "failed" ? D.red : D.muted,
                } : undefined}
                className={dark ? undefined : `text-[14px] font-medium ${
                  status === "confirmed" ? "text-zinc-900" : status === "failed" ? "text-alert-fg" : "text-zinc-500"
                }`}
              >
                {status === "failed" ? "Failed" : statusLabel[status]}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
