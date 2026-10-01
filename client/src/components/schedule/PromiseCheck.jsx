import React from "react";

// The promise check on the completion form (owner "ok yes add these"
// 2026-10-01): the open promises Waves made this customer that a technician
// can keep at a visit (GET /admin/dispatch/:serviceId/promises), each marked
// Done, Partly or Not yet. The report says only what was marked; a blank
// changes nothing. Marking is never required to complete.

export const PROMISE_MARKS = [
  { value: "done", label: "Done" },
  { value: "partly", label: "Partly" },
  { value: "not_yet", label: "Not yet" },
];
export const STILL_LEFT_MAX = 200;

const SOURCE_LABELS = { call: "Phone call", text: "Text", email: "Email" };

// "Phone call · Sep 29"
export function promiseSourceLabel(promise) {
  const source = SOURCE_LABELS[promise?.source] || "Message";
  const made = promise?.madeAt ? new Date(promise.madeAt) : null;
  const day = made && !Number.isNaN(made.getTime())
    ? made.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })
    : null;
  return day ? `${source} · ${day}` : source;
}

// The request's marks: marked, listed promises only, each with the version
// of the wording the tech saw (the server drops a mark once the promise was
// reworded), a Partly with its note.
export function promiseMarksPayload(marks, promises) {
  const listed = new Map((Array.isArray(promises) ? promises : []).map((promise) => [promise.id, promise]));
  return Object.entries(marks || {})
    .filter(([id, entry]) => listed.get(id)?.version && PROMISE_MARKS.some((option) => option.value === entry?.mark))
    .map(([id, entry]) => {
      const stillLeft = entry.mark === "partly" ? String(entry.stillLeft || "").trim().slice(0, STILL_LEFT_MAX) : "";
      return { id, mark: entry.mark, version: listed.get(id).version, ...(stillLeft ? { stillLeft } : {}) };
    });
}

// "2 open", or "10 of 14 open" when the list shows only the newest.
export function promiseCountLabel(shown, total) {
  return Number(total) > shown ? `${shown} of ${total} open` : `${shown} open`;
}

// The marks as the form's staleness check compares them: valid marks in id
// order, whether or not the list has loaded (a restored draft's marks must
// not read as a change when the list arrives after the restore).
export function promiseMarksSignature(marks) {
  return Object.entries(marks || {})
    .filter(([, entry]) => PROMISE_MARKS.some((option) => option.value === entry?.mark))
    .map(([id, entry]) => [id, entry.mark, entry.mark === "partly" ? String(entry.stillLeft || "").trim() : ""])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const DEFAULT_TOKENS = {
  ink: "#111111",
  muted: "#737373",
  border: "#E5E5E5",
  card: "#FFFFFF",
  onInk: "#FFFFFF",
  font: "inherit",
};

export default function PromiseCheck({ promises, total = null, marks, onChange, disabled = false, tokens = {}, compact = false }) {
  const t = { ...DEFAULT_TOKENS, ...tokens };
  const list = Array.isArray(promises) ? promises : [];
  if (!list.length) return null;
  const setMark = (id, mark) => {
    const current = marks?.[id];
    const next = { ...(marks || {}) };
    // Tapping the chosen mark again clears it (left blank: no change).
    if (current?.mark === mark) delete next[id];
    else next[id] = { mark, stillLeft: current?.stillLeft || "" };
    onChange(next);
  };
  const setStillLeft = (id, stillLeft) => {
    onChange({ ...(marks || {}), [id]: { ...(marks?.[id] || { mark: "partly" }), stillLeft } });
  };
  const buttonHeight = compact ? 36 : 44;
  return (
    <section aria-label="Promises we made" style={{ margin: "4px 0 16px", fontFamily: t.font }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
        <span style={{ fontSize: compact ? 14 : 15, fontWeight: 500, color: t.ink }}>Promises we made</span>
        <span style={{ fontSize: 14, color: t.muted }}>{promiseCountLabel(list.length, total)}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {list.map((promise) => {
          const entry = marks?.[promise.id];
          return (
            <div
              key={promise.id}
              style={{ border: `1px solid ${t.border}`, borderRadius: 12, padding: "10px 12px", background: t.card }}
            >
              <div style={{ fontSize: compact ? 14 : 15, color: t.ink, lineHeight: 1.35 }}>{promise.description}</div>
              <div style={{ fontSize: 14, color: t.muted, marginTop: 3 }}>{promiseSourceLabel(promise)}</div>
              <div role="group" aria-label={`Mark: ${promise.description}`} style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                {PROMISE_MARKS.map((option) => {
                  const selected = entry?.mark === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled={disabled}
                      aria-pressed={selected}
                      onClick={() => setMark(promise.id, option.value)}
                      style={{
                        minHeight: buttonHeight,
                        padding: "0 14px",
                        borderRadius: 10,
                        background: selected ? t.ink : t.card,
                        color: selected ? t.onInk : t.ink,
                        border: `1px solid ${selected ? t.ink : t.border}`,
                        fontFamily: t.font,
                        fontSize: 14,
                        fontWeight: 500,
                        cursor: disabled ? "default" : "pointer",
                        opacity: disabled ? 0.55 : 1,
                      }}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              {entry?.mark === "partly" && (
                <label style={{ display: "block", marginTop: 8 }}>
                  <span style={{ display: "block", fontSize: 14, color: t.muted, marginBottom: 4 }}>What’s still left?</span>
                  <input
                    type="text"
                    value={entry.stillLeft || ""}
                    maxLength={STILL_LEFT_MAX}
                    disabled={disabled}
                    onChange={(event) => setStillLeft(promise.id, event.target.value)}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      minHeight: buttonHeight,
                      padding: "0 12px",
                      borderRadius: 10,
                      border: `1px solid ${t.border}`,
                      background: t.card,
                      color: t.ink,
                      fontFamily: t.font,
                      fontSize: 16,
                    }}
                  />
                </label>
              )}
            </div>
          );
        })}
      </div>
      <p style={{ fontSize: 14, color: t.muted, margin: "8px 0 0" }}>
        Promises left unmarked stay open and stay out of the report. Marking is never required to complete.
      </p>
    </section>
  );
}
