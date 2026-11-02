import { useState } from "react";
import { adminFetch } from "../../lib/adminFetch";

/**
 * "Sent another way" — records that a signed WDO report went out by some
 * route other than the portal (owner 2026-11-02), so the nightly WDO check
 * stops flagging it. Records only: it sends nothing to the customer.
 *
 * Shown only when the server says the project qualifies
 * (project.canMarkSentOutside: gate on, admin viewer, signed, no portal send,
 * not yet marked). Once marked, the saved date replaces the button.
 */
export const NOTE_MAX = 500;

function fmtMarkedDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

const BUTTON = {
  minHeight: 44,
  padding: "0 16px",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 500,
  background: "#FFFFFF",
  color: "#18181B",
  border: "1px solid #D4D4D8",
  cursor: "pointer",
};

export default function SentAnotherWayAction({ project, onMarked }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [markedAt, setMarkedAt] = useState(null);

  const savedAt = markedAt || project?.sent_outside_portal_at || null;
  if (savedAt) {
    const when = fmtMarkedDate(savedAt);
    return (
      <span data-testid="sent-another-way-done" style={{ fontSize: 13, color: "#3F3F46" }}>
        {when ? `Sent outside the portal on ${when}` : "Sent outside the portal"}
      </span>
    );
  }
  if (!project?.canMarkSentOutside) return null;

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const res = await adminFetch(`/admin/projects/${project.id}/mark-sent-outside`, {
        method: "POST",
        body: { note: note.trim() },
      });
      let payload = {};
      try { payload = await res.json(); } catch { payload = {}; }
      if (!res.ok) throw new Error(payload?.error || "Could not mark the report as sent another way");
      setMarkedAt(payload.sent_outside_portal_at || new Date().toISOString());
      setOpen(false);
      onMarked?.(payload);
    } catch (e) {
      setError(e.message || "Could not mark the report as sent another way");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} style={BUTTON}>
        Sent another way
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-label="Mark report as sent another way"
      style={{
        flexBasis: "100%",
        padding: 12,
        border: "1px solid #E4E4E7",
        borderRadius: 6,
        background: "#FAFAFA",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        textAlign: "left",
      }}
    >
      <div style={{ fontSize: 13, color: "#3F3F46", lineHeight: 1.45 }}>
        Mark this signed report as sent another way? This only records that you sent it yourself.
        Nothing goes to the customer, and the nightly check stops flagging this report.
      </div>
      <label htmlFor={`sent-another-way-note-${project.id}`} style={{ fontSize: 12, color: "#52525B" }}>
        Note (optional): how or to whom
      </label>
      <textarea
        id={`sent-another-way-note-${project.id}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={NOTE_MAX}
        rows={2}
        disabled={busy}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "8px 10px",
          border: "1px solid #D4D4D8",
          borderRadius: 4,
          fontSize: 14,
          fontFamily: "'Roboto', Arial, sans-serif",
          resize: "vertical",
        }}
      />
      {error && (
        <div role="alert" style={{ fontSize: 12, color: "#991B1B" }}>{error}</div>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={() => { setOpen(false); setError(""); }}
          disabled={busy}
          style={{ ...BUTTON, opacity: busy ? 0.5 : 1 }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          style={{ ...BUTTON, background: "#18181B", color: "#fff", border: "none", opacity: busy ? 0.5 : 1 }}
        >
          {busy ? "Saving…" : "Mark as sent"}
        </button>
      </div>
    </div>
  );
}
