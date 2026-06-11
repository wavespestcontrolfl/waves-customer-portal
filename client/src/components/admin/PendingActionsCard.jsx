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
import { useEffect, useState } from "react";

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

export default function PendingActionsCard({ actions, variant = "dark", onResolved }) {
  // status per action id: undefined | 'confirming' | 'confirmed' | 'cancelling' | 'cancelled' | 'failed'
  const [statusById, setStatusById] = useState({});
  const [errorById, setErrorById] = useState({});

  // New proposals replace the previous batch's local state.
  useEffect(() => {
    setStatusById({});
    setErrorById({});
  }, [actions]);

  if (!actions || actions.length === 0) return null;

  const setStatus = (id, status, error) => {
    setStatusById((prev) => ({ ...prev, [id]: status }));
    setErrorById((prev) => ({ ...prev, [id]: error || null }));
  };

  const decide = async (action, decision) => {
    const inFlight = decision === "confirm" ? "confirming" : "cancelling";
    const done = decision === "confirm" ? "confirmed" : "cancelled";
    setStatus(action.id, inFlight);
    try {
      const path = decision === "confirm" ? "/admin/intelligence-bar/confirm-action" : "/admin/intelligence-bar/cancel-action";
      const body = await adminFetch(path, {
        method: "POST",
        body: JSON.stringify({ pending_action_id: action.id }),
      });
      if (decision === "confirm" && body.success === false) {
        setStatus(action.id, "failed", body.result?.error || "The action could not be completed");
      } else {
        setStatus(action.id, done);
      }
      if (onResolved) onResolved(action, decision, body);
    } catch (err) {
      setStatus(action.id, "failed", err.message);
    }
  };

  const dark = variant === "dark";

  const statusLabel = {
    confirming: "Confirming…",
    cancelling: "Cancelling…",
    confirmed: "✓ Done",
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
        const status = statusById[action.id];
        const settled = status === "confirmed" || status === "cancelled" || status === "failed";
        const busy = status === "confirming" || status === "cancelling";

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
              style={dark ? { color: D.text, fontSize: 14, fontWeight: 600, marginBottom: 6 } : undefined}
              className={dark ? undefined : "text-[14px] text-zinc-900 font-medium mb-1.5"}
            >
              {status === "confirmed" ? "✓ " : ""}Awaiting your confirmation: {action.tool}
            </div>

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

            {status === "failed" && (
              <div
                style={dark ? { fontSize: 14, color: D.red, marginBottom: 8 } : undefined}
                className={dark ? undefined : "text-[14px] text-alert-fg mb-2"}
              >
                {errorById[action.id]}
              </div>
            )}

            {!settled ? (
              <div style={dark ? { display: "flex", gap: 8 } : undefined} className={dark ? undefined : "flex gap-2"}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => decide(action, "confirm")}
                  style={dark ? {
                    background: D.green, color: D.white, border: "none", borderRadius: 8,
                    padding: "7px 16px", fontSize: 14, fontWeight: 600,
                    cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1,
                  } : undefined}
                  className={dark ? undefined : "bg-zinc-900 text-white rounded-sm px-4 py-1.5 text-[14px] font-medium disabled:opacity-60"}
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
                  className={dark ? undefined : "bg-white text-zinc-600 border border-zinc-300 rounded-sm px-4 py-1.5 text-[14px] disabled:opacity-60"}
                >
                  {status === "cancelling" ? statusLabel.cancelling : "Cancel"}
                </button>
              </div>
            ) : (
              <div
                style={dark ? {
                  fontSize: 14, fontWeight: 600,
                  color: status === "confirmed" ? D.green : status === "failed" ? D.red : D.muted,
                } : undefined}
                className={dark ? undefined : `text-[14px] font-medium ${
                  status === "confirmed" ? "text-zinc-900" : status === "failed" ? "text-alert-fg" : "text-zinc-500"
                }`}
              >
                {status === "failed" ? "Failed — see error above" : statusLabel[status]}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
